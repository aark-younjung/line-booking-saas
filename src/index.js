import express from 'express';
import dotenv from 'dotenv';
import { verifyTenant } from './middleware/tenant.js';
import webhookRouter from './routes/webhook.js';
import coursesRouter from './routes/courses.js';
import bookingsRouter from './routes/bookings.js';
import superadminRouter from './routes/superadmin.js';
import adminRouter from './routes/admin.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';

// ============================================================
// 中間件
// ============================================================

// CORS（跨域支援，允許 LIFF 前端從不同 origin 呼叫）
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Line-Signature, ngrok-skip-browser-warning');
  // 處理 preflight OPTIONS 請求
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  next();
});

// 日誌記錄
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// JSON 解析（webhook 路由除外，因為需要 raw body 做簽名驗證）
app.use((req, res, next) => {
  if (req.path.startsWith('/api/webhook')) {
    // Webhook 路由跳過 JSON 自動解析，使用 express.raw() 取得原始 Buffer
    return next();
  }
  express.json()(req, res, next);
});

// ============================================================
// 路由
// ============================================================

// 健康檢查
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    environment: NODE_ENV,
  });
});

// LINE Webhook（不需要租戶驗證，已在路由內部驗證）
app.use('/api/webhook', webhookRouter);

// 課程相關（租戶驗證在路由內部處理）
app.use('/api/courses', coursesRouter);

// 預約相關（租戶驗證在路由內部處理）
app.use('/api/bookings', bookingsRouter);

// Super Admin（暫時不驗證，Phase 4 補上）
app.use('/api/superadmin', superadminRouter);

// 業主後台（Owner Dashboard）
app.use('/api/admin', adminRouter);

// ============================================================
// 錯誤處理
// ============================================================

// 404 處理
app.use((req, res) => {
  res.status(404).json({
    error: 'Not Found',
    path: req.path,
  });
});

// 全域錯誤處理
app.use((err, req, res, next) => {
  console.error('[Error]', err);
  res.status(err.status || 500).json({
    error: err.message || 'Internal Server Error',
  });
});

// ============================================================
// 啟動伺服器
// ============================================================

app.listen(PORT, () => {
  console.log(`[${NODE_ENV.toUpperCase()}] Server running on http://localhost:${PORT}`);
  console.log(`[${NODE_ENV.toUpperCase()}] Health check: http://localhost:${PORT}/health`);
  console.log(`[${NODE_ENV.toUpperCase()}] Webhook endpoint: /api/webhook/:tenantId`);
});
