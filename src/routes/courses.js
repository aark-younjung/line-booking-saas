import express from 'express';
import { supabase } from '../lib/supabase.js';

const router = express.Router();

/**
 * GET /api/courses/:tenantId
 * 取得租戶的所有課程
 */
router.get('/:tenantId', async (req, res) => {
  const { tenantId } = req.params;

  try {
    const { data: courses, error } = await supabase
      .from('courses')
      .select('*')
      .eq('tenant_id', tenantId)
      .eq('is_active', true)
      .order('sort_order', { ascending: true });

    if (error) {
      throw error;
    }

    res.json({
      success: true,
      data: courses,
    });
  } catch (error) {
    console.error('[Courses] Error fetching courses:', error);
    res.status(500).json({
      error: 'Failed to fetch courses',
      details: error.message,
    });
  }
});

/**
 * GET /api/courses/:tenantId/:courseId/slots
 * 取得某課程的所有可預約時段
 * 可選 Query：
 * - startDate: YYYY-MM-DD (預設今天)
 * - endDate: YYYY-MM-DD (預設 7 天後)
 */
router.get('/:tenantId/:courseId/slots', async (req, res) => {
  const { tenantId, courseId } = req.params;
  let { startDate, endDate } = req.query;

  try {
    // 預設日期範圍
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    startDate = startDate || today.toISOString().split('T')[0];

    const sevenDaysLater = new Date(today);
    sevenDaysLater.setDate(sevenDaysLater.getDate() + 7);
    endDate = endDate || sevenDaysLater.toISOString().split('T')[0];

    // 確保課程屬於此租戶
    const { data: course, error: courseError } = await supabase
      .from('courses')
      .select('id')
      .eq('tenant_id', tenantId)
      .eq('id', courseId)
      .single();

    if (courseError || !course) {
      return res.status(404).json({
        error: 'Course not found',
      });
    }

    // 查詢時段
    const { data: slots, error: slotsError } = await supabase
      .from('time_slots')
      .select('*')
      .eq('tenant_id', tenantId)
      .eq('course_id', courseId)
      .eq('is_active', true)
      .gte('start_at', `${startDate}T00:00:00Z`)
      .lte('start_at', `${endDate}T23:59:59Z`)
      .order('start_at', { ascending: true });

    if (slotsError) {
      throw slotsError;
    }

    // 計算可用名額
    const slotsWithAvailability = slots.map((slot) => ({
      ...slot,
      available_seats: Math.max(0, slot.capacity - slot.booked_count),
      is_available: slot.capacity > slot.booked_count,
    }));

    res.json({
      success: true,
      data: slotsWithAvailability,
    });
  } catch (error) {
    console.error('[Slots] Error fetching slots:', error);
    res.status(500).json({
      error: 'Failed to fetch time slots',
      details: error.message,
    });
  }
});

export default router;
