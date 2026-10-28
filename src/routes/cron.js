/**
 * 每日排程：一次跑所有店家
 *
 * POST /api/cron/run-all   header: x-cron-key = cronKey('all')
 *
 * Cloudflare Worker 每天台灣 18:00 呼叫一次。新增店家不用再改 Worker 設定，
 * 只要店家狀態是 active、而且設好 LINE access token，就會自動被排進去。
 *
 * 某一家出錯不影響其他家，結果逐家回報。
 */
import express from 'express';
import crypto from 'crypto';
import { supabase } from '../lib/supabase.js';
import { cronKey } from '../middleware/auth.js';
import { runReminders, runPaymentCheck } from '../lib/dailyJobs.js';

const router = express.Router();

function requireMasterCron(req, res, next) {
  const given = Buffer.from(req.get('x-cron-key') || '');
  const expected = Buffer.from(cronKey('all'));
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    console.warn('[Cron] run-all 金鑰錯誤');
    return res.status(401).json({ error: 'Invalid cron key', code: 'UNAUTHORIZED' });
  }
  next();
}

router.post('/run-all', requireMasterCron, async (req, res) => {
  const dryRun = !!req.body?.dryRun;
  try {
    const { data: tenants, error } = await supabase
      .from('tenants')
      .select('*')
      .eq('status', 'active')
      .not('line_access_token', 'is', null);
    if (error) throw error;

    const results = [];
    for (const t of tenants || []) {
      const r = { tenant: t.name };
      try { r.reminders = await runReminders(t, { dryRun }); }
      catch (e) { r.reminders = { error: e.message }; console.error(`[Cron] ${t.name} reminders:`, e); }
      if (!dryRun) {
        try { r.paymentCheck = await runPaymentCheck(t); }
        catch (e) { r.paymentCheck = { error: e.message }; console.error(`[Cron] ${t.name} paymentCheck:`, e); }
      }
      results.push(r);
    }
    res.json({ success: true, dryRun, tenants: results.length, results });
  } catch (error) {
    console.error('[Cron] run-all error:', error);
    res.status(500).json({ error: 'Failed', details: error.message });
  }
});

/** 只驗證金鑰，不做事（Worker 公開網址用） */
router.post('/ping', requireMasterCron, (req, res) => res.json({ success: true, via: 'cron-all' }));

export default router;
