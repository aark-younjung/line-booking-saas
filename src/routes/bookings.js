import express from 'express';
import { supabase } from '../lib/supabase.js';
import { sendLinePush } from '../utils/line.js';
import { getTenantById } from '../middleware/tenant.js';

const router = express.Router();

/**
 * POST /api/bookings
 * 建立預約
 * Body: { tenantId, lineUid, courseId, slotId, customerName, customerPhone }
 */
router.post('/', async (req, res) => {
  const { tenantId, lineUid, courseId, slotId, customerName, customerPhone } = req.body;

  if (!tenantId || !lineUid || !courseId || !slotId) {
    return res.status(400).json({
      error: 'Missing required fields: tenantId, lineUid, courseId, slotId',
    });
  }

  try {
    // 0. 取得租戶資料（用於後續推播）
    const tenant = await getTenantById(tenantId);
    if (!tenant) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    // 1. 確保客戶記錄存在
    const { data: customer, error: customerError } = await supabase
      .from('customers')
      .upsert(
        {
          tenant_id: tenantId,
          line_uid: lineUid,
          display_name: customerName || '',
          name: customerName || '',
          phone: customerPhone || '',
        },
        { onConflict: 'tenant_id,line_uid' }
      )
      .select()
      .single();

    if (customerError) {
      throw customerError;
    }

    // 2. 檢查時段容量
    const { data: slot, error: slotError } = await supabase
      .from('time_slots')
      .select('*')
      .eq('id', slotId)
      .eq('tenant_id', tenantId)
      .single();

    if (slotError || !slot) {
      return res.status(404).json({
        error: 'Time slot not found',
      });
    }

    if (slot.booked_count >= slot.capacity) {
      return res.status(409).json({
        error: 'Time slot is full',
      });
    }

    // 3. 建立預約（狀態: pending_payment）
    const { data: booking, error: bookingError } = await supabase
      .from('bookings')
      .insert({
        tenant_id: tenantId,
        customer_id: customer.id,
        course_id: courseId,
        slot_id: slotId,
        status: 'pending_payment',
      })
      .select()
      .single();

    if (bookingError) {
      throw bookingError;
    }

    console.log(`[Bookings] Created booking: ${booking.id}`);

    // 4. 發送確認訊息給客戶
    const { data: course } = await supabase
      .from('courses')
      .select('name')
      .eq('id', courseId)
      .single();

    const message =
      `✅ 預約成功！\n` +
      `課程：${course?.name}\n` +
      `時間：${new Date(slot.start_at).toLocaleString('zh-TW')}\n` +
      `請填寫匯款資訊以完成預約。`;

    await sendLinePush(
      tenantId,
      tenant.line_access_token,
      lineUid,
      message,
      'booking_created',
      booking.id
    );

    // 5. 通知業主
    const ownerMessage =
      `📌 新預約\n` +
      `客戶：${customerName}\n` +
      `課程：${course?.name}\n` +
      `時間：${new Date(slot.start_at).toLocaleString('zh-TW')}\n` +
      `狀態：待匯款確認`;

    const { data: owner } = await supabase
      .from('owners')
      .select('line_uid')
      .eq('tenant_id', tenantId)
      .single();

    if (owner?.line_uid) {
      await sendLinePush(
        tenantId,
        tenant.line_access_token,
        owner.line_uid,
        ownerMessage,
        'booking_created',
        booking.id
      );
    }

    res.json({
      success: true,
      data: booking,
    });
  } catch (error) {
    console.error('[Bookings] Error creating booking:', error);
    res.status(500).json({
      error: 'Failed to create booking',
      details: error.message,
    });
  }
});

/**
 * POST /api/bookings/:id/payment
 * 提交匯款資訊（後五碼或截圖）
 * Body: { method, lastFiveDigits or screenshotUrl, amount }
 */
