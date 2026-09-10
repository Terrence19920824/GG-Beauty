(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ggCustomerMultiServiceCart = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  let nextKey = 1;
  const create = () => [];
  const add = (cart, service) => cart.concat({ clientItemKey: `cart-${nextKey++}`, categoryId: service.categoryId, serviceId: service.id, staffSelectionType: 'no_preference', staffId: null });
  const remove = (cart, key) => cart.filter(item => item.clientItemKey !== key);
  const updateStaff = (cart, key, selectionType, staffId) => cart.map(item => item.clientItemKey === key ? { ...item, staffSelectionType: selectionType, staffId: selectionType === 'specific' ? staffId : null } : item);
  const totals = (cart, services) => { const byId = new Map(services.map(service => [service.id, service])); return cart.reduce((result, item) => { const service = byId.get(item.serviceId); if (service) { result.durationMinutes += Number(service.durationMinutes); result.listedPrice += Number(service.price); result.priceIsFrom ||= service.priceIsFrom === true; } return result; }, { durationMinutes: 0, listedPrice: 0, priceIsFrom: false }); };
  const requestItems = cart => cart.map(({ clientItemKey, serviceId, staffSelectionType, staffId }) => ({ clientItemKey, serviceId, staffSelectionType, ...(staffSelectionType === 'specific' ? { staffId } : {}) }));
  return { create, add, remove, updateStaff, totals, requestItems };
});
