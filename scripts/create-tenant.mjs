/**
 * 開新店家
 *
 *   node scripts/create-tenant.mjs scripts/tenants/<店家>.json            實際建立
 *   node scripts/create-tenant.mjs scripts/tenants/<店家>.json --dry-run  只檢查、不寫入
 *
 * 會做的事：
 *   1. 建立 tenants（方案、LINE 設定、匯款資訊、教室上限…）
 *   2. 建立唯一一位業主帳號（scrypt 密碼）
 *   3. 印出接下來的步驟：LINE Developers 要填的 Webhook、前端部署指令
 *
 * ⚠️ 一家店只能有一位業主（owners 有 9 處程式用 .single() 讀業主，
 *    多一筆會讓業主收不到 LINE 通知）。這支程式會檢查。
 * ⚠️ 設定檔含 LINE 金鑰與密碼，已列在 .gitignore（scripts/tenants/*.json）。
 */
import fs from 'fs';
import crypto from 'crypto';

// 讀 .env（跟 src/index.js 一樣的設定）
for (const l of fs.readFileSync(new URL('../.env', import.meta.url), 'utf8').split(/\r?\n/)) {
  const m = l.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const { supabase } = await import('../src/lib/supabase.js');
const { hashPassword } = await import('../src/middleware/auth.js');

const BACKEND_URL = 'https://line-booking-saas-production.up.railway.app';
const PLANS = ['trial', 'starter', 'standard', 'advanced'];

const file = process.argv[2];
const dryRun = process.argv.includes('--dry-run');
if (!file) {
  console.error('用法：node scripts/create-tenant.mjs scripts/tenants/<店家>.json [--dry-run]');
  process.exit(1);
}
const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));

// ---------- 檢查 ----------
const problems = [];
const warn = [];
if (!/^[a-z0-9-]{2,20}$/.test(cfg.slug || '')) problems.push('slug 只能用小寫英文、數字、-（2～20 字），會用在網址：<slug>-liff.pages.dev');
if (!cfg.name) problems.push('缺少店名 name');
if (!PLANS.includes(cfg.plan)) problems.push(`plan 要是 ${PLANS.join(' / ')}`);
if (!cfg.owner?.email || !/^\S+@\S+\.\S+$/.test(cfg.owner.email)) problems.push('業主 email 格式不對');
if (!cfg.owner?.name) problems.push('缺少業主姓名 owner.name');
if (cfg.owner?.password && cfg.owner.password.length < 8) problems.push('業主密碼至少 8 碼（留空會自動產生）');
if (!['force', 'remind'].includes(cfg.friend_check_mode || 'force')) problems.push('friend_check_mode 要是 force 或 remind');

const line = cfg.line || {};
if (!line.channel_secret || !line.access_token) warn.push('還沒填 LINE channel_secret / access_token：預約通知、Webhook、每日提醒都不會運作（之後補在 tenants 表即可）');
if (!line.liff_id) warn.push('還沒填 LIFF ID：學員端無法部署，歡迎訊息也不會有按鈕');
if (!cfg.owner?.line_uid) warn.push('還沒填業主 LINE UID：業主收不到「待確認匯款」通知（業主加好友後可從 customers 表查到再補）');
if (!cfg.bank?.bank_account) warn.push('還沒填匯款帳號：付款頁不會顯示帳號');

const { data: dup } = await supabase.from('tenants').select('id, name').eq('name', cfg.name);
if (dup?.length) problems.push(`已經有同名店家「${cfg.name}」（id ${dup[0].id}），避免重複建立`);
const { data: dupOwner } = await supabase.from('owners').select('id, tenant_id').eq('email', cfg.owner?.email || '');
if (dupOwner?.length) warn.push(`這個 email 已是其他店家的業主（tenant ${dupOwner[0].tenant_id}），登入時會依網址對應店家，不影響但請確認`);

console.log(`\n=== ${cfg.name}（${cfg.slug}）｜方案 ${cfg.plan} ===`);
warn.forEach(w => console.log('  ⚠ ' + w));
if (problems.length) {
  problems.forEach(p => console.log('  ✗ ' + p));
  console.log('\n請修正設定檔後再執行。');
  process.exit(1);
}
if (dryRun) {
  console.log('\n（--dry-run：檢查通過，沒有寫入任何資料）');
  process.exit(0);
}

// ---------- 建立 ----------
const expires = cfg.plan === 'trial'
  ? new Date(Date.now() + (cfg.trial_days || 30) * 24 * 3600 * 1000).toISOString()
  : null;

const { data: tenant, error: tErr } = await supabase.from('tenants').insert({
  name: cfg.name,
  plan: cfg.plan,
  status: 'active',
  expires_at: expires,
  line_channel_id: line.channel_id || null,
  line_channel_secret: line.channel_secret || null,
  line_access_token: line.access_token || null,
  liff_id: line.liff_id || null,
  bank_name: cfg.bank?.bank_name || null,
  bank_account: cfg.bank?.bank_account || null,
  bank_account_name: cfg.bank?.bank_account_name || null,
  payment_note: cfg.bank?.payment_note || null,
  room_capacity: parseInt(cfg.room_capacity, 10) || 0,
  friend_check_mode: cfg.friend_check_mode || 'force',
  welcome_message: cfg.welcome_message || null,
}).select().single();
if (tErr) { console.error('建立店家失敗：', tErr.message); process.exit(1); }

const password = cfg.owner.password || crypto.randomBytes(9).toString('base64url');
const { error: oErr } = await supabase.from('owners').insert({
  tenant_id: tenant.id,
  email: cfg.owner.email,
  name: cfg.owner.name,
  line_uid: cfg.owner.line_uid || null,
  password_hash: hashPassword(password),
});
if (oErr) {
  console.error('建立業主失敗：', oErr.message, '\n→ 店家已建立但沒有業主，刪除 tenants id', tenant.id, '後重跑');
  process.exit(1);
}

// ---------- 接下來的步驟 ----------
const slug = cfg.slug;
console.log(`
✅ 店家已建立
   tenant id   ${tenant.id}
   方案        ${cfg.plan}${expires ? `（試跑到 ${expires.slice(0, 10)}）` : ''}
   業主登入    ${cfg.owner.email}
   業主密碼    ${cfg.owner.password ? '（設定檔裡的密碼）' : password + '   ← 自動產生，只會顯示這一次，請交給業主'}

── 接下來 ──────────────────────────────────────────

1. LINE Developers → Messaging API → Webhook URL 填：
   ${BACKEND_URL}/api/webhook/${tenant.id}
   並開啟 Use webhook；LINE Official Account Manager 的「自動回應」關閉

2. LIFF 的 Endpoint URL 填：
   https://${slug}-liff.pages.dev

3. 部署兩個前端（在 Git Bash 執行）：
   bash scripts/deploy-frontends.sh ${slug} ${tenant.id} ${line.liff_id || '<LIFF_ID>'}

4. 業主後台：https://${slug}-admin.pages.dev
   請業主登入後到「設定」填寫關於我們、確認匯款資訊，再到「課程管理」建課程與時段

5. 每日提醒不用設定：店家狀態 active 且有 LINE token，就會自動排進每天 18:00 的排程
`);
