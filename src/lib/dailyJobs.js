/**
 * 每日排程工作（課前提醒、課程包催款）
 *
 * 原本寫在 routes/admin.js 的兩條路由裡，只能一次跑一家店。
 * 抽出來成函式之後：
 *   - /api/admin/reminders/run、/payment-check/run 照舊（單一店家，可手動觸發）
 *   - /api/cron/run-all 一次跑所有店家（Cloudflare Worker 每天呼叫）
 */
import { supabase } from './supabase.js';
import { sendLinePush } from '../utils/line.js';

const TW_OFFSET_MS = 8 * 60 * 60 * 1000;

/**
 * 台灣時間「明天」的起訖（回傳 UTC Date）。
 *
 * ⚠️ 原本用伺服器時區（Railway 是 UTC）算「明天」，實際查的是
 * 台灣明天 08:00 到後天 07:59。課都在白天所以沒出事，但早上 8 點前的課
 * 會漏提醒、後天清晨的課會被提早提醒。改成明確用台灣時間計算。
 */
export function taiwanTomorrowRange(now = new Date()) {
  const tw = new Date(now.getTime() + TW_OFFSET_MS);          // 台灣當地的「牆上時間」
  const startUtc = Date.UTC(tw.getUTCFullYear(), tw.getUTCMonth(), tw.getUTCDate() + 1) - TW_OFFSET_MS;
  return { start: new Date(startUtc), end: new Date(startUtc + 24 * 60 * 60 * 1000 - 1) };
}

/** 課前一天提醒 */
export async function runReminders(tenant, { dryRun = false, now = new Date() } = {}) {
  const { start, end } = taiwanTomorrowRange(now);

  const { data: bookings, error } = await supabase
    .from('bookings')
    .select(`
      id,
      customer:customer_id(line_uid, name),
      course:course_id(name),
      slot:slot_id!inner(start_at, end_at)
    `)
    .eq('tenant_id', tenant.id)
    .eq('status', 'confirmed')
    .gte('slot.start_at', start.toISOString())
    .lte('slot.start_at', end.toISOString());

  if (error) throw error;

  const valid = (bookings || []).filter(b => b.slot && b.customer?.line_uid);

  if (dryRun) {
    return {
      dryRun: true,
      count: valid.length,
      bookings: valid.map(b => ({ customer: b.customer.name, course: b.course?.name, start: b.slot.start_at })),
    };
  }

  let sent = 0, failed = 0;
  for (const b of valid) {
    const time = new Date(b.slot.start_at).toLocaleString('zh-TW', {
      timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit',
    });
    const msg =
      `📢 提醒您：明天有課喔～\n\n` +
      `${b.customer.name || ''} 您好，\n` +
      `📚 ${b.course?.name}\n` +
      `🕐 明天 ${time}\n\n` +
      `期待見到您！`;

    const ok = await sendLinePush(tenant.id, tenant.line_access_token, b.customer.line_uid, msg, 'reminder', b.id);
    if (ok) sent++; else failed++;
  }

  console.log(`[Reminders] ${tenant.name}: sent ${sent}, failed ${failed}`);
  return { sent, failed, total: valid.length };
}

/** 課程包、堂數制：逾期催款＋逾期自動取消並釋出名額 */
export async function runPaymentCheck(tenant) {
  const now = Date.now();

  const { data: pkgs } = await supabase
    .from('booking_packages')
    .select('*, course:course_id(name, payment_days), customer:customer_id(line_uid, name)')
    .eq('tenant_id', tenant.id)
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
        status: 'cancelled', cancelled_at: new Date().toISOString(), cancelled_by: 'system',
      }).eq('package_id', pkg.id).neq('status', 'cancelled');

      await supabase.from('booking_packages').update({ status: 'cancelled' }).eq('id', pkg.id);

      if (uid) {
        await sendLinePush(
          tenant.id, tenant.line_access_token, uid,
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
          tenant.id, tenant.line_access_token, uid,
          `🔔 匯款提醒\n\n${pkg.customer?.name || ''} 您好，您報名的「${pkg.course?.name}」尚未完成匯款。\n\n請於明日前完成匯款並回傳後五碼，逾期名額將自動釋出 🙏`,
          'reminder', null
        );
      }
      await supabase.from('booking_packages').update({ payment_reminded: true }).eq('id', pkg.id);
      reminded++;
    }
  }

  console.log(`[PaymentCheck] ${tenant.name}: reminded ${reminded}, cancelled ${cancelled}`);
  return { reminded, cancelled };
}