router.post('/:id/payment', async (req, res) => {
  const { id: bookingId } = req.params;
  const { tenantId } = req.body;
  const { method, lastFiveDigits, screenshotUrl, amount } = req.body;

  if (!tenantId || !method || (method === 'last_five' && !lastFiveDigits)) {
    return res.status(400).json({
      error: 'Missing required fields',
    });
  }

  try {
    // 0. 取得租戶資料
    const tenant = await getTenantById(tenantId);
    if (!tenant) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    // 1. 驗證預約存在且狀態為 pending_payment
    const { data: booking, error: bookingError } = await supabase
      .from('bookings')
      .select('*')
      .eq('id', bookingId)
      .eq('tenant_id', tenantId)
      .single();

    if (bookingError || !booking) {
      return res.status(404).json({
        error: 'Booking not found',
      });
    }

    if (booking.status !== 'pending_payment') {
      return res.status(409).json({
        error: `Booking is in ${booking.status} status, cannot accept payment`,
      });
    }

    // 2. 建立匯款確認記錄
    const { data: payment, error: paymentError } = await supabase
      .from('payment_confirmations')
      .insert({
        tenant_id: tenantId,
        booking_id: bookingId,
        method,
        last_five_digits: lastFiveDigits || null,
        screenshot_url: screenshotUrl || null,
        amount: amount || null,
      })
      .select()
      .single();

    if (paymentError) {
      throw paymentError;
    }

    // 3. 更新預約狀態為 pending_confirmation
    const { error: updateError } = await supabase
      .from('bookings')
      .update({ status: 'pending_confirmation' })
      .eq('id', bookingId);

    if (updateError) {
      throw updateError;
    }

    console.log(`[Bookings] Payment submitted for booking: ${bookingId}`);

    // 4. 通知業主有待確認的匯款
    const { data: customer } = await supabase
      .from('customers')
      .select('line_uid, name')
      .eq('id', booking.customer_id)
      .single();

    const { data: owner } = await supabase
      .from('owners')
      .select('line_uid')
      .eq('tenant_id', tenantId)
      .single();

    if (owner?.line_uid) {
      const ownerMsg =
        `💰 待確認匯款\n` +
        `客戶：${customer?.name}\n` +
        `方式：${method === 'last_five' ? '後五碼' : '截圖'}\n` +
        `金額：${amount || '(待填)'}`;

      await sendLinePush(
        tenantId,
        tenant.line_access_token,
        owner.line_uid,
        ownerMsg,
        'payment_received',
        bookingId
      );
    }

    res.json({
      success: true,
      data: payment,
    });
  } catch (error) {
    console.error('[Bookings] Error submitting payment:', error);
    res.status(500).json({
      error: 'Failed to submit payment',
      details: error.message,
    });
  }
});

/**
 * GET /api/bookings/customer/:lineUid
 * 客戶查詢自己的訂單（進階版功能）
 */
router.get('/customer/:lineUid', async (req, res) => {
  const { tenantId } = req.query;
  const { lineUid } = req.params;

  if (!tenantId) {
    return res.status(400).json({
      error: 'Missing tenantId in query',
    });
  }

  try {
    const { data: bookings, error } = await supabase
      .from('bookings')
      .select(
        `
        *,
        customer:customer_id(name, phone),
        course:course_id(name, price),
        slot:slot_id(start_at, end_at)
      `
      )
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false });

    if (error) {
      throw error;
    }

    // 篩選出該客戶的訂單（實際上應在前一步用 customer.line_uid 篩選，但 RLS 應會處理）
    const customerBookings = bookings.filter(
      (b) => b.customer.line_uid === lineUid
    );

    res.json({
      success: true,
      data: customerBookings,
    });
  } catch (error) {
    console.error('[Bookings] Error fetching customer bookings:', error);
    res.status(500).json({
      error: 'Failed to fetch bookings',
      details: error.message,
    });
  }
});

/**
 * GET /api/bookings/:tenantId
 * 業主查詢所有訂單（篩選選項）
 */
router.get('/:tenantId', async (req, res) => {
  const { tenantId } = req.params;
  const { status, courseId, limit = 50, offset = 0 } = req.query;

  try {
    let query = supabase
      .from('bookings')
      .select(
        `
        *,
        customer:customer_id(id, name, phone, line_uid),
        course:course_id(name),
        slot:slot_id(start_at)
      `
      )
      .eq('tenant_id', tenantId);

    if (status) {
      query = query.eq('status', status);
    }
    if (courseId) {
      query = query.eq('course_id', courseId);
    }

    const { data: bookings, error } = await query
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) {
      throw error;
    }

    res.json({
      success: true,
      data: bookings,
      pagination: { offset, limit },
    });
  } catch (error) {
    console.error('[Bookings] Error fetching bookings:', error);
    res.status(500).json({
      error: 'Failed to fetch bookings',
      details: error.message,
    });
  }
});

/**
 * PATCH /api/bookings/:id/confirm
 * 業主確認匯款
 */
/**
 * PATCH /api/bookings/:id/change-slot
 * 業主改時段（同課程的其他時段）+ 推播通知客戶
 * Body: { tenantId, newSlotId }
 */
