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

  const OTHER_CATEGORY_ID = '__other__';

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

  let lastKnownCategories = [];

  function filterServicesByCategory(services, categoryId, categories = lastKnownCategories) {
    const list = Array.isArray(services) ? services : [];
    if (!categoryId) return list;
    if (categoryId === OTHER_CATEGORY_ID) {
      const activeCats = (Array.isArray(categories) && categories.length > 0) ? categories : lastKnownCategories;
      const knownIds = new Set(activeCats.map(c => (typeof c === 'object' && c ? c.categoryId : c)));
      return list.filter(service => !service.categoryId || !knownIds.has(service.categoryId));
    }
    return list.filter(service => service.categoryId === categoryId);
  }

  function categoryIcon(iconKey) {
    return CATEGORY_ICONS[iconKey] || '◇';
  }

  function deriveTabsState(categories, currentCategoryId, services, options = {}) {
    const rows = Array.isArray(categories) ? categories : [];
    lastKnownCategories = rows;
    const serviceList = Array.isArray(services) ? services : [];
    const knownCategoryIds = new Set(rows.map(c => c.categoryId));

    const hasOrphanServices = rows.length > 0 && serviceList.some(s => !s.categoryId || !knownCategoryIds.has(s.categoryId));

    let effectiveCategories = rows;
    if (hasOrphanServices) {
      const otherLabel = (options && options.locale === 'zh-CN') ? '其他' : 'Other';
      effectiveCategories = [
        ...rows,
        {
          categoryId: OTHER_CATEGORY_ID,
          name: otherLabel,
          iconKey: 'other',
          isOther: true
        }
      ];
    }

    const currentIsValid = effectiveCategories.some(category => category.categoryId === currentCategoryId);
    const selectedCategoryId = currentIsValid
      ? currentCategoryId
      : effectiveCategories.length > 0 ? effectiveCategories[0].categoryId : '';

    return {
      selectedCategoryId,
      showTabs: effectiveCategories.length >= 2,
      showCategoryCards: effectiveCategories.length >= 2,
      showBookingStep: true,
      isEmpty: effectiveCategories.length === 0 && serviceList.length === 0,
      categories: effectiveCategories,
      hasOrphanServices
    };
  }

  return { deriveEntryState, deriveTabsState, filterServicesByCategory, categoryIcon, OTHER_CATEGORY_ID };
});
