import express from 'express';
import { getRoomRemainingMap } from '../lib/roomCapacity.js';
import { supabase } from '../lib/supabase.js';

const router = express.Router();

/**
 * GET /api/courses/:tenantId/bank-info
 * 取得租戶的匯款資訊（顧客付款頁顯示）
 * 註：必須放在 /:tenantId 之前，避免被當成 courseId
 */
router.get('/:tenantId/bank-info', async (req, res) => {
  const { tenantId } = req.params;
  try {
    const { data, error } = await supabase
      .from('tenants')
      .select('bank_name, bank_account, bank_account_name, payment_note')
      .eq('id', tenantId)
      .single();
    if (error) throw error;
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ error: 'Failed', details: error.message });
  }
});

/**
 * GET /api/courses/:tenantId/oa-info
 * 取得官方帳號資訊（LIFF 報名前檢查好友用）
 *
 * 加好友網址需要官方帳號的 basic ID（@xxxx）。不要人工填寫，
 * 直接用租戶自己的 access token 問 LINE（GET /v2/bot/info），
 * 這樣換官方帳號或新增租戶都不必改設定。結果快取 10 分鐘。
 *
 * 回應不含任何金鑰。
 * 註：必須放在 /:tenantId 之前，避免被當成 courseId
 */
// 只快取向 LINE 問到的官方帳號資訊（basic ID 幾乎不會變）。
// 租戶設定每次都讀最新的，業主改「好友檢查模式」才會立刻生效。
const botInfoCache = new Map();
const BOT_INFO_TTL = 60 * 60 * 1000;

async function getBotInfo(tenantId, accessToken) {
  if (!accessToken) return null;

  const cached = botInfoCache.get(tenantId);
  if (cached && Date.now() - cached.at < BOT_INFO_TTL) return cached.info;

  try {
    const r = await fetch('https://api.line.me/v2/bot/info', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!r.ok) {
      console.warn(`[OA] /v2/bot/info returned ${r.status} for tenant ${tenantId}`);
      return cached?.info || null;
    }
    const info = await r.json();
    botInfoCache.set(tenantId, { info, at: Date.now() });
    return info;
  } catch (err) {
    console.warn('[OA] Failed to fetch bot info:', err.message);
    return cached?.info || null;
  }
}

router.get('/:tenantId/oa-info', async (req, res) => {
  const { tenantId } = req.params;

  try {
    const { data: tenant, error } = await supabase
      .from('tenants')
      .select('line_access_token, friend_check_mode, liff_id, trial_course_id')
      .eq('id', tenantId)
      .single();
    if (error) throw error;

    const info = await getBotInfo(tenantId, tenant.line_access_token);
    const basicId = info?.basicId || null;

    res.json({
      success: true,
      data: {
        basic_id: basicId,
        display_name: info?.displayName || null,
        picture_url: info?.pictureUrl || null,
        // 取不到 basic_id 就沒有加好友網址，前端據此判斷「不要擋報名」
        add_friend_url: basicId ? `https://line.me/R/ti/p/${encodeURIComponent(basicId)}` : null,
        friend_check_mode: tenant.friend_check_mode === 'remind' ? 'remind' : 'force',
        liff_id: tenant.liff_id || null,
        trial_course_id: tenant.trial_course_id || null,
      },
    });
  } catch (error) {
    console.error('[OA] Error fetching OA info:', error);
    res.status(500).json({ error: 'Failed to fetch OA info', details: error.message });
  }
});

/**
 * GET /api/courses/:tenantId/tenant-info
 * 取得租戶公開資訊（關於我們頁用）
 */
router.get('/:tenantId/tenant-info', async (req, res) => {
  const { tenantId } = req.params;
  try {
    const { data, error } = await supabase
      .from('tenants')
      .select('name, about, about_image_url, course_banner_url')
      .eq('id', tenantId)
      .single();
    if (error) throw error;
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ error: 'Failed', details: error.message });
  }
});

/**
 * GET /api/courses/:tenantId
 * 取得租戶的所有課程
 */
router.get('/:tenantId', async (req, res) => {
  const { tenantId } = req.params;

  try {
    const { data: courses, error } = await supabase
      .from('courses')
      .select('*')
      .eq('tenant_id', tenantId)
      .eq('is_active', true)
      .order('sort_order', { ascending: true });

    if (error) {
      throw error;
    }

    res.json({
      success: true,
      data: courses,
    });
  } catch (error) {
    console.error('[Courses] Error fetching courses:', error);
    res.status(500).json({
      error: 'Failed to fetch courses',
      details: error.message,
    });
  }
});

/**
 * GET /api/courses/:tenantId/:courseId/slots
 * 取得某課程的所有可預約時段
 * 可選 Query：
 * - startDate: YYYY-MM-DD (預設今天)
 * - endDate: YYYY-MM-DD (預設 7 天後)
 */
router.get('/:tenantId/:courseId/slots', async (req, res) => {
  const { tenantId, courseId } = req.params;
  let { startDate, endDate } = req.query;

  try {
    // 預設日期範圍
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    startDate = startDate || today.toISOString().split('T')[0];

    const ninetyDaysLater = new Date(today);
    ninetyDaysLater.setDate(ninetyDaysLater.getDate() + 90);
    endDate = endDate || ninetyDaysLater.toISOString().split('T')[0];

    // 確保課程屬於此租戶（順便取報名截止天數）
    const { data: course, error: courseError } = await supabase
      .from('courses')
      .select('id, booking_cutoff_days')
      .eq('tenant_id', tenantId)
      .eq('id', courseId)
      .single();

    if (courseError || !course) {
      return res.status(404).json({
        error: 'Course not found',
      });
    }

    // 報名截止：開課前 N 天之內的時段，學員端不顯示
    // （鮮花課程要依人頭訂花材，太接近上課日才報名會來不及）
    const cutoffDays = course.booking_cutoff_days || 0;
    let earliest = new Date(`${startDate}T00:00:00Z`);
    if (cutoffDays > 0) {
      const limit = new Date();
      limit.setDate(limit.getDate() + cutoffDays);
      if (limit > earliest) earliest = limit;
    }

    // 查詢時段
    const { data: slots, error: slotsError } = await supabase
      .from('time_slots')
      .select('*')
      .eq('tenant_id', tenantId)
      .eq('course_id', courseId)
      .eq('is_active', true)
      .gte('start_at', earliest.toISOString())
      .lte('start_at', `${endDate}T23:59:59Z`)
      .order('start_at', { ascending: true });

    if (slotsError) {
      throw slotsError;
    }

    // 計算可用名額
    //
    // 同一時間可能同時開了正式班與體驗課，兩者共用同一間教室。
    // 剩餘名額取「時段自己的餘額」與「整間教室的餘額」較小者，
    // 這樣正式班有人請假釋出位子時，體驗課會自動多出可報名數。
    const roomMap = await getRoomRemainingMap(tenantId, slots.map(s => s.start_at));
    const slotsWithAvailability = slots.map((slot) => {
      const own = Math.max(0, slot.capacity - slot.booked_count);
      const room = roomMap.get(slot.start_at);
      const seats = Math.min(own, room === Infinity ? own : room);
      return {
        ...slot,
        available_seats: seats,
        is_available: seats > 0,
      };
    });

    res.json({
      success: true,
      data: slotsWithAvailability,
    });
  } catch (error) {
    console.error('[Slots] Error fetching slots:', error);
    res.status(500).json({
      error: 'Failed to fetch time slots',
      details: error.message,
    });
  }
});

export default router;
