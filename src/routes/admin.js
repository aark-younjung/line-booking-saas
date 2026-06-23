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

/**
 * POST /api/admin/upload-image
 * 上傳課程圖片到 Supabase Storage
 * Body: { tenantId, filename, dataBase64 }  (dataBase64 不含 data:image/... 前綴)
 * 回傳: { url }
 */
router.post('/upload-image', async (req, res) => {
  const { tenantId, filename, dataBase64, contentType } = req.body;
  if (!tenantId || !dataBase64) {
    return res.status(400).json({ error: 'Missing tenantId or image data' });
  }

  try {
    const BUCKET = 'course-images';

    // 確保 bucket 存在（公開讀取）
    await supabase.storage.createBucket(BUCKET, { public: true }).catch(() => {});

    // 解碼 base64
    const buffer = Buffer.from(dataBase64, 'base64');

    // 限制 5MB
    if (buffer.length > 5 * 1024 * 1024) {
      return res.status(400).json({ error: '圖片不能超過 5MB' });
    }

    // 產生檔名（用時間戳避免衝突）— 不用 Date.now，用隨機
    const ext = (filename || 'img.jpg').split('.').pop().toLowerCase();
    const safeExt = ['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(ext) ? ext : 'jpg';
    const rand = Math.random().toString(36).slice(2, 10);
    const path = `${tenantId}/${rand}.${safeExt}`;

    const { error: uploadErr } = await supabase.storage
      .from(BUCKET)
      .upload(path, buffer, {
        contentType: contentType || `image/${safeExt}`,
        upsert: true,
      });

    if (uploadErr) throw uploadErr;

    const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(path);

    console.log(`[Admin] Image uploaded: ${path}`);
    res.json({ success: true, url: pub.publicUrl });
  } catch (error) {
    console.error('[Admin] Error uploading image:', error);
    res.status(500).json({ error: '圖片上傳失敗', details: error.message });
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
  const {
    tenantId, name, description, price, capacity, duration_min, image_url, sort_order, min_students,
    course_type, package_sessions, payment_days, free_changes, lock_days, notice
  } = req.body;

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
        min_students: parseInt(min_students, 10) || 1,
        course_type: course_type || 'single',
        package_sessions: parseInt(package_sessions, 10) || 1,
        payment_days: parseInt(payment_days, 10) || 3,
        free_changes: parseInt(free_changes, 10) || 2,
        lock_days: parseInt(lock_days, 10) || 3,
        notice: notice || null,
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
  const { tenantId, name, description, price, capacity, duration_min, image_url, is_active, sort_order, min_students } = req.body;

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
    if (min_students !== undefined) updates.min_students = parseInt(min_students, 10);
    if (req.body.course_type !== undefined) updates.course_type = req.body.course_type;
    if (req.body.package_sessions !== undefined) updates.package_sessions = parseInt(req.body.package_sessions, 10);
    if (req.body.payment_days !== undefined) updates.payment_days = parseInt(req.body.payment_days, 10);
    if (req.body.free_changes !== undefined) updates.free_changes = parseInt(req.body.free_changes, 10);
    if (req.body.lock_days !== undefined) updates.lock_days = parseInt(req.body.lock_days, 10);
    if (req.body.notice !== undefined) updates.notice = req.body.notice;

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
      .select('id, line_uid, display_name, name, phone, credits, membership_label')
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

// ============================================================
// 客戶管理（會員制 + 證照課堂數）
// ============================================================

/**
 * GET /api/admin/customers
 * 查詢所有客戶
 * Query: tenantId, search (optional)
 */
router.get('/customers', async (req, res) => {
  const { tenantId, search } = req.query;
  if (!tenantId) return res.status(400).json({ error: 'Missing tenantId' });

  try {
    let query = supabase
      .from('customers')
      .select('*')
      .eq('tenant_id', tenantId)
      .order('updated_at', { ascending: false });

    if (search) {
      query = query.or(`name.ilike.%${search}%,phone.ilike.%${search}%,display_name.ilike.%${search}%`);
    }

    const { data, error } = await query.limit(200);
    if (error) throw error;

    res.json({ success: true, data });
  } catch (error) {
    console.error('[Admin] Error fetching customers:', error);
    res.status(500).json({ error: 'Failed to fetch customers', details: error.message });
  }
});

/**
 * PATCH /api/admin/customers/:id
 * 更新客戶資料（業主用）
 * Body: { tenantId, name, phone, membership_label, credits, notes }
 */
router.patch('/customers/:id', async (req, res) => {
  const { id } = req.params;
  const { tenantId, name, phone, membership_label, credits, notes } = req.body;
  if (!tenantId) return res.status(400).json({ error: 'Missing tenantId' });

  try {
    const updates = {};
    if (name !== undefined) updates.name = name;
    if (phone !== undefined) updates.phone = phone;
    if (membership_label !== undefined) updates.membership_label = membership_label;
    if (credits !== undefined) updates.credits = parseInt(credits, 10) || 0;
    if (notes !== undefined) updates.notes = notes;

    const { data, error } = await supabase
      .from('customers')
      .update(updates)
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .select()
      .single();

    if (error) throw error;
    res.json({ success: true, data });
  } catch (error) {
    console.error('[Admin] Error updating customer:', error);
    res.status(500).json({ error: 'Failed to update customer', details: error.message });
  }
});

/**
 * GET /api/admin/today
 * 取得今日所有課程 + 學員
 */
router.get('/today', async (req, res) => {
  const { tenantId } = req.query;
  if (!tenantId) return res.status(400).json({ error: 'Missing tenantId' });

  try {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
    const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);

    // 找今天有預約的所有時段
    const { data: slots, error } = await supabase
      .from('time_slots')
      .select(`
        *,
        course:course_id(name, price)
      `)
      .eq('tenant_id', tenantId)
      .gte('start_at', todayStart.toISOString())
      .lte('start_at', todayEnd.toISOString())
      .order('start_at', { ascending: true });

    if (error) throw error;

    // 各時段抓學員
    const slotsWithCustomers = await Promise.all(
      (slots || []).map(async (slot) => {
        const { data: bookings } = await supabase
          .from('bookings')
          .select(`
            id, status, used_credit,
            customer:customer_id(name, phone, line_uid, display_name, membership_label)
          `)
          .eq('slot_id', slot.id)
          .eq('tenant_id', tenantId)
          .neq('status', 'cancelled');

        return { ...slot, bookings: bookings || [] };
      })
    );

    res.json({ success: true, data: slotsWithCustomers });
  } catch (error) {
    console.error('[Admin] Error fetching today:', error);
    res.status(500).json({ error: 'Failed to fetch today', details: error.message });
  }
});

/**
 * GET /api/admin/revenue
 * 營收報表（依月份）
 * Query: tenantId, month (YYYY-MM，預設本月)
 */
router.get('/revenue', async (req, res) => {
  const { tenantId, month } = req.query;
  if (!tenantId) return res.status(400).json({ error: 'Missing tenantId' });

  try {
    // 計算月份範圍
    const now = new Date();
    const ym = month || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const [year, mon] = ym.split('-').map(Number);
    const monthStart = new Date(year, mon - 1, 1, 0, 0, 0);
    const monthEnd = new Date(year, mon, 0, 23, 59, 59);

    // 查該月「上課時間」落在範圍內、已確認/完成的預約
    const { data: bookings, error } = await supabase
      .from('bookings')
      .select(`
        id, status, used_credit,
        course:course_id(name, price),
        customer:customer_id(name),
        slot:slot_id(start_at)
      `)
      .eq('tenant_id', tenantId)
      .in('status', ['confirmed', 'completed']);

    if (error) throw error;

    // 篩選上課時間在該月的
    const inMonth = (bookings || []).filter(b => {
      if (!b.slot?.start_at) return false;
      const t = new Date(b.slot.start_at);
      return t >= monthStart && t <= monthEnd;
    });

    // 統計
    let totalRevenue = 0;
    let paidCount = 0;       // 實際收費的預約（非會員）
    let creditCount = 0;     // 會員預約（已預收，不計入當月）
    const byCourse = {};
    const byCustomer = {};

    for (const b of inMonth) {
      const price = b.course?.price || 0;
      const courseName = b.course?.name || '未知';
      const custName = b.customer?.name || '匿名';

      if (b.used_credit) {
        creditCount++;
      } else {
        totalRevenue += price;
        paidCount++;
      }

      // 依課程
      if (!byCourse[courseName]) byCourse[courseName] = { count: 0, revenue: 0 };
      byCourse[courseName].count++;
      if (!b.used_credit) byCourse[courseName].revenue += price;

      // 依客戶
      if (!byCustomer[custName]) byCustomer[custName] = { count: 0, revenue: 0 };
      byCustomer[custName].count++;
      if (!b.used_credit) byCustomer[custName].revenue += price;
    }

    res.json({
      success: true,
      data: {
        month: ym,
        totalRevenue,
        totalBookings: inMonth.length,
        paidCount,
        creditCount,
        byCourse: Object.entries(byCourse).map(([name, v]) => ({ name, ...v })).sort((a, b) => b.revenue - a.revenue),
        byCustomer: Object.entries(byCustomer).map(([name, v]) => ({ name, ...v })).sort((a, b) => b.count - a.count),
      },
    });
  } catch (error) {
    console.error('[Admin] Error fetching revenue:', error);
    res.status(500).json({ error: 'Failed to fetch revenue', details: error.message });
  }
});

/**
 * POST /api/admin/slots/:id/cancel-class
 * 取消整個時段（人數不足不開課）
 * 取消所有預約 + 推播通知學員 + 退還會員堂數
 * Body: { tenantId, reason? }
 */
router.post('/slots/:id/cancel-class', async (req, res) => {
  const { id: slotId } = req.params;
  const { tenantId, reason } = req.body;
  if (!tenantId) return res.status(400).json({ error: 'Missing tenantId' });

  try {
    const { getTenantById } = await import('../middleware/tenant.js');
    const { sendLinePush } = await import('../utils/line.js');
    const tenant = await getTenantById(tenantId);
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

    // 取得時段資訊
    const { data: slot } = await supabase
      .from('time_slots')
      .select('*, course:course_id(name)')
      .eq('id', slotId)
      .eq('tenant_id', tenantId)
      .single();

    if (!slot) return res.status(404).json({ error: 'Slot not found' });

    // 取得所有未取消的預約
    const { data: bookings } = await supabase
      .from('bookings')
      .select('id, used_credit, customer:customer_id(id, line_uid, name, credits)')
      .eq('slot_id', slotId)
      .eq('tenant_id', tenantId)
      .neq('status', 'cancelled');

    const startTime = new Date(slot.start_at).toLocaleString('zh-TW', {
      timeZone: 'Asia/Taipei',
      month: '2-digit', day: '2-digit', weekday: 'short',
      hour: '2-digit', minute: '2-digit'
    });

    let notified = 0;
    for (const b of (bookings || [])) {
      // 取消預約
      await supabase
        .from('bookings')
        .update({ status: 'cancelled', cancelled_at: new Date().toISOString(), cancelled_by: 'owner' })
        .eq('id', b.id);

      // 會員退還堂數
      if (b.used_credit && b.customer?.id) {
        await supabase
          .from('customers')
          .update({ credits: (b.customer.credits || 0) + 1 })
          .eq('id', b.customer.id);
      }

      // 推播通知
      if (b.customer?.line_uid) {
        const msg =
          `⚠️ 課程取消通知\n\n` +
          `${b.customer.name || ''} 您好，很抱歉，以下課程因故取消：\n\n` +
          `📚 ${slot.course?.name}\n` +
          `🕐 ${startTime}\n\n` +
          (reason ? `原因：${reason}\n\n` : '') +
          (b.used_credit ? '已退還 1 堂課程額度。\n' : '如已付款，將安排退款，請聯絡業主。\n') +
          `造成不便敬請見諒。`;

        const ok = await sendLinePush(tenantId, tenant.line_access_token, b.customer.line_uid, msg, 'cancelled', b.id);
        if (ok) notified++;
      }
    }

    // 時段停用
    await supabase
      .from('time_slots')
      .update({ is_active: false, booked_count: 0 })
      .eq('id', slotId);

    console.log(`[Admin] Class cancelled: ${slotId}, notified ${notified}`);
    res.json({ success: true, cancelled: (bookings || []).length, notified });
  } catch (error) {
    console.error('[Admin] Error cancelling class:', error);
    res.status(500).json({ error: 'Failed to cancel class', details: error.message });
  }
});

/**
 * GET /api/admin/packages
 * 查詢課程包報名（業主用）
 * Query: tenantId, status (optional)
 */
router.get('/packages', async (req, res) => {
  const { tenantId, status } = req.query;
  if (!tenantId) return res.status(400).json({ error: 'Missing tenantId' });

  try {
    let query = supabase
      .from('booking_packages')
      .select(`
        *,
        course:course_id(name),
        customer:customer_id(name, phone, line_uid)
      `)
      .eq('tenant_id', tenantId);

    if (status) query = query.eq('status', status);

    const { data, error } = await query.order('created_at', { ascending: false });
    if (error) throw error;

    // 各 package 附上時段清單
    const withSlots = await Promise.all((data || []).map(async (pkg) => {
      const { data: bks } = await supabase
        .from('bookings')
        .select('id, status, slot:slot_id(start_at)')
        .eq('package_id', pkg.id)
        .neq('status', 'cancelled');
      const slots = (bks || []).map(b => b.slot?.start_at).filter(Boolean).sort();
      return { ...pkg, slots };
    }));

    res.json({ success: true, data: withSlots });
  } catch (error) {
    console.error('[Admin] Error fetching packages:', error);
    res.status(500).json({ error: 'Failed', details: error.message });
  }
});

/**
 * GET /api/admin/packages/:id/payment
 * 課程包的匯款資訊
 */
router.get('/packages/:id/payment', async (req, res) => {
  const { id } = req.params;
  const { tenantId } = req.query;
  if (!tenantId) return res.status(400).json({ error: 'Missing tenantId' });

  try {
    const { data, error } = await supabase
      .from('payment_confirmations')
      .select('*')
      .eq('package_id', id)
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();
    if (error || !data) return res.status(404).json({ error: 'Payment info not found' });
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ error: 'Failed', details: error.message });
  }
});

/**
 * PATCH /api/admin/packages/:id/confirm
 * 業主確認課程包匯款 → 所有堂數 confirmed
 */
router.patch('/packages/:id/confirm', async (req, res) => {
  const { id } = req.params;
  const { tenantId } = req.body;
  if (!tenantId) return res.status(400).json({ error: 'Missing tenantId' });

  try {
    const { getTenantById } = await import('../middleware/tenant.js');
    const { sendLinePush } = await import('../utils/line.js');
    const tenant = await getTenantById(tenantId);

    const { data: pkg } = await supabase
      .from('booking_packages')
      .select('*, course:course_id(name), customer:customer_id(line_uid, name)')
      .eq('id', id).eq('tenant_id', tenantId).single();
    if (!pkg) return res.status(404).json({ error: 'Package not found' });

    await supabase.from('booking_packages').update({ status: 'confirmed' }).eq('id', id);
    await supabase.from('bookings').update({ status: 'confirmed' }).eq('package_id', id).neq('status', 'cancelled');

    if (pkg.customer?.line_uid) {
      await sendLinePush(
        tenantId, tenant.line_access_token, pkg.customer.line_uid,
        `✅ 報名確認完成！\n\n${pkg.customer?.name || ''} 您好，您報名的「${pkg.course?.name}」已收到款項，報名確認完成。\n\n期待見到您 🌸`,
        'confirmed', null
      );
    }

    res.json({ success: true });
  } catch (error) {
    console.error('[Admin] Error confirming package:', error);
    res.status(500).json({ error: 'Failed', details: error.message });
  }
});

/**
 * POST /api/admin/payment-check/run
 * 檢查未匯款的課程包：
 * - 超過 (payment_days - 1) 天未匯款且未提醒 → 催款
 * - 超過 payment_days 天未匯款 → 取消、釋出名額、通知
 *
 * 給 Cloudflare Cron 每小時呼叫
 */
router.post('/payment-check/run', async (req, res) => {
  const { tenantId } = req.body;
  if (!tenantId) return res.status(400).json({ error: 'Missing tenantId' });

  try {
    const { getTenantById } = await import('../middleware/tenant.js');
    const { sendLinePush } = await import('../utils/line.js');
    const tenant = await getTenantById(tenantId);
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

    const now = Date.now();

    // 取得所有待匯款的課程包
    const { data: pkgs } = await supabase
      .from('booking_packages')
      .select('*, course:course_id(name, payment_days), customer:customer_id(line_uid, name)')
      .eq('tenant_id', tenantId)
      .eq('status', 'pending_payment');

    let reminded = 0, cancelled = 0;

    for (const pkg of (pkgs || [])) {
      const ageDays = (now - new Date(pkg.created_at).getTime()) / (1000 * 60 * 60 * 24);
      const payDays = pkg.course?.payment_days || 3;
      const uid = pkg.customer?.line_uid;

      // 超過期限 → 取消
      if (ageDays >= payDays) {
        // 取消所有 bookings（trigger 自動釋出 booked_count）
        await supabase.from('bookings').update({
          status: 'cancelled', cancelled_at: new Date().toISOString(), cancelled_by: 'system'
        }).eq('package_id', pkg.id).neq('status', 'cancelled');

        await supabase.from('booking_packages').update({ status: 'cancelled' }).eq('id', pkg.id);

        if (uid) {
          await sendLinePush(
            tenantId, tenant.line_access_token, uid,
            `⚠️ 報名已自動取消\n\n${pkg.customer?.name || ''} 您好，您報名的「${pkg.course?.name}」因逾 ${payDays} 日未完成匯款，名額已自動釋出。\n\n如仍想上課，請重新報名。`,
            'cancelled', null
          );
        }
        cancelled++;
      }
      // 超過 (payDays - 1) 天且未提醒 → 催款
      else if (ageDays >= payDays - 1 && !pkg.payment_reminded) {
        if (uid) {
          await sendLinePush(
            tenantId, tenant.line_access_token, uid,
            `🔔 匯款提醒\n\n${pkg.customer?.name || ''} 您好，您報名的「${pkg.course?.name}」尚未完成匯款。\n\n請於明日前完成匯款並回傳後五碼，逾期名額將自動釋出 🙏`,
            'reminder', null
          );
        }
        await supabase.from('booking_packages').update({ payment_reminded: true }).eq('id', pkg.id);
        reminded++;
      }
    }

    console.log(`[PaymentCheck] reminded ${reminded}, cancelled ${cancelled}`);
    res.json({ success: true, reminded, cancelled });
  } catch (error) {
    console.error('[PaymentCheck] Error:', error);
    res.status(500).json({ error: 'Failed', details: error.message });
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
