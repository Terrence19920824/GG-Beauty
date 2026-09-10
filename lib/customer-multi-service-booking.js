'use strict';

const MAX_ITEMS = 8;
const MAX_CANDIDATES_PER_ITEM = 100;
const MAX_SEARCH_NODES = 2048;

class MultiServicePlanningError extends Error {
  constructor(code) {
    super(code);
    this.name = 'MultiServicePlanningError';
    this.code = code;
  }
}

const normalizeBookingItems = (body, isUuid) => {
  const source = Array.isArray(body.items)
    ? body.items
    : [{
        serviceId: body.serviceId,
        staffSelectionType: body.staffSelectionType || (body.staffId ? 'specific' : undefined),
        staffId: body.staffId
      }];
  if (!source.length || source.length > MAX_ITEMS) throw new MultiServicePlanningError('BOOKING_ITEMS_INVALID');
  return source.map((item, index) => {
    const selection = item && item.staffSelectionType;
    if (!item || !isUuid(item.serviceId) || !['specific', 'no_preference'].includes(selection)) {
      throw new MultiServicePlanningError('BOOKING_ITEMS_INVALID');
    }
    if (selection === 'specific' && !isUuid(item.staffId)) throw new MultiServicePlanningError('BOOKING_ITEMS_INVALID');
    return {
      clientItemKey: typeof item.clientItemKey === 'string' ? item.clientItemKey.slice(0, 100) : `item-${index + 1}`,
      serviceId: item.serviceId,
      staffSelectionType: selection,
      staffId: selection === 'specific' ? item.staffId : null
    };
  });
};

const buildSequentialTimeline = (services, startAt) => {
  let cursor = new Date(startAt).getTime();
  if (!Number.isFinite(cursor)) throw new MultiServicePlanningError('BOOKING_START_INVALID');
  return services.map((service, index) => {
    const duration = Number(service.duration_minutes);
    if (!Number.isInteger(duration) || duration <= 0) throw new MultiServicePlanningError('SERVICE_DURATION_INVALID');
    const itemStart = cursor;
    cursor += duration * 60000;
    return { ...service, sequenceNo: index + 1, startAt: new Date(itemStart).toISOString(), endAt: new Date(cursor).toISOString() };
  });
};

const planStaffAssignments = async ({ items, candidatesByService, validate, maxNodes = MAX_SEARCH_NODES }) => {
  let nodes = 0;
  const chosen = [];
  const visit = async index => {
    if (index === items.length) return chosen.slice();
    const item = items[index];
    const candidates = item.staffSelectionType === 'specific'
      ? [{ staff_id: item.staffId }]
      : (candidatesByService.get(item.serviceId) || []).slice(0, MAX_CANDIDATES_PER_ITEM);
    for (const candidate of candidates) {
      nodes += 1;
      if (nodes > maxNodes) throw new MultiServicePlanningError('ASSIGNMENT_SEARCH_LIMIT');
      try {
        await validate(item, candidate.staff_id, chosen.slice());
      } catch (error) {
        if (error && error.unavailable === true) continue;
        throw error;
      }
      chosen.push({ ...item, staffId: candidate.staff_id, staffDisplayName: candidate.display_name || null });
      const result = await visit(index + 1);
      if (result) return result;
      chosen.pop();
    }
    return null;
  };
  return visit(0);
};

const cartTotals = items => ({
  durationMinutes: items.reduce((sum, item) => sum + Number(item.durationMinutes || 0), 0),
  listedPrice: items.reduce((sum, item) => sum + Number(item.price || 0), 0),
  priceIsFrom: items.some(item => item.priceIsFrom === true)
});

module.exports = {
  MAX_ITEMS,
  MultiServicePlanningError,
  normalizeBookingItems,
  buildSequentialTimeline,
  planStaffAssignments,
  cartTotals
};
