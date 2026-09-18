(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ggCustomerMultiServiceCart = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const API_VERSION = '2.0.0';
  let nextKey = 1;
  const create = () => [];
  const hasService = (cart, serviceId) => Array.isArray(cart) && cart.some(item => item.serviceId === serviceId);
  const add = (cart, service) => {
    if (!service || typeof service.id !== 'string' || !service.id.trim()) return Array.isArray(cart) ? cart : [];
    const sourceCart = Array.isArray(cart) ? cart : [];
    if (hasService(sourceCart, service.id)) return sourceCart;
    return sourceCart.concat({
      clientItemKey: `cart-${nextKey++}`,
      categoryId: service.categoryId || service.category_id || '',
      serviceId: service.id,
      staffSelectionType: 'no_preference',
      staffId: null
    });
  };
  const remove = (cart, key) => (Array.isArray(cart) ? cart.filter(item => item.clientItemKey !== key) : []);
  const updateStaff = (cart, key, selectionType, staffId) => (Array.isArray(cart) ? cart.map(item => item.clientItemKey === key ? { ...item, staffSelectionType: selectionType, staffId: selectionType === 'specific' ? staffId : null } : item) : []);
  const reconcile = (cart, services) => {
    const validIds = new Set((Array.isArray(services) ? services : []).map(service => service.id));
    return (Array.isArray(cart) ? cart : []).filter(item => validIds.has(item.serviceId));
  };
  const totals = (cart, services) => {
    const byId = new Map((Array.isArray(services) ? services : []).map(service => [service.id, service]));
    return (Array.isArray(cart) ? cart : []).reduce((result, item) => {
      const service = byId.get(item.serviceId);
      if (service) {
        result.durationMinutes += Number(service.durationMinutes || service.duration_minutes || 0);
        result.listedPrice += Number(service.price || 0);
        result.priceIsFrom ||= service.priceIsFrom === true || service.price_is_from === true;
      }
      return result;
    }, { durationMinutes: 0, listedPrice: 0, priceIsFrom: false });
  };
  const requestItems = cart => (Array.isArray(cart) ? cart.map(({ clientItemKey, serviceId, staffSelectionType, staffId }) => ({ clientItemKey, serviceId, staffSelectionType, ...(staffSelectionType === 'specific' ? { staffId } : {}) })) : []);
  const fingerprint = cart => (Array.isArray(cart) ? cart.map(item => `${item.clientItemKey}:${item.serviceId}:${item.staffSelectionType}:${item.staffId || ''}`).join(';') : '');
  return Object.freeze({
    version: API_VERSION,
    apiVersion: API_VERSION,
    create,
    add,
    remove,
    updateStaff,
    totals,
    requestItems,
    hasService,
    reconcile,
    fingerprint
  });
});
