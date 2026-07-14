import express from 'express';
import { supabase } from '../lib/supabase.js';
import { sendLinePush } from '../utils/line.js';
import { getTenantById } from '../middleware/tenant.js';

const router = express.Router();

/**
 * POST /api/bookings/credit-enroll
 * 堂數制報名（報名付 N 堂的錢，之後每次自己約課）
 * Body: { tenantId, lineUid, courseId, customerName, customerPhone }
 */
router.post('/credit-enroll', async (req, res) => {
  const { tenantId, lineUid, courseId, customerName, customerPhone } = req.body;
  if (!tenantId || !lineUid || !courseId) return res.status(400).json({ error: 'Missing fields' });

  try {
    const tenant = await getTenantById(tenantId);
    const { data: course } = await supabase
      .from('courses').select('*').eq('id', courseId).eq('tenant_id', tenantId).single();
    if (!course) return res.status(404).json({ error: 'Course not found' });

    const { data: customer } = await supabase
      .from('customers')
      .upsert({ tenant_id: tenantId, line_uid: lineUid, display_name: customerName || '', name: customerName || '', phone: customerPhone || '' },
        { onConflict: 'tenant_id,line_uid' })
      .select().single();

    // 防止重複報名（已有未取消的同課程 credit 包）
    const { data: exist } = await supabase
      .from('booking_packages').select('id')
      .eq('customer_id', customer.id).eq('course_id', courseId).neq('status', 'cancelled').maybeSingle();
    if (exist) return res.status(409).json({ error: '您已報名此課程' });

    const sessions = course.package_sessions || 1;
    const totalPrice = course.price;  // 堂數制：price 即整期總費用（不乘堂數）

    const { data: pkg, error } = await supabase
      .from('booking_packages')
      .insert({ tenant_id: tenantId, customer_id: customer.id, course_id: courseId, status: 'pending_payment', total_price: totalPrice, sessions, remaining: null })
      .select().single();
    if (error) throw error;

    let msg =
      `✅ 報名成功！\n\n📚 ${course.name}（共 ${sessions} 堂）\n💰 應繳費用：NT$${totalPrice.toLocaleString()}\n` +
      `請於 ${course.payment_days || 3} 日內完成匯款並回傳後五碼。\n確認後即可自行預約每堂上課日期。`;
    if (course.notice) msg += `\n\n📋 報名注意事項：\n${course.notice}`;
    await sendLinePush(tenantId, tenant.line_access_token, lineUid, msg, 'booking_created', null);

    const { data: owner } = await supabase.from('owners').select('line_uid').eq('tenant_id', tenantId).single();
    if (owner?.line_uid) {
      await sendLinePush(tenantId, tenant.line_access_token, owner.line_uid,
        `📌 新堂數制報名\n客戶：${customerName}\n課程：${course.name}（${sessions} 堂）\n金額：NT$${totalPrice.toLocaleString()}`,
        'booking_created', null);
    }

    res.json({ success: true, data: { package_id: pkg.id, total_price: totalPrice } });
  } catch (error) {
    console.error('[Bookings] credit-enroll:', error);
    res.status(500).json({ error: 'Failed', details: error.message });
  }
});

/**
 * POST /api/bookings/credit-book
 * 堂數制：用剩餘堂數預約一堂課
 * Body: { tenantId, lineUid, courseId, slotId }
 */
