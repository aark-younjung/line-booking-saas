/**
 * 教室人數上限（同一時間共用）
 *
 * 體驗課與正式班是同一堂課、同一間教室，但系統把它們當成兩門獨立課程，
 * 各算各的人數。這裡補上「同一租戶 + 同一開始時間 = 同一間教室」的概念：
 * 該時間所有課程的報名人數加總，不得超過 tenants.room_capacity。
 *
 * 好處：業主不必再手動調整各課程容量。正式班有人請假改期釋出名額時，
 * 體驗課的可報名數會自動跟著變多。
 *
 * room_capacity = 0 代表不限制，行為與加這個功能之前完全相同。
 */
import { supabase } from './supabase.js';

/** 取得租戶的教室上限（0 = 不限制） */
export async function getRoomCapacity(tenantId) {
  const { data } = await supabase
    .from('tenants')
    .select('room_capacity')
    .eq('id', tenantId)
    .single();
  return data?.room_capacity || 0;
}

/**
 * 查某個時間點整間教室的使用狀況。
 * @returns { limit, used, remaining, slots }
 *          limit = 0 時 remaining 回 Infinity（不限制）
 */
export async function getRoomUsage(tenantId, startAt, limitOverride = null) {
  const limit = limitOverride !== null ? limitOverride : await getRoomCapacity(tenantId);

  const { data: slots } = await supabase
    .from('time_slots')
    .select('id, booked_count, capacity, course:course_id(name)')
    .eq('tenant_id', tenantId)
    .eq('start_at', startAt)
    .eq('is_active', true);

  const used = (slots || []).reduce((sum, s) => sum + (s.booked_count || 0), 0);
  return {
    limit,
    used,
    remaining: limit > 0 ? Math.max(0, limit - used) : Infinity,
    slots: slots || []
  };
}

/**
 * 這個時段還能不能再收一個人？
 * 同時受兩個限制：該時段自己的 capacity，以及整間教室的 room_capacity。
 */
export async function canTakeOneMore(tenantId, slot, limitOverride = null) {
  if (slot.booked_count >= slot.capacity) {
    return { ok: false, reason: '此時段已額滿' };
  }
  const room = await getRoomUsage(tenantId, slot.start_at, limitOverride);
  if (room.remaining <= 0) {
    return { ok: false, reason: '這個時間教室已滿' };
  }
  return { ok: true };
}

/**
 * 批次版本：一次算多個時段（課程包要一次選 N 堂時用）。
 * 回傳 Map<start_at, remaining>，避免對同一時間重複查詢。
 */
export async function getRoomRemainingMap(tenantId, startAts, limitOverride = null) {
  const limit = limitOverride !== null ? limitOverride : await getRoomCapacity(tenantId);
  const map = new Map();
  if (limit <= 0) {
    for (const t of startAts) map.set(t, Infinity);
    return map;
  }

  const uniq = [...new Set(startAts)];
  const { data: slots } = await supabase
    .from('time_slots')
    .select('start_at, booked_count')
    .eq('tenant_id', tenantId)
    .in('start_at', uniq)
    .eq('is_active', true);

  const usedBy = {};
  for (const s of slots || []) {
    usedBy[s.start_at] = (usedBy[s.start_at] || 0) + (s.booked_count || 0);
  }
  for (const t of uniq) map.set(t, Math.max(0, limit - (usedBy[t] || 0)));
  return map;
}