router.patch('/:id/change-slot', async (req, res) => {
  const { id: bookingId } = req.params;
  const { tenantId, newSlotId } = req.body;

  if (!tenantId || !newSlotId) {
    return res.status(400).json({ error: 'Missing tenantId or newSlotId' });
  }

  try {
    const tenant = await getTenantById(tenantId);
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

    // 取得目前預約
    const { data: booking, error: bErr } = await supabase
      .from('bookings')
      .select('*, course:course_id(name), customer:customer_id(line_uid, name), old_slot:slot_id(start_at)')
      .eq('id', bookingId)
      .eq('tenant_id', tenantId)
      .single();

    if (bErr || !booking) return res.status(404).json({ error: 'Booking not found' });
    if (booking.status === 'cancelled') return res.status(409).json({ error: '預約已取消' });
    if (booking.slot_id === newSlotId) return res.status(400).json({ error: '與原時段相同' });

    // 取得新時段
    const { data: newSlot, error: sErr } = await supabase
      .from('time_slots')
      .select('*')
      .eq('id', newSlotId)
      .eq('tenant_id', tenantId)
      .single();

    if (sErr || !newSlot) return res.status(404).json({ error: 'New slot not found' });
    if (newSlot.course_id !== booking.course_id) {
      return res.status(400).json({ error: '只能改到同一個課程的時段' });
    }
    if (newSlot.booked_count >= newSlot.capacity) {
      return res.status(409).json({ error: '新時段已滿' });
    }

    // 更新 booking 的 slot_id
    const { error: updateErr } = await supabase
      .from('bookings')
      .update({ slot_id: newSlotId })
      .eq('id', bookingId);

    if (updateErr) throw updateErr;

    // 手動調整 booked_count（trigger 只處理 status 變化，不處理 slot 變化）
    await supabase
      .from('time_slots')
      .update({ booked_count: Math.max(0, (await getSlotBookedCount(booking.slot_id)) || 0) })
      .eq('id', booking.slot_id);

    await supabase
      .from('time_slots')
      .update({ booked_count: newSlot.booked_count + 1 })
      .eq('id', newSlotId);

    console.log(`[Bookings] Slot changed: ${bookingId} -> ${newSlotId}`);

    // 推播通知客戶
    if (booking.customer?.line_uid) {
      const oldTime = new Date(booking.old_slot.start_at).toLocaleString('zh-TW', {
        timeZone: 'Asia/Taipei',
        month: '2-digit', day: '2-digit', weekday: 'short',
        hour: '2-digit', minute: '2-digit'
      });
      const newTime = new Date(newSlot.start_at).toLocaleString('zh-TW', {
        timeZone: 'Asia/Taipei',
        month: '2-digit', day: '2-digit', weekday: 'short',
        hour: '2-digit', minute: '2-digit'
      });

      const msg =
        `⚠️ 課程時段變更通知\n\n` +
        `${booking.customer.name || ''} 您好，您預約的課程時段已調整：\n\n` +
        `📚 課程：${booking.course?.name}\n` +
        `❌ 原時段：${oldTime}\n` +
        `✅ 新時段：${newTime}\n\n` +
        `如有疑問請聯絡業主。`;

      await sendLinePush(
        tenantId,
        tenant.line_access_token,
        booking.customer.line_uid,
        msg,
        'slot_changed',
        bookingId
      );
    }

    res.json({ success: true, message: '時段已變更，已通知客戶' });
  } catch (error) {
    console.error('[Bookings] Error changing slot:', error);
    res.status(500).json({ error: 'Failed to change slot', details: error.message });
  }
});

// 計算某時段實際未取消的預約數
async function getSlotBookedCount(slotId) {
  const { count } = await supabase
    .from('bookings')
    .select('id', { count: 'exact', head: true })
    .eq('slot_id', slotId)
    .neq('status', 'cancelled');
  return count || 0;
}

router.patch('/:id/confirm', async (req, res) => {
  const { id: bookingId } = req.params;
  const { tenantId, ownerId } = req.body;

  try {
    // 取得租戶資料
    const tenant = await getTenantById(tenantId);
    if (!tenant) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    // 驗證預約
    const { data: booking, error: bookingError } = await supabase
      .from('bookings')
      .select('*')
      .eq('id', bookingId)
      .eq('tenant_id', tenantId)
      .single();

    if (bookingError || !booking) {
      return res.status(404).json({
        error: 'Booking not found',
      });
    }

    if (booking.status !== 'pending_confirmation') {
      return res.status(409).json({
        error: `Booking is in ${booking.status} status`,
      });
    }

    // 更新預約狀態為 confirmed
    const { error: updateError } = await supabase
      .from('bookings')
      .update({ status: 'confirmed' })
      .eq('id', bookingId);

    // 更新匯款確認記錄
    const { error: paymentUpdateError } = await supabase
      .from('payment_confirmations')
      .update({
        confirmed_at: new Date().toISOString(),
        confirmed_by: ownerId || null,
      })
      .eq('booking_id', bookingId);

    if (updateError || paymentUpdateError) {
      throw updateError || paymentUpdateError;
    }

    // 通知客戶
    const { data: customer } = await supabase
      .from('customers')
      .select('line_uid')
      .eq('id', booking.customer_id)
      .single();

    if (customer?.line_uid) {
      await sendLinePush(
        tenantId,
        tenant.line_access_token,
        customer.line_uid,
        '✅ 您的課程已確認！期待在課堂上見到您。',
        'confirmed',
        bookingId
      );
    }

    res.json({
      success: true,
      message: 'Booking confirmed',
    });
  } catch (error) {
    console.error('[Bookings] Error confirming booking:', error);
    res.status(500).json({
      error: 'Failed to confirm booking',
      details: error.message,
    });
  }
});

export default router;
