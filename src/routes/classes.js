import express from 'express';
import { supabase } from '../lib/supabase.js';
import { sendLinePush } from '../utils/line.js';
import { getTenantById } from '../middleware/tenant.js';

const router = express.Router();

// ============================================================
// 業主：班別管理
// ============================================================

/**
 * POST /api/classes/groups  建立班別
 * Body: { tenantId, courseId, name, total_sessions, capacity, price }
 */
router.post('/groups', async (req, res) => {
  const { tenantId, courseId, name, total_sessions, capacity, price } = req.body;
  if (!tenantId || !courseId || !name) return res.status(400).json({ error: 'Missing fields' });

  try {
    const { data, error } = await supabase
      .from('class_groups')
      .insert({
        tenant_id: tenantId,
        course_id: courseId,
        name,
        total_sessions: parseInt(total_sessions, 10) || 24,
        capacity: parseInt(capacity, 10) || 10,
        price: parseInt(price, 10) || 0,
        status: 'recruiting',
      })
      .select()
      .single();
    if (error) throw error;
    res.json({ success: true, data });
  } catch (error) {
    console.error('[Classes] create group:', error);
    res.status(500).json({ error: 'Failed', details: error.message });
  }
});

/**
 * GET /api/classes/groups  列出班別（業主）
 * Query: tenantId, courseId (optional)
 */
router.get('/groups', async (req, res) => {
  const { tenantId, courseId } = req.query;
  if (!tenantId) return res.status(400).json({ error: 'Missing tenantId' });

  try {
    let q = supabase
      .from('class_groups')
      .select('*, course:course_id(name)')
      .eq('tenant_id', tenantId);
    if (courseId) q = q.eq('course_id', courseId);
    const { data, error } = await q.order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ error: 'Failed', details: error.message });
  }
});

/**
 * GET /api/classes/groups/:id  班別詳情（含堂次 + 報名人數）
 */
router.get('/groups/:id', async (req, res) => {
  const { id } = req.params;
  const { tenantId } = req.query;
  if (!tenantId) return res.status(400).json({ error: 'Missing tenantId' });

  try {
    const { data: group } = await supabase
      .from('class_groups').select('*, course:course_id(name)')
      .eq('id', id).eq('tenant_id', tenantId).single();
    if (!group) return res.status(404).json({ error: 'Not found' });

    const { data: sessions } = await supabase
      .from('class_sessions').select('*')
      .eq('class_group_id', id).order('session_no', { ascending: true });

    res.json({ success: true, data: { ...group, sessions: sessions || [] } });
  } catch (error) {
    res.status(500).json({ error: 'Failed', details: error.message });
  }
});

/**
 * POST /api/classes/groups/:id/sessions  批量建立堂次
 * Body: { tenantId, start_at, durationMin, weekly: true, count }
 *  - 從 start_at 開始，每週同一時間，連續 count 堂
 */
router.post('/groups/:id/sessions', async (req, res) => {
  const { id } = req.params;
  const { tenantId, start_at, durationMin, count } = req.body;
  if (!tenantId || !start_at || !count) return res.status(400).json({ error: 'Missing fields' });

  try {
    // 取得目前已有的堂次數，接續編號
    const { count: existing } = await supabase
      .from('class_sessions').select('id', { count: 'exact', head: true })
      .eq('class_group_id', id);

    const dur = parseInt(durationMin, 10) || 120;
    const rows = [];
    const base = new Date(start_at);
    for (let i = 0; i < parseInt(count, 10); i++) {
      const s = new Date(base); s.setDate(s.getDate() + i * 7);
      const e = new Date(s.getTime() + dur * 60000);
      rows.push({
        tenant_id: tenantId,
        class_group_id: id,
        session_no: (existing || 0) + i + 1,
        start_at: s.toISOString(),
        end_at: e.toISOString(),
      });
    }
    const { data, error } = await supabase.from('class_sessions').insert(rows).select();
    if (error) throw error;
    res.json({ success: true, count: data.length });
  } catch (error) {
    console.error('[Classes] add sessions:', error);
    res.status(500).json({ error: 'Failed', details: error.message });
  }
});

/**
 * DELETE /api/classes/groups/:id  刪除班別（無人報名才可）
 */
