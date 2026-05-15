import express from 'express';
import { supabase } from '../lib/supabase.js';

const router = express.Router();

/**
 * POST /api/admin/login
 * 業主登入
 * Body: { tenantId, email, password }
 *
 * ⚠️ 簡易版：目前不驗證 password hash（Phase 1 早期）
 * 之後改用 bcrypt + JWT
 */
router.post('/login', async (req, res) => {
  const { tenantId, email, password } = req.body;

  if (!tenantId || !email) {
    return res.status(400).json({
      error: 'Missing tenantId or email',
    });
  }

  try {
    const { data: owner, error } = await supabase
      .from('owners')
      .select('id, tenant_id, email, name, line_uid')
      .eq('tenant_id', tenantId)
      .eq('email', email)
      .single();

    if (error || !owner) {
      return res.status(401).json({ error: '帳號或密碼錯誤' });
    }

    if (!password) {
      return res.status(400).json({ error: '請輸入密碼' });
    }

    console.log(`[Admin] Owner login: ${owner.email}`);

    res.json({ success: true, data: owner });
  } catch (error) {
    console.error('[Admin] Login error:', error);
    res.status(500).json({ error: '登入失敗', details: error.message });
  }
});

/**
 * GET /api/admin/bookings/:id/payment
 * 查詢單一預約的匯款資訊
 */
router.get('/bookings/:id/payment', async (req, res) => {
  const { id: bookingId } = req.params;
  const { tenantId } = req.query;

  if (!tenantId) return res.status(400).json({ error: 'Missing tenantId' });

  try {
    const { data: payment, error } = await supabase
      .from('payment_confirmations')
      .select('*')
      .eq('booking_id', bookingId)
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (error || !payment) {
      return res.status(404).json({ error: 'Payment info not found' });
    }

    res.json({ success: true, data: payment });
  } catch (error) {
    console.error('[Admin] Error fetching payment info:', error);
    res.status(500).json({ error: 'Failed to fetch payment info', details: error.message });
  }
});

// ============================================================
// 課程管理 CRUD
// ============================================================

/**
 * POST /api/admin/courses
 * 新增課程
 * Body: { tenantId, name, description, price, capacity, duration_min, image_url }
 */
router.post('/courses', async (req, res) => {
  const { tenantId, name, description, price, capacity, duration_min, image_url, sort_order } = req.body;

  if (!tenantId || !name || price === undefined) {
    return res.status(400).json({ error: 'Missing required fields: tenantId, name, price' });
  }

  try {
    const { data: course, error } = await supabase
      .from('courses')
      .insert({
        tenant_id: tenantId,
        name,
        description: description || null,
        price: parseInt(price, 10),
        capacity: parseInt(capacity, 10) || 10,
        duration_min: parseInt(duration_min, 10) || 60,
        image_url: image_url || null,
        sort_order: parseInt(sort_order, 10) || 0,
        is_active: true,
      })
      .select()
      .single();

    if (error) throw error;

    console.log(`[Admin] Course created: ${course.id} (${course.name})`);
    res.json({ success: true, data: course });
  } catch (error) {
    console.error('[Admin] Error creating course:', error);
    res.status(500).json({ error: 'Failed to create course', details: error.message });
  }
});

/**
 * PATCH /api/admin/courses/:id
 * 編輯課程
 */
router.patch('/courses/:id', async (req, res) => {
  const { id } = req.params;
  const { tenantId, name, description, price, capacity, duration_min, image_url, is_active, sort_order } = req.body;

  if (!tenantId) return res.status(400).json({ error: 'Missing tenantId' });

  try {
    const updates = {};
    if (name !== undefined) updates.name = name;
    if (description !== undefined) updates.description = description;
    if (price !== undefined) updates.price = parseInt(price, 10);
    if (capacity !== undefined) updates.capacity = parseInt(capacity, 10);
    if (duration_min !== undefined) updates.duration_min = parseInt(duration_min, 10);
    if (image_url !== undefined) updates.image_url = image_url;
    if (is_active !== undefined) updates.is_active = is_active;
    if (sort_order !== undefined) updates.sort_order = parseInt(sort_order, 10);

    const { data: course, error } = await supabase
      .from('courses')
      .update(updates)
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .select()
      .single();

    if (error) throw error;
    if (!course) return res.status(404).json({ error: 'Course not found' });

    console.log(`[Admin] Course updated: ${id}`);
    res.json({ success: true, data: course });
  } catch (error) {
    console.error('[Admin] Error updating course:', error);
    res.status(500).json({ error: 'Failed to update course', details: error.message });
  }
});

/**
 * DELETE /api/admin/courses/:id
 * 刪除課程（如果有預約則改為停用）
 */
