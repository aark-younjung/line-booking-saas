import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { supabase } from '../lib/supabase.js';

const router = express.Router();

/**
 * GET /api/superadmin/tenants
 * 取得所有租戶（Super Admin 只用）
 */
router.get('/tenants', async (req, res) => {
  try {
    const { data: tenants, error } = await supabase
      .from('tenants')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      throw error;
    }

    res.json({
      success: true,
      data: tenants,
    });
  } catch (error) {
    console.error('[SuperAdmin] Error fetching tenants:', error);
    res.status(500).json({
      error: 'Failed to fetch tenants',
      details: error.message,
    });
  }
});

/**
 * POST /api/superadmin/tenants
 * 建立新租戶（開通流程）
 * Body: {
 *   name: "店鋪名稱",
 *   plan: "starter|standard|advanced",
 *   ownerEmail: "owner@example.com",
 *   ownerName: "業主名稱",
 *   lineChannelId: "...",
 *   lineChannelSecret: "...",
 *   lineAccessToken: "..."
 * }
 */
router.post('/tenants', async (req, res) => {
  const {
    name,
    plan = 'starter',
    ownerEmail,
    ownerName,
    lineChannelId,
    lineChannelSecret,
    lineAccessToken,
  } = req.body;

  if (!name || !ownerEmail || !ownerName) {
    return res.status(400).json({
      error: 'Missing required fields: name, ownerEmail, ownerName',
    });
  }

  try {
    // 1. 建立租戶
    const { data: tenant, error: tenantError } = await supabase
      .from('tenants')
      .insert({
        name,
        plan,
        status: 'active',
        line_channel_id: lineChannelId || null,
        line_channel_secret: lineChannelSecret || null,
        line_access_token: lineAccessToken || null,
      })
      .select()
      .single();

    if (tenantError) {
      throw tenantError;
    }

    // 2. 建立業主帳號
    const ownerPassword = uuidv4(); // 臨時密碼，應透過郵件發送
    const { data: owner, error: ownerError } = await supabase
      .from('owners')
      .insert({
        tenant_id: tenant.id,
        email: ownerEmail,
        password_hash: ownerPassword, // 實際上應加密，Phase 4 補上
        name: ownerName,
      })
      .select()
      .single();

    if (ownerError) {
      throw ownerError;
    }

    console.log(`[SuperAdmin] Created tenant: ${tenant.id} with owner: ${owner.id}`);

    res.json({
      success: true,
      data: {
        tenant,
        owner,
        tempPassword: ownerPassword,
      },
    });
  } catch (error) {
    console.error('[SuperAdmin] Error creating tenant:', error);
    res.status(500).json({
      error: 'Failed to create tenant',
      details: error.message,
    });
  }
});

/**
 * PATCH /api/superadmin/tenants/:id
 * 更新租戶設定（降級、升級、暫停等）
 */
router.patch('/tenants/:id', async (req, res) => {
  const { id: tenantId } = req.params;
  const { plan, status } = req.body;

  if (!plan && !status) {
    return res.status(400).json({
      error: 'No update fields provided',
    });
  }

  try {
    const updateData = {};
    if (plan) updateData.plan = plan;
    if (status) updateData.status = status;

    const { data: tenant, error } = await supabase
      .from('tenants')
      .update(updateData)
      .eq('id', tenantId)
      .select()
      .single();

    if (error) {
      throw error;
    }

    console.log(`[SuperAdmin] Updated tenant: ${tenantId}`);

    res.json({
      success: true,
      data: tenant,
    });
  } catch (error) {
    console.error('[SuperAdmin] Error updating tenant:', error);
    res.status(500).json({
      error: 'Failed to update tenant',
      details: error.message,
    });
  }
});

/**
 * GET /api/superadmin/tenants/:id/stats
 * 取得租戶統計資訊
 */
router.get('/tenants/:id/stats', async (req, res) => {
  const { id: tenantId } = req.params;

  try {
    // 取得總預約數
    const { data: bookings, error: bookingsError } = await supabase
      .from('bookings')
      .select('id, status')
      .eq('tenant_id', tenantId);

    // 取得客戶數
    const { data: customers, error: customersError } = await supabase
      .from('customers')
      .select('id')
      .eq('tenant_id', tenantId);

    // 取得課程數
    const { data: courses, error: coursesError } = await supabase
      .from('courses')
      .select('id')
      .eq('tenant_id', tenantId);

    if (bookingsError || customersError || coursesError) {
      throw bookingsError || customersError || coursesError;
    }

    const stats = {
      total_bookings: bookings?.length || 0,
      confirmed_bookings: bookings?.filter((b) => b.status === 'confirmed').length || 0,
      pending_bookings: bookings?.filter((b) => b.status === 'pending_payment' || b.status === 'pending_confirmation').length || 0,
      total_customers: customers?.length || 0,
      total_courses: courses?.length || 0,
    };

    res.json({
      success: true,
      data: stats,
    });
  } catch (error) {
    console.error('[SuperAdmin] Error fetching stats:', error);
    res.status(500).json({
      error: 'Failed to fetch stats',
      details: error.message,
    });
  }
});

export default router;
