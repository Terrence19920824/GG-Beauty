(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.ggServiceLocale = api;
  }
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';

  const DEFAULT_LOCALE = 'en';

  function normalizeLocale(value) {
    if (typeof value !== 'string') return DEFAULT_LOCALE;
    const normalized = value.trim().toLowerCase();
    return normalized === 'zh' || normalized.startsWith('zh-')
      ? 'zh-CN'
      : DEFAULT_LOCALE;
  }

  function browserLocale(navigatorLike) {
    const languages = Array.isArray(navigatorLike && navigatorLike.languages)
      ? navigatorLike.languages
      : [navigatorLike && navigatorLike.language];
    const chinese = languages.find(language =>
      typeof language === 'string' && language.toLowerCase().startsWith('zh')
    );
    return chinese ? 'zh-CN' : DEFAULT_LOCALE;
  }

  function resolveLocalizedService(service, requestedLocale) {
    const locale = normalizeLocale(requestedLocale);
    const translations = service && service.translations
      ? service.translations
      : {};
    const requested = translations[locale] || {};
    const english = translations.en || {};
    const chinese = translations['zh-CN'] || {};
    const canonicalName = service && (service.canonicalName || service.name) || '';
    const canonicalDescription = service && (service.canonicalDescription || service.description) || null;
    return {
      locale,
      name: requested.name || english.name || chinese.name || canonicalName,
      description: requested.description || english.description || chinese.description || canonicalDescription
    };
  }

  return {
    DEFAULT_LOCALE,
    STORAGE_KEY: 'gg_beauty_locale',
    normalizeLocale,
    browserLocale,
    resolveLocalizedService
  };
});