router.post('/credit-book', async (req, res) => {
  const { tenantId, lineUid, courseId, slotId } = req.body;
  if (!tenantId || !lineUid || !courseId || !slotId) return res.status(400).json({ error: 'Missing fields' });

  try {
    const tenant = await getTenantById(tenantId);
    const { data: customer } = await supabase
      .from('customers').select('id, name').eq('tenant_id', tenantId).eq('line_uid', lineUid).maybeSingle();
    if (!customer) return res.status(404).json({ error: '找不到報名資料' });

    // 找此課程已確認、還有剩餘堂數的包
    const { data: pkg } = await supabase
      .from('booking_packages').select('*')
      .eq('customer_id', customer.id).eq('course_id', courseId).eq('status', 'confirmed')
      .gt('remaining', 0).order('created_at', { ascending: true }).limit(1).maybeSingle();
    if (!pkg) return res.status(409).json({ error: '沒有可用的剩餘堂數' });

    // 檢查時段
    const { data: slot } = await supabase
      .from('time_slots').select('*').eq('id', slotId).eq('tenant_id', tenantId).single();
    if (!slot) return res.status(404).json({ error: '時段不存在' });
    if (slot.course_id !== courseId) return res.status(400).json({ error: '時段不屬於此課程' });
    if (new Date(slot.start_at) <= new Date()) return res.status(400).json({ error: '不能預約過去的時段' });
    if (slot.booked_count >= slot.capacity) return res.status(409).json({ error: '此時段已額滿' });

    // 建立預約（confirmed，扣一堂）
    const { data: booking, error: bErr } = await supabase
      .from('bookings')
      .insert({ tenant_id: tenantId, customer_id: customer.id, course_id: courseId, slot_id: slotId, status: 'confirmed', package_id: pkg.id, used_credit: true })
      .select().single();
    if (bErr) throw bErr;

    await supabase.from('booking_packages').update({ remaining: pkg.remaining - 1 }).eq('id', pkg.id);

    const { data: course } = await supabase.from('courses').select('name').eq('id', courseId).single();
    await sendLinePush(tenantId, tenant.line_access_token, lineUid,
      `✅ 預約成功！\n課程：${course?.name}\n時間：${new Date(slot.start_at).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}\n剩餘 ${pkg.remaining - 1} 堂`,
      'booking_created', booking.id);

    res.json({ success: true, remaining: pkg.remaining - 1 });
  } catch (error) {
    console.error('[Bookings] credit-book:', error);
    res.status(500).json({ error: 'Failed', details: error.message });
  }
});

/**
 * GET /api/bookings/my
 * 學生查詢自己的課程包預約（LIFF 我的預約頁）
 * Query: tenantId, lineUid
 */
router.get('/my', async (req, res) => {
  const { tenantId, lineUid } = req.query;
  if (!tenantId || !lineUid) return res.status(400).json({ error: 'Missing params' });

  try {
    // 找客戶
    const { data: customer } = await supabase
      .from('customers')
      .select('id')
      .eq('tenant_id', tenantId)
      .eq('line_uid', lineUid)
      .maybeSingle();

    if (!customer) return res.json({ success: true, data: [] });

    // 取得課程包
    const { data: pkgs } = await supabase
      .from('booking_packages')
      .select('*, course:course_id(name, free_changes, lock_days, package_sessions, course_type, price, installment_1, payment_note, image_url)')
      .eq('tenant_id', tenantId)
      .eq('customer_id', customer.id)
      .neq('status', 'cancelled')
      .order('created_at', { ascending: false });

    // 各包附上 bookings（含時段）
    const result = await Promise.all((pkgs || []).map(async (pkg) => {
      const { data: bks } = await supabase
        .from('bookings')
        .select('id, status, slot:slot_id(id, start_at, end_at)')
        .eq('package_id', pkg.id)
        .neq('status', 'cancelled')
        .order('created_at', { ascending: true });

      const bookings = (bks || [])
        .filter(b => b.slot)
        .sort((a, b) => new Date(a.slot.start_at) - new Date(b.slot.start_at));

      return { ...pkg, bookings };
    }));

    res.json({ success: true, data: result });
  } catch (error) {
    console.error('[Bookings] Error fetching my bookings:', error);
    res.status(500).json({ error: 'Failed', details: error.message });
  }
});

/**
 * PATCH /api/bookings/:id/reschedule
 * 學生自助改期（課程包）
 * Body: { tenantId, lineUid, newSlotId }
 * 規則：開課前 lock_days 天以上才能改、每期限 free_changes 次
 */