router.delete('/courses/:id', async (req, res) => {
  const { id } = req.params;
  const { tenantId } = req.query;

  if (!tenantId) return res.status(400).json({ error: 'Missing tenantId' });

  try {
    // 檢查是否有相關預約
    const { count } = await supabase
      .from('bookings')
      .select('id', { count: 'exact', head: true })
      .eq('course_id', id)
      .eq('tenant_id', tenantId);

    if (count && count > 0) {
      // 有預約，改為停用
      const { error: updateError } = await supabase
        .from('courses')
        .update({ is_active: false })
        .eq('id', id)
        .eq('tenant_id', tenantId);

      if (updateError) throw updateError;

      console.log(`[Admin] Course deactivated (has ${count} bookings): ${id}`);
      return res.json({
        success: true,
        message: `課程已停用（因有 ${count} 筆預約紀錄，無法刪除）`,
        deactivated: true,
      });
    }

    // 無預約，可以刪除
    const { error } = await supabase
      .from('courses')
      .delete()
      .eq('id', id)
      .eq('tenant_id', tenantId);

    if (error) throw error;

    console.log(`[Admin] Course deleted: ${id}`);
    res.json({ success: true, message: '課程已刪除', deleted: true });
  } catch (error) {
    console.error('[Admin] Error deleting course:', error);
    res.status(500).json({ error: 'Failed to delete course', details: error.message });
  }
});

// ============================================================
// 時段管理 CRUD
// ============================================================

/**
 * GET /api/admin/slots
 * 查詢所有時段（業主後台用）
 * Query: tenantId, courseId (optional), from (date), to (date)
 */
router.get('/slots', async (req, res) => {
  const { tenantId, courseId, from, to } = req.query;

  if (!tenantId) return res.status(400).json({ error: 'Missing tenantId' });

  try {
    let query = supabase
      .from('time_slots')
      .select(`
        *,
        course:course_id(id, name, price)
      `)
      .eq('tenant_id', tenantId);

    if (courseId) query = query.eq('course_id', courseId);
    if (from) query = query.gte('start_at', `${from}T00:00:00Z`);
    if (to) query = query.lte('start_at', `${to}T23:59:59Z`);

    const { data: slots, error } = await query.order('start_at', { ascending: true });

    if (error) throw error;

    res.json({ success: true, data: slots });
  } catch (error) {
    console.error('[Admin] Error fetching slots:', error);
    res.status(500).json({ error: 'Failed to fetch slots', details: error.message });
  }
});

/**
 * POST /api/admin/slots
 * 新增單一時段
 * Body: { tenantId, courseId, start_at, end_at, capacity }
 */
router.post('/slots', async (req, res) => {
  const { tenantId, courseId, start_at, end_at, capacity, initial_booked } = req.body;

  if (!tenantId || !courseId || !start_at || !end_at) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const cap = parseInt(capacity, 10) || 10;
    const initial = parseInt(initial_booked, 10) || 0;

    if (initial > cap) {
      return res.status(400).json({ error: '起始已預約人數不能超過容量' });
    }

    const { data: slot, error } = await supabase
      .from('time_slots')
      .insert({
        tenant_id: tenantId,
        course_id: courseId,
        start_at,
        end_at,
        capacity: cap,
        booked_count: initial,
        is_active: true,
      })
      .select()
      .single();

    if (error) throw error;

    console.log(`[Admin] Slot created: ${slot.id}`);
    res.json({ success: true, data: slot });
  } catch (error) {
    console.error('[Admin] Error creating slot:', error);
    res.status(500).json({ error: 'Failed to create slot', details: error.message });
  }
});

/**
 * PATCH /api/admin/slots/:id
 * 編輯時段（容量、起始預約人數、時間）
 */
