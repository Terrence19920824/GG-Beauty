(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ggCustomerShopContext = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SHOP_QUERY_KEYS = ['shop', 'shopSlug'];
  const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

  function normalizeShopSlug(value) {
    if (typeof value !== 'string') return '';
    const slug = value.trim().toLowerCase();
    return slug.length <= 100 && SLUG_PATTERN.test(slug) ? slug : '';
  }

  function resolveCandidate(locationLike) {
    if (!locationLike) return '';

    const search = new URLSearchParams(locationLike.search || '');
    for (const key of SHOP_QUERY_KEYS) {
      if (search.has(key)) return normalizeShopSlug(search.get(key));
    }

    const pathMatch = String(locationLike.pathname || '').match(/^\/book\/([^/]+)\/?$/);
    if (pathMatch) return normalizeShopSlug(decodeURIComponent(pathMatch[1]));

    const hostname = String(locationLike.hostname || '').trim().toLowerCase();
    if (!hostname || hostname === 'localhost' || hostname === '127.0.0.1') return '';

    if (hostname.endsWith('.onrender.com')) {
      return normalizeShopSlug(hostname.slice(0, -'.onrender.com'.length));
    }

    const labels = hostname.split('.');
    if (labels.length >= 3 && labels[0] !== 'www') return normalizeShopSlug(labels[0]);
    return '';
  }

  return { normalizeShopSlug, resolveCandidate };
});