router.patch('/:id/reschedule', async (req, res) => {
  const { id: bookingId } = req.params;
  const { tenantId, lineUid, newSlotId } = req.body;
  if (!tenantId || !lineUid || !newSlotId) return res.status(400).json({ error: 'Missing params' });

  try {
    const tenant = await getTenantById(tenantId);

    // 取得預約 + 驗證歸屬
    const { data: booking } = await supabase
      .from('bookings')
      .select('*, customer:customer_id(line_uid, name), course:course_id(name, lock_days, free_changes), old_slot:slot_id(start_at), package:package_id(id, change_count)')
      .eq('id', bookingId)
      .eq('tenant_id', tenantId)
      .single();

    if (!booking) return res.status(404).json({ error: '找不到預約' });
    if (booking.customer?.line_uid !== lineUid) return res.status(403).json({ error: '無權限' });
    if (!booking.package_id) return res.status(400).json({ error: '單堂課不開放改期' });
    if (booking.status === 'cancelled') return res.status(409).json({ error: '預約已取消' });

    const lockDays = booking.course?.lock_days ?? 3;
    const freeChanges = booking.course?.free_changes ?? 2;

    // 檢查鎖定（開課前 lockDays 天內不能改）
    const hoursUntil = (new Date(booking.old_slot.start_at).getTime() - Date.now()) / (1000 * 60 * 60);
    if (hoursUntil < lockDays * 24) {
      return res.status(409).json({ error: `開課前 ${lockDays} 天內無法改期` });
    }

    // 檢查改期次數
    const used = booking.package?.change_count || 0;
    if (used >= freeChanges) {
      return res.status(409).json({ error: `已用完 ${freeChanges} 次免費改期，請聯絡業主` });
    }

    // 取得新時段
    const { data: newSlot } = await supabase
      .from('time_slots')
      .select('*')
      .eq('id', newSlotId)
      .eq('tenant_id', tenantId)
      .single();

    if (!newSlot) return res.status(404).json({ error: '新時段不存在' });
    if (newSlot.course_id !== booking.course_id) return res.status(400).json({ error: '只能改到同課程的時段' });
    if (new Date(newSlot.start_at) <= new Date()) return res.status(400).json({ error: '不能選過去的時段' });
    if (newSlot.booked_count >= newSlot.capacity) return res.status(409).json({ error: '新時段已額滿' });

    const oldSlotId = booking.slot_id;

    // 更新預約時段
    await supabase.from('bookings').update({ slot_id: newSlotId }).eq('id', bookingId);

    // 調整 booked_count：舊 -1、新 +1
    await supabase.from('time_slots').update({ booked_count: Math.max(0, (await countSlot(oldSlotId)) ) }).eq('id', oldSlotId);
    await supabase.from('time_slots').update({ booked_count: newSlot.booked_count + 1 }).eq('id', newSlotId);

    // 改期次數 +1
    await supabase.from('booking_packages')
      .update({ change_count: used + 1 })
      .eq('id', booking.package_id);

    console.log(`[Bookings] Rescheduled ${bookingId}: ${oldSlotId} -> ${newSlotId}`);

    // 通知業主
    const { data: owner } = await supabase.from('owners').select('line_uid').eq('tenant_id', tenantId).single();
    if (owner?.line_uid) {
      const oldT = new Date(booking.old_slot.start_at).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
      const newT = new Date(newSlot.start_at).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
      await sendLinePush(
        tenantId, tenant.line_access_token, owner.line_uid,
        `🔄 學生改期\n客戶：${booking.customer?.name}\n課程：${booking.course?.name}\n${oldT} → ${newT}\n（第 ${used + 1}/${freeChanges} 次）`,
        'slot_changed', bookingId
      );
    }

    res.json({ success: true, remaining: freeChanges - used - 1 });
  } catch (error) {
    console.error('[Bookings] Error rescheduling:', error);
    res.status(500).json({ error: 'Failed', details: error.message });
  }
});

// 計算時段實際未取消預約數
async function countSlot(slotId) {
  const { count } = await supabase
    .from('bookings')
    .select('id', { count: 'exact', head: true })
    .eq('slot_id', slotId)
    .neq('status', 'cancelled');
  return count || 0;
}

/**
 * POST /api/bookings/package
 * 建立課程包預約（一期 N 堂，一次選 N 個時段，一次付清）
 * Body: { tenantId, lineUid, courseId, slotIds: [], customerName, customerPhone }
 */
