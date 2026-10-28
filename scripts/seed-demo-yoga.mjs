/**
 * 瑜伽示範帳號：建立課程、時段、學員與各種狀態的預約
 *
 *   node scripts/seed-demo-yoga.mjs <API 網址> <設定檔> <tenantId> [--resume]
 *   例：node scripts/seed-demo-yoga.mjs http://localhost:3000 scripts/tenants/demo-yoga.json b82e7142-...
 *
 * 全部走系統真正的 API（學員預約 → 回報繳費 → 業主確認），資料狀態跟真實使用一模一樣。
 * 示範店家沒有 LINE token，所有推播會直接略過，不會發給任何人。
 *
 * --resume：課程、時段、單堂預約已經建好（例如上次中途失敗），只補課卡與 4 週班；
 *           已經買過的學員會跳過，不會重複建立。
 *
 * 學員都是假資料：姓名「示範－○○○」、LINE UID「U_DEMOYOGA_xx」、電話 0900-000-xxx。
 */
import fs from 'fs';

const [API, cfgPath, tenantId] = process.argv.slice(2);
const RESUME = process.argv.includes('--resume');
if (!API || !cfgPath || !tenantId) {
  console.error('用法：node scripts/seed-demo-yoga.mjs <API> <config.json> <tenantId> [--resume]');
  process.exit(1);
}
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));

