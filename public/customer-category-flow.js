(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ggCustomerCategoryFlow = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const CATEGORY_ICONS = Object.freeze({
    hair: '✂', beauty: '◇', 'nails-lashes': '✦', 'body-wellness': '◌',
    'skin-care': '◍', 'tcm-tuina': '☯', 'pet-services': '♢',
    'personal-training': '◈', pmu: '✧'
  });

  function deriveEntryState(categories, currentCategoryId) {
    const rows = Array.isArray(categories) ? categories : [];
    const currentIsValid = rows.some(category => category.categoryId === currentCategoryId);
    const selectedCategoryId = currentIsValid
      ? currentCategoryId
      : rows.length === 1 ? rows[0].categoryId : '';
    return {
      selectedCategoryId,
      showCategoryCards: rows.length >= 2,
      showBookingStep: Boolean(selectedCategoryId),
      isEmpty: rows.length === 0
    };
  }

  function filterServicesByCategory(services, categoryId) {
    return (Array.isArray(services) ? services : [])
      .filter(service => service.categoryId === categoryId);
  }

  function categoryIcon(iconKey) {
    return CATEGORY_ICONS[iconKey] || '◇';
  }

  return { deriveEntryState, filterServicesByCategory, categoryIcon };
});
