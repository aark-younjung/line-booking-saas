import express from 'express';
import crypto from 'crypto';
import { supabase } from '../lib/supabase.js';
import { getTenantById } from '../middleware/tenant.js';

const router = express.Router();

/**
 * 驗證 LINE Webhook 簽名
 */
const verifyLineSignature = (body, signature, channelSecret) => {
  if (!signature || !channelSecret) {
    return false;
  }

  const hmac = crypto.createHmac('sha256', channelSecret);
  hmac.update(body);
  const hash = hmac.digest('base64');

  return hash === signature;
};

/**
 * POST /api/webhook/:tenantId
 * 接收 LINE Webhook 事件
 * 支援的事件：message, follow, unfollow, join, leave
 */
router.post('/:tenantId', express.raw({ type: 'application/json' }), async (req, res) => {
  const tenantId = req.params.tenantId;
  const signature = req.headers['x-line-signature'];
  const bodyStr = req.body.toString('utf-8');

  console.log(`[Webhook] Received event for tenant: ${tenantId}`);

  // ⚡ 立即回應 200 OK，LINE 不會超時
  res.status(200).json({ success: true });

  // 異步處理事件（不阻塞回應）
  try {
    // 1. 驗證租戶存在
    const tenant = await getTenantById(tenantId);
    if (!tenant) {
      console.warn(`[Webhook] Tenant not found: ${tenantId}`);
      return;
    }

    // 2. 解析 Webhook Body
    let events;
    try {
      const bodyJson = JSON.parse(bodyStr);
      events = bodyJson.events || [];
    } catch (error) {
      console.error(`[Webhook] Failed to parse JSON:`, error);
      return;
    }

    // Verify 測試時 events 為空陣列，直接結束
    if (events.length === 0) {
      console.log(`[Webhook] Verify request received (empty events)`);
      return;
    }

    // 3. 驗證簽名（僅在有真實事件時驗證）
    if (!verifyLineSignature(bodyStr, signature, tenant.line_channel_secret)) {
      console.warn(`[Webhook] Invalid signature for tenant: ${tenantId}`);
      return;
    }

    // 4. 處理所有事件
    for (const event of events) {
      console.log(`[Webhook] Processing event type: ${event.type} for user: ${event.source.userId}`);

      switch (event.type) {
        case 'message':
          await handleMessageEvent(event, tenant, tenantId);
          break;

        case 'follow':
          await handleFollowEvent(event, tenant, tenantId);
          break;

        case 'unfollow':
          console.log(`[Webhook] User unfollowed: ${event.source.userId}`);
          break;

        case 'join':
          console.log(`[Webhook] Bot joined group/room: ${event.source.groupId || event.source.roomId}`);
          break;

        case 'leave':
          console.log(`[Webhook] Bot left group/room`);
          break;

        default:
          console.log(`[Webhook] Unhandled event type: ${event.type}`);
      }
    }
  } catch (error) {
    console.error(`[Webhook] Unexpected error processing events:`, error);
  }
});

/**
 * 處理訊息事件（回復模板）
 */
async function handleMessageEvent(event, tenant, tenantId) {
  const userId = event.source.userId;
  const message = event.message;

  // 目前僅回覆簡單訊息，實際選課流程在 LIFF 中進行
  if (message.type === 'text') {
    const text = message.text.toLowerCase();

    // 簡單的路由邏輯
    if (text.includes('課程') || text.includes('預約')) {
      // 回覆訊息（實際上應該透過 LIFF 完成）
      await replyLineMessage(
        event.replyToken,
        tenant.line_access_token,
        '👋 歡迎使用預約系統！請點擊下方選單開始預約課程。'
      );
    } else if (text.includes('訂單') || text.includes('查詢')) {
      await replyLineMessage(
        event.replyToken,
        tenant.line_access_token,
        '📋 您可以在 LIFF 中查詢自己的訂單。請點擊下方選單。'
      );
    } else {
      // 預設回覆
      await replyLineMessage(
        event.replyToken,
        tenant.line_access_token,
        '感謝您的訊息！請使用下方選單進行預約。'
      );
    }
  }
}

/**
 * 處理追蹤事件
 */
async function handleFollowEvent(event, tenant, tenantId) {
  const userId = event.source.userId;

  console.log(`[Webhook] User followed: ${userId}`);

  // 建立或更新客戶記錄
  const { data, error } = await supabase
    .from('customers')
    .upsert(
      {
        tenant_id: tenantId,
        line_uid: userId,
        created_at: new Date().toISOString(),
      },
      {
        onConflict: 'tenant_id,line_uid',
      }
    )
    .select()
    .single();

  if (error) {
    console.error(`[Webhook] Failed to create/update customer:`, error);
    return;
  }

  console.log(`[Webhook] Customer record upserted: ${data.id}`);

  // 歡迎訊息
  await replyLineMessage(
    event.replyToken,
    tenant.line_access_token,
    '👋 歡迎關注！我們是蘇莉花藝。請使用下方選單進行課程預約。'
  );
}

/**
 * 回覆 LINE 訊息
 */
async function replyLineMessage(replyToken, accessToken, text) {
  try {
    const response = await fetch('https://api.line.me/v2/bot/message/reply', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        replyToken,
        messages: [
          {
            type: 'text',
            text,
          },
        ],
      }),
    });

    if (!response.ok) {
      throw new Error(`LINE API returned ${response.status}`);
    }

    console.log(`[Webhook] Reply sent successfully`);
  } catch (error) {
    console.error(`[Webhook] Failed to send reply:`, error);
  }
}

export default router;
