/**
 * 匯款截圖：存 Supabase Storage（私有 bucket），業主看的時候才產生短期網址
 *
 * 截圖上有學員的銀行帳戶資訊，所以 bucket 不公開，
 * payment_confirmations.screenshot_url 存的是 bucket 內的路徑，不是網址。
 * 2026-10-29 之前前端沒有真的上傳，舊資料會是「(暫時略過上傳)」。
 */
import { supabase } from './supabase.js';

const BUCKET = 'payment-screenshots';
const MAX_BYTES = 5 * 1024 * 1024;
const TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

/**
 * 存一張截圖，回傳 bucket 內的路徑
 * @param dataUrl  data:image/jpeg;base64,...（前端已壓縮）
 */
export async function saveScreenshot(tenantId, bookingId, dataUrl) {
  const m = /^data:(image\/[a-z]+);base64,(.+)$/.exec(dataUrl || '');
  if (!m || !TYPES[m[1]]) throw Object.assign(new Error('截圖格式不正確，請上傳 JPG 或 PNG'), { status: 400 });

  const buffer = Buffer.from(m[2], 'base64');
  if (buffer.length > MAX_BYTES) throw Object.assign(new Error('截圖不能超過 5MB'), { status: 400 });

  const rand = Math.random().toString(36).slice(2, 10);
  const path = `${tenantId}/${bookingId}-${rand}.${TYPES[m[1]]}`;
  const { error } = await supabase.storage.from(BUCKET).upload(path, buffer, { contentType: m[1] });
  if (error) throw error;
  return path;
}

/** 把 screenshot_url（路徑）換成 1 小時有效的網址；不是路徑的（舊資料）回傳 null */
export async function signScreenshot(value) {
  if (!value || value.startsWith('(') || value.startsWith('http')) return null;
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(value, 3600);
  if (error) {
    console.warn('[Screenshot] sign failed:', error.message);
    return null;
  }
  return data.signedUrl;
}
