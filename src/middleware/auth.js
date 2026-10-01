/**
 * 業主後台驗證
 *
 * ⚠️ 2026-10 修補：/api/admin/* 原本完全沒有驗證，任何人只要知道
 * 後端網址與 tenantId（兩者都寫在公開的前端 bundle 裡）就能讀取
 * 全部學員姓名電話、營收，甚至確認匯款、取消預約、刪除課程。
 *
 * 這裡用 Node 內建 crypto 實作，不另外裝 jsonwebtoken / bcrypt：
 *   - 密碼：scrypt（加 salt，固定時間比對）
 *   - Token：HMAC-SHA256 簽章，內含 ownerId / tenantId / 到期時間
 */
import crypto from 'crypto';

const TOKEN_TTL_MS = 14 * 24 * 60 * 60 * 1000;   // 14 天

/** 簽章金鑰：優先用專用的，沒設定就沿用 service role key（本來就是最高機密） */
function secret() {
  const s = process.env.ADMIN_TOKEN_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!s) throw new Error('缺少 ADMIN_TOKEN_SECRET / SUPABASE_SERVICE_ROLE_KEY');
  return s;
}

const b64u = buf => Buffer.from(buf).toString('base64url');
const unb64u = str => Buffer.from(str, 'base64url');

function sign(payloadStr) {
  return crypto.createHmac('sha256', secret()).update(payloadStr).digest('base64url');
}

/** 發 token 給登入成功的業主 */
export function issueToken({ ownerId, tenantId }) {
  const payload = b64u(JSON.stringify({ o: ownerId, t: tenantId, e: Date.now() + TOKEN_TTL_MS }));
  return `${payload}.${sign(payload)}`;
}

/** 驗 token，失敗回 null */
export function verifyToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;

  const expected = sign(payload);
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  try {
    const data = JSON.parse(unb64u(payload).toString('utf8'));
    if (!data.e || Date.now() > data.e) return null;
    return { ownerId: data.o, tenantId: data.t };
  } catch {
    return null;
  }
}

// ── 密碼 ──────────────────────────────────────────────

/** 產生 scrypt 雜湊，格式：scrypt$<salt base64>$<hash base64> */
export function hashPassword(plain) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(plain, salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

/**
 * 驗證密碼。
 * 回傳 'ok' | 'bad' | 'not_set'
 * not_set = 這個帳號還沒設定過真正的密碼（舊的 placeholder），
 *           交由呼叫端決定要擋下還是引導設定，不要默默放行。
 */
export function checkPassword(plain, stored) {
  if (!stored || !stored.startsWith('scrypt$')) return 'not_set';
  const [, saltB64, hashB64] = stored.split('$');
  if (!saltB64 || !hashB64) return 'not_set';
  try {
    const hash = crypto.scryptSync(plain, Buffer.from(saltB64, 'base64'), 64);
    const stored64 = Buffer.from(hashB64, 'base64');
    if (hash.length !== stored64.length) return 'bad';
    return crypto.timingSafeEqual(hash, stored64) ? 'ok' : 'bad';
  } catch {
    return 'bad';
  }
}

// ── 中介層 ────────────────────────────────────────────

/**
 * 業主身分驗證。
 * 除了要有有效 token，還要求 token 裡的 tenantId 與請求帶的一致，
 * 避免 A 店家的 token 拿去操作 B 店家的資料。
 */
export function requireOwner(req, res, next) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const auth = verifyToken(token);

  if (!auth) {
    return res.status(401).json({ error: '請重新登入', code: 'UNAUTHORIZED' });
  }

  const asked = req.body?.tenantId || req.query?.tenantId;
  if (asked && asked !== auth.tenantId) {
    console.warn(`[Auth] 跨租戶存取被擋：token=${auth.tenantId} 請求=${asked}`);
    return res.status(403).json({ error: '沒有權限存取這個帳號的資料', code: 'FORBIDDEN' });
  }

  req.owner = auth;
  // 沒帶 tenantId 的請求，直接用 token 裡的，後續程式不必再判斷
  if (!asked) {
    if (req.body && typeof req.body === 'object') req.body.tenantId = auth.tenantId;
    if (req.query) req.query.tenantId = auth.tenantId;
  }
  next();
}