router.patch('/slots/:id', async (req, res) => {
  const { id } = req.params;
  const { tenantId, capacity, booked_count, start_at, end_at, is_active } = req.body;

  if (!tenantId) return res.status(400).json({ error: 'Missing tenantId' });

  try {
    // 先取得目前資料以驗證
    const { data: current, error: fetchErr } = await supabase
      .from('time_slots')
      .select('*')
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .single();

    if (fetchErr || !current) {
      return res.status(404).json({ error: 'Slot not found' });
    }

    // 計算實際已被預約的人數（從 bookings 表查 non-cancelled）
    const { count: realBookings } = await supabase
      .from('bookings')
      .select('id', { count: 'exact', head: true })
      .eq('slot_id', id)
      .neq('status', 'cancelled');

    const updates = {};
    if (start_at !== undefined) updates.start_at = start_at;
    if (end_at !== undefined) updates.end_at = end_at;
    if (is_active !== undefined) updates.is_active = is_active;

    if (capacity !== undefined) {
      const newCap = parseInt(capacity, 10);
      if (newCap < realBookings) {
        return res.status(400).json({
          error: `容量不能小於實際預約人數 (${realBookings})`,
        });
      }
      updates.capacity = newCap;
    }

    if (booked_count !== undefined) {
      const newCount = parseInt(booked_count, 10);
      if (newCount < realBookings) {
        return res.status(400).json({
          error: `已預約人數不能小於實際預約人數 (${realBookings})`,
        });
      }
      const cap = updates.capacity || current.capacity;
      if (newCount > cap) {
        return res.status(400).json({ error: '已預約人數不能超過容量' });
      }
      updates.booked_count = newCount;
    }

    const { data: slot, error } = await supabase
      .from('time_slots')
      .update(updates)
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .select()
      .single();

    if (error) throw error;

    console.log(`[Admin] Slot updated: ${id}`);
    res.json({ success: true, data: slot });
  } catch (error) {
    console.error('[Admin] Error updating slot:', error);
    res.status(500).json({ error: 'Failed to update slot', details: error.message });
  }
});

/**
 * GET /api/admin/slots/:id/customers
 * 取得某時段的預約客戶名單
 */
router.get('/slots/:id/customers', async (req, res) => {
  const { id } = req.params;
  const { tenantId } = req.query;

  if (!tenantId) return res.status(400).json({ error: 'Missing tenantId' });

  try {
    const { data: bookings, error } = await supabase
      .from('bookings')
      .select(`
        id,
        status,
        created_at,
        customer:customer_id(id, name, phone, line_uid, display_name)
      `)
      .eq('slot_id', id)
      .eq('tenant_id', tenantId)
      .neq('status', 'cancelled')
      .order('created_at', { ascending: true });

    if (error) throw error;

    res.json({ success: true, data: bookings });
  } catch (error) {
    console.error('[Admin] Error fetching slot customers:', error);
    res.status(500).json({ error: 'Failed to fetch customers', details: error.message });
  }
});

/**
 * GET /api/admin/customer/profile
 * 取得客戶個人資料（LIFF 用）
 * Query: tenantId, lineUid
 */
router.get('/customer/profile', async (req, res) => {
  const { tenantId, lineUid } = req.query;

  if (!tenantId || !lineUid) {
    return res.status(400).json({ error: 'Missing tenantId or lineUid' });
  }

  try {
    const { data, error } = await supabase
      .from('customers')
      .select('id, line_uid, display_name, name, phone')
      .eq('tenant_id', tenantId)
      .eq('line_uid', lineUid)
      .maybeSingle();

    if (error) throw error;

    res.json({ success: true, data: data || null });
  } catch (error) {
    console.error('[Admin] Error fetching customer profile:', error);
    res.status(500).json({ error: 'Failed to fetch profile', details: error.message });
  }
});

/**
 * POST /api/admin/customer/profile
 * 更新客戶個人資料（LIFF 用）
 * Body: { tenantId, lineUid, name, phone, displayName }
 */
router.post('/customer/profile', async (req, res) => {
  const { tenantId, lineUid, name, phone, displayName } = req.body;

  if (!tenantId || !lineUid) {
    return res.status(400).json({ error: 'Missing tenantId or lineUid' });
  }

  try {
    const { data, error } = await supabase
      .from('customers')
      .upsert(
        {
          tenant_id: tenantId,
          line_uid: lineUid,
          name: name || null,
          phone: phone || null,
          display_name: displayName || null,
        },
        { onConflict: 'tenant_id,line_uid' }
      )
      .select()
      .single();

    if (error) throw error;

    console.log(`[Admin] Customer profile updated: ${lineUid}`);
    res.json({ success: true, data });
  } catch (error) {
    console.error('[Admin] Error updating customer profile:', error);
    res.status(500).json({ error: 'Failed to update profile', details: error.message });
  }
});

/**
 * POST /api/admin/slots/batch
 * 批量新增時段（連續週次）
 * Body: { tenantId, courseId, start_at, end_at, capacity, weeks }
 * weeks: 連續多少週（每週同一時間建立一筆）
 */