router.delete('/groups/:id', async (req, res) => {
  const { id } = req.params;
  const { tenantId } = req.query;
  try {
    const { count } = await supabase
      .from('enrollments').select('id', { count: 'exact', head: true })
      .eq('class_group_id', id).neq('status', 'cancelled');
    if (count && count > 0) return res.status(409).json({ error: `已有 ${count} 人報名，無法刪除` });

    await supabase.from('class_groups').delete().eq('id', id).eq('tenant_id', tenantId);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed', details: error.message });
  }
});

// ============================================================
// 業主：報名確認 + 待補課
// ============================================================

/**
 * GET /api/classes/enrollments  報名清單（業主）
 * Query: tenantId, status, groupId
 */
router.get('/enrollments', async (req, res) => {
  const { tenantId, status, groupId } = req.query;
  if (!tenantId) return res.status(400).json({ error: 'Missing tenantId' });
  try {
    let q = supabase
      .from('enrollments')
      .select('*, customer:customer_id(name, phone, line_uid), group:class_group_id(name, course:course_id(name))')
      .eq('tenant_id', tenantId);
    if (status) q = q.eq('status', status);
    if (groupId) q = q.eq('class_group_id', groupId);
    const { data, error } = await q.order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ error: 'Failed', details: error.message });
  }
});

/**
 * GET /api/classes/enrollments/:id/payment
 */
router.get('/enrollments/:id/payment', async (req, res) => {
  const { id } = req.params;
  const { tenantId } = req.query;
  try {
    const { data } = await supabase.from('payment_confirmations')
      .select('*').eq('enrollment_id', id).eq('tenant_id', tenantId)
      .order('created_at', { ascending: false }).limit(1).single();
    if (!data) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ error: 'Failed', details: error.message });
  }
});

/**
 * PATCH /api/classes/enrollments/:id/confirm  確認報名匯款
 */