// ---------- 共用 ----------
async function call(method, path, body, token) {
  const res = await fetch(API + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${json.error || ''} ${json.details || ''}`);
  return json;
}

const login = await call('POST', '/api/admin/login', { tenantId, email: cfg.owner.email, password: cfg.owner.password });
const token = login.data.token;
const admin = (m, p, b) => call(m, p, { tenantId, ...(b || {}) }, token);

const COURSES = [
  { key: 'flow', name: '流動瑜伽 Vinyasa｜單堂', course_type: 'single', price: 450, capacity: 12, duration_min: 60,
    description: '跟著呼吸串連體位，適合有一點基礎、想流點汗的妳。\n\n・請自備瑜伽墊或現場租借（NT$50）\n・課前 2 小時避免進食' },
  { key: 'hatha', name: '哈達瑜伽 Hatha｜單堂', course_type: 'single', price: 400, capacity: 12, duration_min: 60,
    description: '節奏放慢、停留較久，第一次上瑜伽課的人推薦從這堂開始。' },
  { key: 'aerial', name: '空中瑜伽 Aerial｜單堂', course_type: 'single', price: 650, capacity: 6, duration_min: 75,
    description: '借助吊床支撐完成倒立與伸展，小班 6 人。\n\n・請穿著有袖上衣、長褲\n・飾品請先取下' },
  { key: 'card', name: '晨間瑜伽 10 堂課卡', course_type: 'credit', price: 3800, capacity: 10, duration_min: 60, package_sessions: 10,
    description: '一次購買 10 堂，之後每次自己預約晨間時段，系統自動扣堂數。\n\n平均一堂 NT$380，比單堂省 NT$70。' },
  { key: 'begin', name: '初學者 4 週養成班', course_type: 'package', price: 400, capacity: 8, duration_min: 60, package_sessions: 4,
    payment_days: 3, free_changes: 2, lock_days: 1,
    description: '每週一堂、共 4 堂，從呼吸與基本體位開始，4 週後就能跟上一般課程。\n\n可自助改期 2 次（開課前 1 天鎖定）。' },
];

// 每週固定課表：[課程, 星期幾(0=日), 時, 分]
const SCHEDULE = [
  ['flow', [1, 3, 5], 19, 30], ['flow', [6], 9, 0],
  ['hatha', [2, 4], 10, 0], ['hatha', [0], 10, 0],
  ['aerial', [3], 18, 0], ['aerial', [6], 14, 0],
  ['card', [1, 2, 3, 4, 5], 7, 0],
  ['begin', [4], 19, 30],
];

const NAMES = ['王小美', '陳雅婷', '林佳穎', '張怡君', '李佩珊', '黃詩涵', '吳欣妤', '劉品君', '蔡宜庭', '鄭婷婷', '周思妤', '許雅雯'];
const S = NAMES.map((n, i) => ({
  lineUid: `U_DEMOYOGA_${String(i + 1).padStart(2, '0')}`,
  customerName: `示範－${n}`,
  customerPhone: `0900-000-${101 + i}`,
}));

const course = {};
const slotsOf = async (key) => (await call('GET', `/api/courses/${tenantId}/${course[key].id}/slots`)).data
  .filter(s => new Date(s.start_at).getTime() > Date.now() + 3600e3)   // 系統不讓人預約已經開始的課
  .sort((a, b) => new Date(a.start_at) - new Date(b.start_at));
const book = (s, key, slot) => call('POST', '/api/bookings', { tenantId, courseId: course[key].id, slotId: slot.id, ...s }).then(r => r.data);
const pay = (bk, method, amount, last5) => call('POST', `/api/bookings/${bk.id}/payment`, {
  tenantId, method, amount, lastFiveDigits: method === 'last_five' ? last5 : null,
});
const confirm = (bk) => call('PATCH', `/api/bookings/${bk.id}/confirm`, { tenantId }, token);
/** 這位學員是否已經有這門課的課卡／課程包（避免 --resume 時重複建立） */
const hasPackage = async (s, key) =>
  ((await call('GET', `/api/bookings/my?tenantId=${tenantId}&lineUid=${s.lineUid}`)).data || [])
    .find(p => p.course_id === course[key].id) || null;

// ---------- 1. 課程、時段、單堂預約（第一次執行才做）----------
const existing = (await call('GET', `/api/courses/${tenantId}`)).data || [];
if (RESUME) {
  for (const c of COURSES) {
    course[c.key] = existing.find(x => x.name === c.name);
    if (!course[c.key]) throw new Error(`--resume 找不到課程「${c.name}」，請改用一般模式重新建立`);
  }
  console.log('（--resume：沿用既有課程、時段與單堂預約）');
} else {
  if (existing.length) {
    console.error(`這家店已經有 ${existing.length} 門課，為避免重複建立而停止。中途失敗要接著做請加 --resume。`);
    process.exit(1);
  }
  for (const c of COURSES) {
    const { key, ...body } = c;
    course[key] = (await admin('POST', '/api/admin/courses', body)).data;
  }
  console.log(`✓ 課程 ${COURSES.length} 門`);

  // 時段：台灣時間，從今天起排；4 週班要至少 4 週
  const TW = 8 * 3600e3;
  const twNow = new Date(Date.now() + TW);
  const today = Date.UTC(twNow.getUTCFullYear(), twNow.getUTCMonth(), twNow.getUTCDate());
  const at = (day, hh, mm) => new Date(today + day * 864e5 + (hh * 60 + mm) * 6e4 - TW);
  const firstDay = (wd) => (wd - twNow.getUTCDay() + 7) % 7;
  for (const [key, days, hh, mm] of SCHEDULE) {
    const c = course[key];
    for (const wd of days) {
      const start = at(firstDay(wd), hh, mm);
      await admin('POST', '/api/admin/slots/batch', {
        courseId: c.id, start_at: start.toISOString(),
        end_at: new Date(start.getTime() + c.duration_min * 6e4).toISOString(),
        capacity: c.capacity, weeks: key === 'begin' ? 6 : 3,
      });
    }
  }
  console.log('✓ 時段（3 週，4 週班 6 週）');

  // 流動瑜伽：最近一堂 6 人（4 已確認、1 待確認、1 待付款）；下一堂 3 人
  const flow = await slotsOf('flow');
  for (let i = 0; i < 4; i++) { const b = await book(S[i], 'flow', flow[0]); await pay(b, 'last_five', 450, String(10000 + i * 1111).slice(-5)); await confirm(b); }
  await pay(await book(S[4], 'flow', flow[0]), 'last_five', 450, '83920');
  await book(S[5], 'flow', flow[0]);
  for (let i = 6; i < 9; i++) { const b = await book(S[i], 'flow', flow[1]); await pay(b, 'linepay', 450); await confirm(b); }
  // 哈達：最近一堂 3 人（2 已確認、1 現金待確認）
  const hatha = await slotsOf('hatha');
  for (let i = 0; i < 2; i++) { const b = await book(S[8 + i], 'hatha', hatha[0]); await pay(b, 'cash', 400); await confirm(b); }
  await pay(await book(S[10], 'hatha', hatha[0]), 'cash', 400);
  // 空中瑜伽：小班 6 人，最近一堂 5 人 → 剩 1 位
  const aerial = await slotsOf('aerial');
  for (let i = 0; i < 5; i++) { const b = await book(S[i + 2], 'aerial', aerial[0]); await pay(b, 'last_five', 650, String(20000 + i * 2222).slice(-5)); await confirm(b); }
  console.log('✓ 單堂預約');
}

// ---------- 2. 課卡：2 位使用中、1 位剛買待確認 ----------
const cardSlots = await slotsOf('card');
for (const [si, uses] of [[0, 3], [3, 1]]) {
  let pkg = await hasPackage(S[si], 'card');
  if (!pkg) {
    const enr = (await call('POST', '/api/bookings/credit-enroll', { tenantId, courseId: course.card.id, ...S[si] })).data;
    pkg = { id: enr.package_id, status: 'pending_payment' };
  }
  if (pkg.status === 'pending_payment') {
    await call('POST', `/api/bookings/package/${pkg.id}/payment`, { tenantId, method: 'last_five', lastFiveDigits: `5566${si}`, amount: 3800 });
  }
  if (pkg.status !== 'confirmed') await call('PATCH', `/api/admin/packages/${pkg.id}/confirm`, { tenantId }, token);
  const already = (pkg.bookings || []).length;
  for (let u = already; u < uses; u++) {
    await call('POST', '/api/bookings/credit-book', { tenantId, courseId: course.card.id, slotId: cardSlots[u * 2 + si].id, lineUid: S[si].lineUid });
  }
}
if (!(await hasPackage(S[11], 'card'))) {
  const enr = (await call('POST', '/api/bookings/credit-enroll', { tenantId, courseId: course.card.id, ...S[11] })).data;
  await call('POST', `/api/bookings/package/${enr.package_id}/payment`, { tenantId, method: 'last_five', lastFiveDigits: '73015', amount: 3800 });
}
console.log('✓ 課卡（2 位使用中、1 位待確認）');

// ---------- 3. 初學者 4 週班：已確認／待確認／待付款 各 1 位 ----------
const begin = await slotsOf('begin');
for (const [si, stage] of [[1, 'confirmed'], [5, 'pending_confirmation'], [7, 'pending_payment']]) {
  if (await hasPackage(S[si], 'begin')) continue;
  const pkg = (await call('POST', '/api/bookings/package', {
    tenantId, courseId: course.begin.id, slotIds: begin.slice(0, 4).map(s => s.id), ...S[si],
  })).data;
  if (stage === 'pending_payment') continue;
  await call('POST', `/api/bookings/package/${pkg.package_id}/payment`, { tenantId, method: 'last_five', lastFiveDigits: `4920${si}`, amount: 1600 });
  if (stage === 'confirmed') await call('PATCH', `/api/admin/packages/${pkg.package_id}/confirm`, { tenantId }, token);
}
console.log('✓ 4 週養成班');
console.log('\n完成。');
