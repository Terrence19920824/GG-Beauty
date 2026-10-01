(function (root, factory) {
  'use strict';
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ggCustomerPhoneSelector = api;
})(typeof globalThis === 'object' ? globalThis : this, function (root) {
  'use strict';

  const normalizeLocale = locale => String(locale || '').toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';

  const filterCountries = (countries, query) => {
    const list = Array.isArray(countries) ? countries : [];
    const normalized = typeof query === 'string' ? query.trim().toLowerCase() : '';
    if (!normalized) return list.slice();
    const digits = normalized.replace(/^\+/, '');
    return list.filter(country => {
      const iso = String(country?.countryIso2 || country?.iso2 || '').toLowerCase();
      const name = String(country?.localizedName || '').toLowerCase();
      const callingCode = String(country?.callingCode || '').toLowerCase();
      return iso.includes(normalized) || name.includes(normalized) || callingCode.includes(normalized)
        || (digits && callingCode.replace(/^\+/, '').startsWith(digits));
    });
  };

  const fetchCountries = async (locale, fetchImpl = root?.fetch) => {
    if (typeof fetchImpl !== 'function') throw new Error('PHONE_COUNTRY_SOURCE_UNAVAILABLE');
    const normalizedLocale = normalizeLocale(locale);
    const response = await fetchImpl(`/api/customer/phone-countries?locale=${encodeURIComponent(normalizedLocale)}`, {
      credentials: 'same-origin'
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.success !== true || !Array.isArray(result.data) || result.data.length < 200) {
      throw new Error('PHONE_COUNTRY_SOURCE_UNAVAILABLE');
    }
    return result.data.map(country => ({
      countryIso2: String(country.countryIso2 || country.iso2 || '').toUpperCase(),
      iso2: String(country.countryIso2 || country.iso2 || '').toUpperCase(),
      callingCode: String(country.callingCode || ''),
      localizedName: String(country.localizedName || ''),
      flag: String(country.flag || '')
    })).filter(country => /^[A-Z]{2}$/.test(country.countryIso2) && /^\+[1-9]\d{0,3}$/.test(country.callingCode));
  };

  const optionLabel = country => `${country.flag ? `${country.flag} ` : ''}${country.localizedName} (${country.callingCode})`;

  const bind = ({ select, searchInput, locale = 'zh-CN', defaultCountry = 'SG', fetchImpl } = {}) => {
    if (!select) throw new Error('PHONE_COUNTRY_SELECT_REQUIRED');
    let countries = [];
    let selectedCountry = String(select.value || defaultCountry || 'SG').toUpperCase();
    let currentLocale = normalizeLocale(locale);

    const resolvePreferred = value => {
      const raw = String(value || '').trim().toUpperCase();
      const fallbackCountry = countries.some(country => country.countryIso2 === String(defaultCountry || '').toUpperCase())
        ? String(defaultCountry).toUpperCase()
        : 'SG';
      const byIso = countries.find(country => country.countryIso2 === raw);
      if (byIso) return byIso.countryIso2;
      // Preserve the historical +1 = United States default without guessing
      // for other calling codes shared by multiple countries.
      if (raw === '+1' && countries.some(country => country.countryIso2 === 'US')) return 'US';
      const byCallingCode = countries.filter(country => country.callingCode === raw);
      return byCallingCode.length === 1 ? byCallingCode[0].countryIso2 : fallbackCountry;
    };

    const render = query => {
      const visible = filterCountries(countries, query);
      const previous = selectedCountry;
      select.textContent = '';
      for (const country of visible) {
        const option = select.ownerDocument?.createElement
          ? select.ownerDocument.createElement('option')
          : root.document.createElement('option');
        option.value = country.countryIso2;
        option.textContent = optionLabel(country);
        select.appendChild(option);
      }
      if (visible.some(country => country.countryIso2 === previous)) {
        select.value = previous;
      } else if (visible.length > 0) {
        select.value = visible[0].countryIso2;
      } else {
        select.value = '';
      }
    };

    const load = async (nextLocale = currentLocale, preferredCountry = selectedCountry) => {
      currentLocale = normalizeLocale(nextLocale);
      countries = await fetchCountries(currentLocale, fetchImpl);
      selectedCountry = resolvePreferred(preferredCountry);
      if (searchInput) searchInput.value = '';
      render('');
      return countries.slice();
    };

    select.addEventListener?.('change', () => {
      if (/^[A-Z]{2}$/.test(String(select.value || ''))) selectedCountry = select.value;
    });
    searchInput?.addEventListener?.('input', () => {
      if (/^[A-Z]{2}$/.test(String(select.value || ''))) selectedCountry = select.value;
      render(searchInput.value);
    });

    return {
      load,
      getCountries: () => countries.slice(),
      getSelectedCountry: () => select.value || selectedCountry,
      filter: query => filterCountries(countries, query)
    };
  };

  return { bind, fetchCountries, filterCountries, normalizeLocale, optionLabel };
});
