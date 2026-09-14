(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ggCustomerTheme = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DEFAULT_THEME = Object.freeze({
    themeKey: 'classic-luxury',
    shopSlug: 'gg-beauty',
    brandName: 'GG-Beauty',
    logoText: 'GG',
    logoUrl: '',
    primaryColor: '#111111',
    primaryHover: '#2b2b2b',
    primaryContrast: '#ffffff',
    accentColor: '#111111',
    backgroundColor: '#f6f6f6',
    surfaceColor: '#ffffff',
    surfaceSubtle: '#eeeeee',
    textColor: '#222222',
    textMuted: '#777777',
    borderColor: '#dddddd',
    cardGradientStart: '#050505',
    cardGradientEnd: '#252525',
    cardTextColor: '#ffffff',
    cardMutedColor: '#bbbbbb'
  });

  // Strict color validation to prevent CSS injection and malformed style rules
  const HEX_COLOR_PATTERN = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
  const RGB_COLOR_PATTERN = /^rgba?\(\s*([0-9]{1,3}\s*,\s*){2}[0-9]{1,3}(\s*,\s*(0|1|0?\.[0-9]+))?\s*\)$/;
  const HSL_COLOR_PATTERN = /^hsla?\(\s*[0-9]{1,3}(deg)?\s*,\s*[0-9]{1,3}%\s*,\s*[0-9]{1,3}%(\s*,\s*(0|1|0?\.[0-9]+))?\s*\)$/;

  function isValidColor(value) {
    if (typeof value !== 'string') return false;
    const trimmed = value.trim();
    if (trimmed.length > 50 || /[\r\n;{}<>"']/.test(trimmed)) return false;
    return HEX_COLOR_PATTERN.test(trimmed) || RGB_COLOR_PATTERN.test(trimmed) || HSL_COLOR_PATTERN.test(trimmed);
  }

  function sanitizeColor(value, fallback) {
    return isValidColor(value) ? value.trim() : fallback;
  }

  function sanitizeString(value, maxLength, fallback = '') {
    if (typeof value !== 'string') return fallback;
    const trimmed = value.trim();
    if (!trimmed) return fallback;
    // Strip control characters and HTML delimiters
    const clean = trimmed.replace(/[\r\n\t<>]/g, '').slice(0, maxLength).trim();
    return clean || fallback;
  }

  function deriveInitials(name) {
    if (!name || typeof name !== 'string') return 'GG';
    const trimmed = name.trim();
    if (!trimmed) return 'GG';
    if (/^gg(?:-|\s|$)/i.test(trimmed)) return 'GG';
    // If name contains words separated by whitespace or hyphens
    const parts = trimmed.split(/[\s\-_\/]+/).filter(Boolean);
    if (parts.length >= 2) {
      return (parts[0][0] + parts[1][0]).toUpperCase();
    }
    // Single word / Chinese characters / short token
    return trimmed.slice(0, 2).toUpperCase();
  }

  function sanitizeUrl(value) {
    if (typeof value !== 'string') return '';
    const trimmed = value.trim();
    if (!trimmed) return '';
    if (/^(?:https?:\/\/|\/images\/|\/assets\/|\/uploads\/)[^<>"'\s]+$/i.test(trimmed)) {
      return trimmed;
    }
    return '';
  }

  // Built-in registry for shop theme presets to ensure multi-merchant isolation
  const registry = new Map();

  function registerShopTheme(shopSlug, themeConfig) {
    if (typeof shopSlug !== 'string' || !shopSlug.trim()) return;
    const normalizedSlug = shopSlug.trim().toLowerCase();
    registry.set(normalizedSlug, Object.freeze({ ...themeConfig }));
  }

  function getRegisteredTheme(shopSlug) {
    if (typeof shopSlug !== 'string') return null;
    return registry.get(shopSlug.trim().toLowerCase()) || null;
  }

  function clearRegistry() {
    registry.clear();
  }

  function normalizeThemeTokens(raw = {}, base = DEFAULT_THEME) {
    const brandName = sanitizeString(raw.brandName || raw.shopName, 100, base.brandName);
    const logoText = sanitizeString(raw.logoText, 4, deriveInitials(brandName));
    const logoUrl = sanitizeUrl(raw.logoUrl || raw.logo_url);
    const primaryColor = sanitizeColor(raw.primaryColor || raw.primary_color, base.primaryColor);
    const primaryHover = sanitizeColor(raw.primaryHover || raw.primary_hover, base.primaryHover);
    const primaryContrast = sanitizeColor(raw.primaryContrast || raw.primary_contrast, base.primaryContrast);
    const accentColor = sanitizeColor(raw.accentColor || raw.accent_color, primaryColor);
    const backgroundColor = sanitizeColor(raw.backgroundColor || raw.background_color, base.backgroundColor);
    const surfaceColor = sanitizeColor(raw.surfaceColor || raw.surface_color, base.surfaceColor);
    const surfaceSubtle = sanitizeColor(raw.surfaceSubtle || raw.surface_subtle, base.surfaceSubtle);
    const textColor = sanitizeColor(raw.textColor || raw.text_color, base.textColor);
    const textMuted = sanitizeColor(raw.textMuted || raw.text_muted, base.textMuted);
    const borderColor = sanitizeColor(raw.borderColor || raw.border_color, base.borderColor);
    const cardGradientStart = sanitizeColor(raw.cardGradientStart || raw.card_gradient_start, base.cardGradientStart);
    const cardGradientEnd = sanitizeColor(raw.cardGradientEnd || raw.card_gradient_end, base.cardGradientEnd);
    const cardTextColor = sanitizeColor(raw.cardTextColor || raw.card_text_color, base.cardTextColor);
    const cardMutedColor = sanitizeColor(raw.cardMutedColor || raw.card_muted_color, base.cardMutedColor);
    const themeKey = sanitizeString(raw.themeKey || raw.theme_key, 32, base.themeKey);

    return Object.freeze({
      themeKey,
      shopSlug: sanitizeString(raw.shopSlug, 100, base.shopSlug),
      brandName,
      logoText,
      logoUrl,
      primaryColor,
      primaryHover,
      primaryContrast,
      accentColor,
      backgroundColor,
      surfaceColor,
      surfaceSubtle,
      textColor,
      textMuted,
      borderColor,
      cardGradientStart,
      cardGradientEnd,
      cardTextColor,
      cardMutedColor
    });
  }

  function resolveTheme(shopSlug, options = {}) {
    const slug = typeof shopSlug === 'string' ? shopSlug.trim().toLowerCase() : '';
    const registered = registry.get(slug) || {};
    const overrides = options.overrides || {};

    const shopName = options.shopName || registered.brandName || registered.shopName || (slug === 'gg-beauty' ? 'GG-Beauty' : slug);
    const baseWithBrand = {
      ...DEFAULT_THEME,
      shopSlug: slug || DEFAULT_THEME.shopSlug,
      brandName: shopName || DEFAULT_THEME.brandName,
      logoText: deriveInitials(shopName)
    };

    const merged = {
      ...baseWithBrand,
      ...registered,
      ...overrides
    };

    if (options.shopName) merged.brandName = options.shopName;
    if (options.logoUrl) merged.logoUrl = options.logoUrl;

    return normalizeThemeTokens(merged, baseWithBrand);
  }

  function toCssVariables(tokens) {
    const t = tokens || DEFAULT_THEME;
    return Object.freeze({
      '--theme-primary': t.primaryColor,
      '--theme-primary-hover': t.primaryHover,
      '--theme-primary-contrast': t.primaryContrast,
      '--theme-accent': t.accentColor,
      '--theme-bg': t.backgroundColor,
      '--theme-surface': t.surfaceColor,
      '--theme-surface-subtle': t.surfaceSubtle,
      '--theme-text': t.textColor,
      '--theme-text-muted': t.textMuted,
      '--theme-border': t.borderColor,
      '--theme-card-start': t.cardGradientStart,
      '--theme-card-end': t.cardGradientEnd,
      '--theme-card-text': t.cardTextColor,
      '--theme-card-muted': t.cardMutedColor
    });
  }

  function applyTheme(target, themeTokens, options = {}) {
    if (!target) return null;
    const tokens = themeTokens || DEFAULT_THEME;
    const cssVars = toCssVariables(tokens);

    // Apply CSS variables to style
    if (target.style && typeof target.style.setProperty === 'function') {
      for (const [key, value] of Object.entries(cssVars)) {
        target.style.setProperty(key, value);
      }
    }

    // Set scoping attributes
    if (target.dataset) {
      if (tokens.shopSlug) target.dataset.shop = tokens.shopSlug;
      if (tokens.themeKey) target.dataset.theme = tokens.themeKey;
      target.dataset.themeApplied = 'true';
    } else if (typeof target.setAttribute === 'function') {
      if (tokens.shopSlug) target.setAttribute('data-shop', tokens.shopSlug);
      if (tokens.themeKey) target.setAttribute('data-theme', tokens.themeKey);
      target.setAttribute('data-theme-applied', 'true');
    }

    // Render brand elements if requested
    if (options.renderBrand && typeof target.querySelector === 'function') {
      const brandElements = target.querySelectorAll('[data-theme-brand]');
      brandElements.forEach(el => {
        if (el.dataset.themeBrand === 'name') {
          el.textContent = tokens.brandName;
        } else if (el.dataset.themeBrand === 'logo') {
          if (tokens.logoUrl) {
            el.innerHTML = `<img src="${tokens.logoUrl}" alt="" class="theme-logo-img">`;
          } else {
            el.textContent = tokens.logoText;
          }
        }
      });
    }

    return tokens;
  }

  return {
    DEFAULT_THEME,
    isValidColor,
    sanitizeColor,
    sanitizeString,
    deriveInitials,
    registerShopTheme,
    getRegisteredTheme,
    clearRegistry,
    normalizeThemeTokens,
    resolveTheme,
    toCssVariables,
    applyTheme
  };
});