router.post('/package', async (req, res) => {
  const { tenantId, lineUid, courseId, slotIds, customerName, customerPhone } = req.body;

  if (!tenantId || !lineUid || !courseId || !Array.isArray(slotIds) || slotIds.length === 0) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const tenant = await getTenantById(tenantId);
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

    // 取得課程
    const { data: course, error: courseErr } = await supabase
      .from('courses')
      .select('*')
      .eq('id', courseId)
      .eq('tenant_id', tenantId)
      .single();

    if (courseErr || !course) return res.status(404).json({ error: 'Course not found' });

    // 驗證堂數
    if (slotIds.length !== course.package_sessions) {
      return res.status(400).json({ error: `此課程需選擇 ${course.package_sessions} 個時段` });
    }

    // 不可重複選同一時段
    if (new Set(slotIds).size !== slotIds.length) {
      return res.status(400).json({ error: '不能選擇重複的時段' });
    }

    // 確保客戶存在
    const { data: customer, error: custErr } = await supabase
      .from('customers')
      .upsert(
        { tenant_id: tenantId, line_uid: lineUid, display_name: customerName || '', name: customerName || '', phone: customerPhone || '' },
        { onConflict: 'tenant_id,line_uid' }
      )
      .select()
      .single();
    if (custErr) throw custErr;

    // 檢查每個時段容量
    const { data: slots, error: slotsErr } = await supabase
      .from('time_slots')
      .select('*')
      .in('id', slotIds)
      .eq('tenant_id', tenantId);
    if (slotsErr) throw slotsErr;

    if (slots.length !== slotIds.length) {
      return res.status(404).json({ error: '部分時段不存在' });
    }
    for (const s of slots) {
      if (s.booked_count >= s.capacity) {
        return res.status(409).json({ error: '部分時段已額滿，請重新選擇' });
      }
    }

    // 建立 package
    const totalPrice = course.price * course.package_sessions;
    const { data: pkg, error: pkgErr } = await supabase
      .from('booking_packages')
      .insert({
        tenant_id: tenantId,
        customer_id: customer.id,
        course_id: courseId,
        status: 'pending_payment',
        total_price: totalPrice,
        sessions: course.package_sessions,
      })
      .select()
      .single();
    if (pkgErr) throw pkgErr;

    // 建立 N 筆 bookings（避免 trigger 重複加 booked_count，先用 cancelled 再... 不，直接 insert pending）
    const bookingRows = slotIds.map(slotId => ({
      tenant_id: tenantId,
      customer_id: customer.id,
      course_id: courseId,
      slot_id: slotId,
      status: 'pending_payment',
      package_id: pkg.id,
    }));

    const { error: bErr } = await supabase.from('bookings').insert(bookingRows);
    if (bErr) throw bErr;

    console.log(`[Bookings] Package created: ${pkg.id} (${slotIds.length} sessions)`);

    // 推播：報名成功 + 注意事項 + 匯款說明
    const slotTimes = slots
      .sort((a, b) => new Date(a.start_at) - new Date(b.start_at))
      .map(s => `　• ${new Date(s.start_at).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit' })}`)
      .join('\n');

    let msg =
      `✅ 報名成功！\n\n` +
      `📚 ${course.name}（共 ${course.package_sessions} 堂）\n` +
      `您預約的上課日期：\n${slotTimes}\n\n` +
      `💰 應繳費用：NT$${totalPrice.toLocaleString()}\n` +
      `請於 ${course.payment_days} 日內完成匯款，並回傳後五碼。\n` +
      `（逾期未匯款，名額將自動釋出）`;

    if (course.notice) {
      msg += `\n\n📋 報名注意事項：\n${course.notice}`;
    }

    await sendLinePush(tenantId, tenant.line_access_token, lineUid, msg, 'booking_created', null);

    // 通知業主
    const { data: owner } = await supabase
      .from('owners').select('line_uid').eq('tenant_id', tenantId).single();
    if (owner?.line_uid) {
      await sendLinePush(
        tenantId, tenant.line_access_token, owner.line_uid,
        `📌 新課程包報名\n客戶：${customerName}\n課程：${course.name}（${course.package_sessions} 堂）\n金額：NT$${totalPrice.toLocaleString()}\n狀態：待匯款`,
        'booking_created', null
      );
    }

    res.json({ success: true, data: { package_id: pkg.id, total_price: totalPrice } });
  } catch (error) {
    console.error('[Bookings] Error creating package:', error);
    res.status(500).json({ error: 'Failed to create package', details: error.message });
  }
});