router.post('/slots/batch', async (req, res) => {
  const { tenantId, courseId, start_at, end_at, capacity, weeks } = req.body;

  if (!tenantId || !courseId || !start_at || !end_at || !weeks) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const slots = [];
    const baseStart = new Date(start_at);
    const baseEnd = new Date(end_at);

    for (let i = 0; i < parseInt(weeks, 10); i++) {
      const start = new Date(baseStart);
      start.setDate(start.getDate() + i * 7);
      const end = new Date(baseEnd);
      end.setDate(end.getDate() + i * 7);

      slots.push({
        tenant_id: tenantId,
        course_id: courseId,
        start_at: start.toISOString(),
        end_at: end.toISOString(),
        capacity: parseInt(capacity, 10) || 10,
        booked_count: 0,
        is_active: true,
      });
    }

    const { data, error } = await supabase
      .from('time_slots')
      .insert(slots)
      .select();

    if (error) throw error;

    console.log(`[Admin] Batch created ${data.length} slots`);
    res.json({ success: true, data, count: data.length });
  } catch (error) {
    console.error('[Admin] Error batch creating slots:', error);
    res.status(500).json({ error: 'Failed to batch create slots', details: error.message });
  }
});

/**
 * DELETE /api/admin/slots/:id
 * 刪除時段（如果有預約則拒絕）
 */
router.delete('/slots/:id', async (req, res) => {
  const { id } = req.params;
  const { tenantId } = req.query;

  if (!tenantId) return res.status(400).json({ error: 'Missing tenantId' });

  try {
    // 檢查是否有預約
    const { data: slot } = await supabase
      .from('time_slots')
      .select('booked_count')
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .single();

    if (slot && slot.booked_count > 0) {
      return res.status(409).json({
        error: `此時段已有 ${slot.booked_count} 筆預約，無法刪除`,
      });
    }

    const { error } = await supabase
      .from('time_slots')
      .delete()
      .eq('id', id)
      .eq('tenant_id', tenantId);

    if (error) throw error;

    console.log(`[Admin] Slot deleted: ${id}`);
    res.json({ success: true, message: '時段已刪除' });
  } catch (error) {
    console.error('[Admin] Error deleting slot:', error);
    res.status(500).json({ error: 'Failed to delete slot', details: error.message });
  }
});

/**
 * POST /api/admin/reminders/run
 * 觸發「明天課程提醒」推播
 * 找明天的 confirmed 預約 → 推播給客戶
 *
 * 可用 Cloudflare Workers Cron 每天定時呼叫
 * Body: { tenantId, dryRun? }
 */
router.post('/reminders/run', async (req, res) => {
  const { tenantId, dryRun } = req.body;
  if (!tenantId) return res.status(400).json({ error: 'Missing tenantId' });

  try {
    const { getTenantById } = await import('../middleware/tenant.js');
    const { sendLinePush } = await import('../utils/line.js');

    const tenant = await getTenantById(tenantId);
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

    // 計算明天的範圍（台灣時區）
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStart = new Date(tomorrow.getFullYear(), tomorrow.getMonth(), tomorrow.getDate(), 0, 0, 0);
    const tomorrowEnd = new Date(tomorrow.getFullYear(), tomorrow.getMonth(), tomorrow.getDate(), 23, 59, 59);

    // 查明天的預約（confirmed 狀態）
    const { data: bookings, error } = await supabase
      .from('bookings')
      .select(`
        id,
        customer:customer_id(line_uid, name),
        course:course_id(name),
        slot:slot_id(start_at, end_at)
      `)
      .eq('tenant_id', tenantId)
      .eq('status', 'confirmed')
      .gte('slot.start_at', tomorrowStart.toISOString())
      .lte('slot.start_at', tomorrowEnd.toISOString());

    if (error) throw error;

    const valid = (bookings || []).filter(b => b.slot && b.customer?.line_uid);

    if (dryRun) {
      return res.json({
        success: true,
        dryRun: true,
        count: valid.length,
        bookings: valid.map(b => ({
          customer: b.customer.name,
          course: b.course?.name,
          start: b.slot.start_at,
        })),
      });
    }

    // 實際推播
    let sent = 0;
    let failed = 0;
    for (const b of valid) {
      const start = new Date(b.slot.start_at).toLocaleString('zh-TW', {
        timeZone: 'Asia/Taipei',
        hour: '2-digit', minute: '2-digit'
      });
      const msg =
        `📢 提醒您：明天有課喔～\n\n` +
        `${b.customer.name || ''} 您好，\n` +
        `📚 ${b.course?.name}\n` +
        `🕐 明天 ${start}\n\n` +
        `期待見到您！`;

      const ok = await sendLinePush(
        tenantId,
        tenant.line_access_token,
        b.customer.line_uid,
        msg,
        'reminder',
        b.id
      );
      if (ok) sent++; else failed++;
    }

    console.log(`[Reminders] Sent ${sent}, failed ${failed}`);
    res.json({ success: true, sent, failed, total: valid.length });
  } catch (error) {
    console.error('[Reminders] Error:', error);
    res.status(500).json({ error: 'Failed to run reminders', details: error.message });
  }
});

export default router;