router.patch('/enrollments/:id/confirm', async (req, res) => {
  const { id } = req.params;
  const { tenantId } = req.body;
  try {
    const tenant = await getTenantById(tenantId);
    const { data: enr } = await supabase
      .from('enrollments')
      .select('*, customer:customer_id(line_uid, name), group:class_group_id(name, course:course_id(name))')
      .eq('id', id).eq('tenant_id', tenantId).single();
    if (!enr) return res.status(404).json({ error: 'Not found' });

    await supabase.from('enrollments').update({ status: 'confirmed' }).eq('id', id);

    if (enr.customer?.line_uid) {
      await sendLinePush(
        tenantId, tenant.line_access_token, enr.customer.line_uid,
        `✅ 報名確認完成！\n\n${enr.customer?.name || ''} 您好，您報名的「${enr.group?.course?.name} - ${enr.group?.name}」已收到款項，報名確認完成。\n\n期待見到您 🌸`,
        'confirmed', null
      );
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed', details: error.message });
  }
});

/**
 * GET /api/classes/makeup-list  待補課清單（業主）
 * Query: tenantId
 */
router.get('/makeup-list', async (req, res) => {
  const { tenantId } = req.query;
  if (!tenantId) return res.status(400).json({ error: 'Missing tenantId' });
  try {
    const { data, error } = await supabase
      .from('attendance')
      .select(`
        *,
        session:class_session_id(session_no, start_at, class_group_id),
        enrollment:enrollment_id(customer:customer_id(name, phone), group:class_group_id(name, course:course_id(name)))
      `)
      .eq('tenant_id', tenantId)
      .eq('status', 'leave')
      .order('created_at', { ascending: true });
    if (error) throw error;
    res.json({ success: true, data });
  } catch (error) {
    console.error('[Classes] makeup-list:', error);
    res.status(500).json({ error: 'Failed', details: error.message });
  }
});

/**
 * PATCH /api/classes/attendance/:id  業主更新出缺席（補課完成 / 出席）
 * Body: { tenantId, status }
 */
router.patch('/attendance/:id', async (req, res) => {
  const { id } = req.params;
  const { tenantId, status } = req.body;
  if (!['attended', 'makeup_done', 'scheduled', 'leave'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  try {
    const { data, error } = await supabase
      .from('attendance').update({ status }).eq('id', id).eq('tenant_id', tenantId)
      .select().single();
    if (error) throw error;
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ error: 'Failed', details: error.message });
  }
});

// ============================================================
// 學生（LIFF）
// ============================================================

/**
 * GET /api/classes/public/:tenantId/:courseId  該課程的招生中班別（含堂次）
 */
router.get('/public/:tenantId/:courseId', async (req, res) => {
  const { tenantId, courseId } = req.params;
  try {
    const { data: groups } = await supabase
      .from('class_groups')
      .select('*')
      .eq('tenant_id', tenantId).eq('course_id', courseId)
      .eq('status', 'recruiting')
      .order('created_at', { ascending: true });

    const withSessions = await Promise.all((groups || []).map(async g => {
      const { data: sessions } = await supabase
        .from('class_sessions').select('session_no, start_at, end_at')
        .eq('class_group_id', g.id).order('session_no', { ascending: true });
      return { ...g, sessions: sessions || [], available: g.capacity - g.enrolled_count };
    }));
    res.json({ success: true, data: withSessions });
  } catch (error) {
    res.status(500).json({ error: 'Failed', details: error.message });
  }
});

/**
 * POST /api/classes/enroll  學生報名班別
 * Body: { tenantId, lineUid, classGroupId, customerName, customerPhone }
 */
router.post('/enroll', async (req, res) => {
  const { tenantId, lineUid, classGroupId, customerName, customerPhone } = req.body;
  if (!tenantId || !lineUid || !classGroupId) return res.status(400).json({ error: 'Missing fields' });

  try {
    const tenant = await getTenantById(tenantId);

    const { data: group } = await supabase
      .from('class_groups').select('*, course:course_id(name)')
      .eq('id', classGroupId).eq('tenant_id', tenantId).single();
    if (!group) return res.status(404).json({ error: '班別不存在' });
    if (group.enrolled_count >= group.capacity) return res.status(409).json({ error: '此班別已額滿' });

    // 客戶
    const { data: customer } = await supabase
      .from('customers')
      .upsert({ tenant_id: tenantId, line_uid: lineUid, display_name: customerName || '', name: customerName || '', phone: customerPhone || '' },
        { onConflict: 'tenant_id,line_uid' })
      .select().single();

    // 防重複報名
    const { data: existing } = await supabase
      .from('enrollments').select('id')
      .eq('customer_id', customer.id).eq('class_group_id', classGroupId).neq('status', 'cancelled').maybeSingle();
    if (existing) return res.status(409).json({ error: '您已報名此班別' });

    // 建立報名
    const { data: enr, error: enrErr } = await supabase
      .from('enrollments')
      .insert({ tenant_id: tenantId, customer_id: customer.id, class_group_id: classGroupId, status: 'pending_payment', total_price: group.price })
      .select().single();
    if (enrErr) throw enrErr;

    // 班別人數 +1
    await supabase.from('class_groups').update({ enrolled_count: group.enrolled_count + 1 }).eq('id', classGroupId);

    // 為每堂課建立 attendance
    const { data: sessions } = await supabase.from('class_sessions').select('id').eq('class_group_id', classGroupId);
    if (sessions?.length) {
      await supabase.from('attendance').insert(
        sessions.map(s => ({ tenant_id: tenantId, enrollment_id: enr.id, class_session_id: s.id, status: 'scheduled' }))
      );
    }

    // 推播
    await sendLinePush(
      tenantId, tenant.line_access_token, lineUid,
      `✅ 報名成功！\n\n📚 ${group.course?.name} - ${group.name}\n共 ${group.total_sessions} 堂（固定班制）\n\n💰 應繳費用：NT$${group.price.toLocaleString()}\n請完成匯款並回傳後五碼。`,
      'booking_created', null
    );

    const { data: owner } = await supabase.from('owners').select('line_uid').eq('tenant_id', tenantId).single();
    if (owner?.line_uid) {
      await sendLinePush(tenantId, tenant.line_access_token, owner.line_uid,
        `📌 新證照課報名\n客戶：${customerName}\n班別：${group.course?.name} - ${group.name}\n金額：NT$${group.price.toLocaleString()}`,
        'booking_created', null);
    }

    res.json({ success: true, data: { enrollment_id: enr.id, total_price: group.price } });
  } catch (error) {
    console.error('[Classes] enroll:', error);
    res.status(500).json({ error: 'Failed', details: error.message });
  }
});

/**
 * POST /api/classes/enroll/:id/payment  報名匯款
 */
router.post('/enroll/:id/payment', async (req, res) => {
  const { id } = req.params;
  const { tenantId, method, lastFiveDigits, amount } = req.body;
  try {
    const tenant = await getTenantById(tenantId);
    const { data: enr } = await supabase
      .from('enrollments').select('*, customer:customer_id(name)')
      .eq('id', id).eq('tenant_id', tenantId).single();
    if (!enr) return res.status(404).json({ error: 'Not found' });

    await supabase.from('payment_confirmations').insert({
      tenant_id: tenantId, enrollment_id: id, method,
      last_five_digits: lastFiveDigits || null, amount: amount || enr.total_price,
    });
    await supabase.from('enrollments').update({ status: 'pending_confirmation' }).eq('id', id);

    const { data: owner } = await supabase.from('owners').select('line_uid').eq('tenant_id', tenantId).single();
    if (owner?.line_uid) {
      await sendLinePush(tenantId, tenant.line_access_token, owner.line_uid,
        `💰 證照課待確認匯款\n客戶：${enr.customer?.name}\n後五碼：${lastFiveDigits || '(截圖)'}\n金額：${amount || enr.total_price}`,
        'payment_received', null);
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed', details: error.message });
  }
});

/**
 * GET /api/classes/my  學生的證照課報名 + 出缺席（LIFF）
 * Query: tenantId, lineUid
 */
router.get('/my', async (req, res) => {
  const { tenantId, lineUid } = req.query;
  if (!tenantId || !lineUid) return res.status(400).json({ error: 'Missing params' });
  try {
    const { data: customer } = await supabase
      .from('customers').select('id').eq('tenant_id', tenantId).eq('line_uid', lineUid).maybeSingle();
    if (!customer) return res.json({ success: true, data: [] });

    const { data: enrollments } = await supabase
      .from('enrollments')
      .select('*, group:class_group_id(name, total_sessions, course:course_id(name))')
      .eq('tenant_id', tenantId).eq('customer_id', customer.id).neq('status', 'cancelled')
      .order('created_at', { ascending: false });

    const result = await Promise.all((enrollments || []).map(async enr => {
      const { data: att } = await supabase
        .from('attendance')
        .select('id, status, session:class_session_id(session_no, start_at)')
        .eq('enrollment_id', enr.id);
      const attendance = (att || [])
        .filter(a => a.session)
        .sort((a, b) => a.session.session_no - b.session.session_no);
      return { ...enr, attendance };
    }));
    res.json({ success: true, data: result });
  } catch (error) {
    console.error('[Classes] my:', error);
    res.status(500).json({ error: 'Failed', details: error.message });
  }
});

/**
 * PATCH /api/classes/attendance/:id/leave  學生請假
 * Body: { tenantId, lineUid }
 */
router.patch('/attendance/:id/leave', async (req, res) => {
  const { id } = req.params;
  const { tenantId, lineUid } = req.body;
  try {
    const tenant = await getTenantById(tenantId);

    // 驗證歸屬
    const { data: att } = await supabase
      .from('attendance')
      .select('*, session:class_session_id(session_no, start_at), enrollment:enrollment_id(customer:customer_id(line_uid, name), group:class_group_id(name, course:course_id(name)))')
      .eq('id', id).eq('tenant_id', tenantId).single();
    if (!att) return res.status(404).json({ error: 'Not found' });
    if (att.enrollment?.customer?.line_uid !== lineUid) return res.status(403).json({ error: '無權限' });
    if (att.status !== 'scheduled') return res.status(409).json({ error: '此堂無法請假' });

    // 開課後不能請假
    if (new Date(att.session.start_at) <= new Date()) {
      return res.status(409).json({ error: '課程已開始，無法請假' });
    }

    await supabase.from('attendance').update({ status: 'leave' }).eq('id', id);

    // 通知業主
    const { data: owner } = await supabase.from('owners').select('line_uid').eq('tenant_id', tenantId).single();
    if (owner?.line_uid) {
      const t = new Date(att.session.start_at).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
      await sendLinePush(tenantId, tenant.line_access_token, owner.line_uid,
        `🙋 學生請假\n客戶：${att.enrollment?.customer?.name}\n班別：${att.enrollment?.group?.course?.name} - ${att.enrollment?.group?.name}\n第 ${att.session.session_no} 堂（${t}）\n已加入待補課清單`,
        'leave', null);
    }
    res.json({ success: true });
  } catch (error) {
    console.error('[Classes] leave:', error);
    res.status(500).json({ error: 'Failed', details: error.message });
  }
});

export default router;
