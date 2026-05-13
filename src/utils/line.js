// fetch is built-in in Node.js 18+
import { supabase } from '../lib/supabase.js';

const LINE_PUSH_URL = 'https://api.line.me/v2/bot/message/push';
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

/**
 * 發送 LINE Push Message，含自動重試 (最多 3 次)
 * 並記錄到 notifications_log
 */
export const sendLinePush = async (
  tenantId,
  lineAccessToken,
  targetLineUid,
  message,
  eventType = 'booking_created',
  bookingId = null
) => {
  let lastError = null;
  let retryCount = 0;

  // 建立通知紀錄
  const { data: notifLog } = await supabase
    .from('notifications_log')
    .insert({
      tenant_id: tenantId,
      booking_id: bookingId,
      target_uid: targetLineUid,
      event_type: eventType,
      message: message,
      status: 'pending',
      retry_count: 0,
    })
    .select()
    .single();

  const notificationId = notifLog?.id;

  // 重試迴圈
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      if (attempt > 0) {
        // 延遲重試
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * attempt));
      }

      const response = await fetch(LINE_PUSH_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${lineAccessToken}`,
        },
        body: JSON.stringify({
          to: targetLineUid,
          messages: [
            {
              type: 'text',
              text: message,
            },
          ],
        }),
      });

      if (!response.ok) {
        throw new Error(
          `LINE API returned ${response.status}: ${await response.text()}`
        );
      }

      // 成功
      if (notificationId) {
        await supabase
          .from('notifications_log')
          .update({
            status: 'sent',
            sent_at: new Date().toISOString(),
            retry_count: attempt,
          })
          .eq('id', notificationId);
      }

      console.log(
        `[LINE Push] ✓ Message sent to ${targetLineUid} (attempt ${attempt + 1})`
      );
      return true;
    } catch (error) {
      lastError = error;
      retryCount = attempt + 1;
      console.warn(
        `[LINE Push] ✗ Failed attempt ${attempt + 1}/${MAX_RETRIES + 1}: ${error.message}`
      );

      // 最後一次失敗，記錄到 notifications_log
      if (attempt === MAX_RETRIES && notificationId) {
        await supabase
          .from('notifications_log')
          .update({
            status: 'failed',
            retry_count: retryCount,
            error_msg: lastError?.message || 'Unknown error',
          })
          .eq('id', notificationId);
      }
    }
  }

  console.error(
    `[LINE Push] All retries failed for ${targetLineUid}:`,
    lastError
  );
  return false;
};

/**
 * 驗證 LINE Webhook 簽名
 * 使用 HMAC SHA256
 */
export const verifyLineSignature = async (body, signature, channelSecret) => {
  if (!signature || !channelSecret) {
    return false;
  }

  const crypto = (await import('crypto')).default;
  const hmac = crypto.createHmac('sha256', channelSecret);
  hmac.update(body);
  const hash = hmac.digest('base64');

  return hash === signature;
};

export default { sendLinePush, verifyLineSignature };
