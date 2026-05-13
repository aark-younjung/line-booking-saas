import { supabase } from '../lib/supabase.js';

// 簡易記憶體快取（租戶資料，TTL=60秒）
const tenantCache = new Map();
const CACHE_TTL_MS = 60 * 1000; // 60 秒

export const getTenantById = async (tenantId) => {
  // 先檢查快取
  const cached = tenantCache.get(tenantId);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.data;
  }

  // 快取無效或不存在，從 DB 查詢
  const { data, error } = await supabase
    .from('tenants')
    .select('*')
    .eq('id', tenantId)
    .single();

  if (error) {
    console.error(`[Tenant] Error fetching tenant ${tenantId}:`, error);
    return null;
  }

  // 儲存到快取
  tenantCache.set(tenantId, {
    data,
    timestamp: Date.now(),
  });

  return data;
};

/**
 * 多租戶驗證中間件
 * 確保所有請求都來自有效的租戶
 */
export const verifyTenant = async (req, res, next) => {
  const tenantId = req.params.tenantId || req.query.tenantId || req.headers['x-tenant-id'];

  if (!tenantId) {
    return res.status(400).json({
      error: 'Missing tenant_id in URL param, query, or header',
    });
  }

  // 驗證租戶存在且狀態為 active
  const tenant = await getTenantById(tenantId);
  if (!tenant) {
    return res.status(404).json({
      error: 'Tenant not found',
    });
  }

  if (tenant.status !== 'active') {
    return res.status(403).json({
      error: `Tenant status is ${tenant.status}, not active`,
    });
  }

  // 將租戶資料附加到 req
  req.tenant = tenant;
  next();
};

export default { verifyTenant, getTenantById };
