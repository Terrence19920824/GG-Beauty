(function (root, factory) {
  const shared = typeof module === 'object' && module.exports
    ? require('./shared-i18n')
    : root && root.ggI18n;
  const api = factory(shared);
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.ggServiceLocale = api;
  }
})(typeof globalThis === 'object' ? globalThis : this, function (shared) {
  'use strict';
  return shared;
});
