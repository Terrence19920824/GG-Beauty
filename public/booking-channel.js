(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ggBookingChannel = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';

  const CHANNELS = Object.freeze([
    'whatsapp',
    'instagram',
    'tiktok',
    'xiaohongshu',
    'douyin',
    'google',
    'website'
  ]);
  const CHANNEL_SET = new Set(CHANNELS);
  const STORAGE_PREFIX = 'gg_booking_channel:';
  const MAX_CHANNEL_LENGTH = 32;
  const memoryStorage = new Map();

  function normalize(value) {
    if (typeof value !== 'string' || value.length > MAX_CHANNEL_LENGTH) return null;
    const normalized = value.trim().toLowerCase();
    return CHANNEL_SET.has(normalized) ? normalized : null;
  }

  function storageKey(shopSlug) {
    if (typeof shopSlug !== 'string' || !shopSlug.trim()) return null;
    return `${STORAGE_PREFIX}${encodeURIComponent(shopSlug.trim().toLowerCase())}`;
  }

  function safeGet(storage, key) {
    if (!key) return null;
    try {
      const stored = storage && storage.getItem(key);
      if (stored !== null && stored !== undefined) return stored;
    } catch (_error) {}
    return memoryStorage.get(key) || null;
  }

  function safeSet(storage, key, value) {
    if (!key) return;
    memoryStorage.set(key, value);
    try { if (storage) storage.setItem(key, value); } catch (_error) {}
  }

  function safeRemove(storage, key) {
    if (!key) return;
    memoryStorage.delete(key);
    try { if (storage) storage.removeItem(key); } catch (_error) {}
  }

  function readForShop(storage, shopSlug) {
    const key = storageKey(shopSlug);
    const value = normalize(safeGet(storage, key));
    if (!value && key) safeRemove(storage, key);
    return value;
  }

  function writeForShop(storage, shopSlug, channel) {
    const key = storageKey(shopSlug);
    const value = normalize(channel);
    if (!key || !value) return null;
    safeSet(storage, key, value);
    return value;
  }

  function clearForShop(storage, shopSlug) {
    safeRemove(storage, storageKey(shopSlug));
  }

  function locationUrl(locationLike) {
    if (!locationLike) return null;
    const href = typeof locationLike.href === 'string' ? locationLike.href : '';
    if (!href) return null;
    try {
      return new URL(href, 'http://booking.local');
    } catch (_error) {
      return null;
    }
  }

  function cleanCapturedChannel(url, historyLike) {
    if (!historyLike || typeof historyLike.replaceState !== 'function') return;
    url.searchParams.delete('channel');
    const relativeUrl = `${url.pathname}${url.search}${url.hash}`;
    try { historyLike.replaceState(historyLike.state || null, '', relativeUrl); } catch (_error) {}
  }

  function captureFromLocation({ locationLike, historyLike, storage, shopSlug } = {}) {
    const existing = readForShop(storage, shopSlug);
    const url = locationUrl(locationLike);
    if (!url) return existing;

    const values = url.searchParams.getAll('channel');
    if (values.length !== 1) return existing;
    const channel = normalize(values[0]);
    if (!channel) return existing;

    const stored = writeForShop(storage, shopSlug, channel);
    if (!stored) return existing;
    cleanCapturedChannel(url, historyLike);
    return stored;
  }

  return Object.freeze({
    CHANNELS,
    MAX_CHANNEL_LENGTH,
    normalize,
    storageKey,
    readForShop,
    writeForShop,
    clearForShop,
    captureFromLocation
  });
});
