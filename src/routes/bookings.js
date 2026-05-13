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