/**
 * POST /api/bookings/package/:id/payment
 * 課程包提交匯款
 * Body: { tenantId, method, lastFiveDigits, amount }
 */
router.post('/package/:id/payment', async (req, res) => {
  const { id: packageId } = req.params;
  const { tenantId, method, lastFiveDigits, amount } = req.body;

  if (!tenantId || !method) return res.status(400).json({ error: 'Missing fields' });

  try {
    const tenant = await getTenantById(tenantId);
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

    const { data: pkg, error: pkgErr } = await supabase
      .from('booking_packages')
      .select('*, customer:customer_id(name)')
      .eq('id', packageId)
      .eq('tenant_id', tenantId)
      .single();
    if (pkgErr || !pkg) return res.status(404).json({ error: 'Package not found' });
    if (pkg.status !== 'pending_payment') {
      return res.status(409).json({ error: `此報名狀態為 ${pkg.status}` });
    }

    // 建立匯款記錄
    await supabase.from('payment_confirmations').insert({
      tenant_id: tenantId,
      booking_id: null,
      package_id: packageId,
      method,
      last_five_digits: lastFiveDigits || null,
      amount: amount || pkg.total_price,
    });

    // 更新 package + 所有 bookings 狀態
    await supabase.from('booking_packages').update({ status: 'pending_confirmation' }).eq('id', packageId);
    await supabase.from('bookings').update({ status: 'pending_confirmation' }).eq('package_id', packageId);

    // 通知業主
    const { data: owner } = await supabase
      .from('owners').select('line_uid').eq('tenant_id', tenantId).single();
    if (owner?.line_uid) {
      await sendLinePush(
        tenantId, tenant.line_access_token, owner.line_uid,
        `💰 課程包待確認匯款\n客戶：${pkg.customer?.name}\n後五碼：${lastFiveDigits || '(截圖)'}\n金額：${amount || pkg.total_price}`,
        'payment_received', null
      );
    }

    res.json({ success: true });
  } catch (error) {
    console.error('[Bookings] Error package payment:', error);
    res.status(500).json({ error: 'Failed', details: error.message });
  }
});

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

    // 判斷會員：如果客戶有剩餘堂數 → 用會員身份預約（直接 confirmed，不用付款）
    const useCredit = customer.credits > 0;
    const status = useCredit ? 'confirmed' : 'pending_payment';

    // 3. 建立預約
    const { data: booking, error: bookingError } = await supabase
      .from('bookings')
      .insert({
        tenant_id: tenantId,
        customer_id: customer.id,
        course_id: courseId,
        slot_id: slotId,
        status,
        used_credit: useCredit,
      })
      .select()
      .single();

    if (bookingError) {
      throw bookingError;
    }

    console.log(`[Bookings] Created booking: ${booking.id} (credit: ${useCredit})`);

    // 扣會員堂數
    if (useCredit) {
      await supabase
        .from('customers')
        .update({ credits: customer.credits - 1 })
        .eq('id', customer.id);
    }

    // 4. 發送確認訊息給客戶
    const { data: course } = await supabase
      .from('courses')
      .select('name')
      .eq('id', courseId)
      .single();

    const message = useCredit
      ? `✅ 預約成功！\n` +
        `課程：${course?.name}\n` +
        `時間：${new Date(slot.start_at).toLocaleString('zh-TW')}\n` +
        `已使用會員 1 堂 · 剩餘 ${customer.credits - 1} 堂`
      : `✅ 預約成功！\n` +
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
    const ownerMessage = useCredit
      ? `📌 會員預約\n` +
        `客戶：${customerName}（${customer.membership_label || '會員'}）\n` +
        `課程：${course?.name}\n` +
        `時間：${new Date(slot.start_at).toLocaleString('zh-TW')}\n` +
        `剩餘 ${customer.credits - 1} 堂`
      : `📌 新預約\n` +
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
