(function (root) {
  'use strict';

  const i18n = root.ggI18n || {
    t: (key, loc) => key,
    normalizeLocale: loc => loc || 'zh-CN'
  };

  const shopContextApi = root.ggCustomerShopContext || {
    resolveCandidate: () => ''
  };

  let currentLocale = 'zh-CN';
  let currentShopSlug = '';
  let lastQueryResult = null;

  const COUNTRY_OPTIONS = [
    { code: '+65', labelZh: '新加坡 (+65)', labelEn: 'Singapore (+65)' },
    { code: '+60', labelZh: '马来西亚 (+60)', labelEn: 'Malaysia (+60)' },
    { code: '+62', labelZh: '印度尼西亚 (+62)', labelEn: 'Indonesia (+62)' },
    { code: '+86', labelZh: '中国 (+86)', labelEn: 'China (+86)' },
    { code: '+1', labelZh: '美国 (+1)', labelEn: 'United States (+1)' }
  ];

  const STATUS_KEY_MAP = {
    pending: 'statusPending',
    confirmed: 'statusConfirmed',
    arrived: 'statusArrived',
    in_service: 'statusInService',
    completed: 'statusCompleted',
    cancelled: 'statusCancelled',
    no_show: 'statusNoShow'
  };

  function customerT(key) {
    return i18n.t ? i18n.t(key, currentLocale) : key;
  }

  function formatDateTime(isoString) {
    if (!isoString) return '';
    try {
      const d = new Date(isoString);
      if (isNaN(d.getTime())) return isoString;
      const datePart = new Intl.DateTimeFormat(currentLocale === 'zh-CN' ? 'zh-CN' : 'en-CA', {
        timeZone: 'Asia/Singapore',
        year: 'numeric',
        month: currentLocale === 'zh-CN' ? 'long' : 'short',
        day: 'numeric'
      }).format(d);
      const timePart = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Singapore',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
      }).format(d);
      return `${datePart} ${timePart}`;
    } catch (_) {
      return isoString;
    }
  }

  function getStatusText(status) {
    const key = STATUS_KEY_MAP[status] || 'statusPending';
    return customerT(key);
  }

  function renderCountryOptions() {
    const select = root.document ? root.document.getElementById('countryCode') : null;
    if (!select) return;
    const currentVal = select.value || '+65';
    select.innerHTML = '';
    for (const opt of COUNTRY_OPTIONS) {
      const option = root.document.createElement('option');
      option.value = opt.code;
      option.textContent = currentLocale === 'zh-CN' ? opt.labelZh : opt.labelEn;
      if (opt.code === currentVal) option.selected = true;
      select.appendChild(option);
    }
  }

  function renderTexts() {
    if (!root.document) return;
    root.document.documentElement.lang = currentLocale;
    root.document.querySelectorAll('[data-i18n]').forEach(el => {
      const key = el.dataset.i18n;
      if (key) el.textContent = customerT(key);
    });
    root.document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
      const key = el.dataset.i18nPlaceholder;
      if (key) el.placeholder = customerT(key);
    });

    const zhBtn = root.document.getElementById('languageZh');
    if (zhBtn) zhBtn.disabled = currentLocale === 'zh-CN';
    const enBtn = root.document.getElementById('languageEn');
    if (enBtn) enBtn.disabled = currentLocale === 'en';

    const backLink = root.document.getElementById('backLink');
    if (backLink && currentShopSlug) {
      backLink.href = `/?shop=${encodeURIComponent(currentShopSlug)}`;
    }

    renderCountryOptions();

    if (lastQueryResult) {
      renderBookings(lastQueryResult);
    }
  }

  function renderBookings(data) {
    const section = root.document ? root.document.getElementById('bookingsSection') : null;
    if (!section) return;

    section.innerHTML = '';
    section.hidden = false;

    const appointments = data?.appointments || [];
    const shop = data?.shop || {};

    if (appointments.length === 0) {
      const emptyDiv = root.document.createElement('div');
      emptyDiv.className = 'empty-state';
      emptyDiv.textContent = customerT('noBookingsFound');
      section.appendChild(emptyDiv);
      return;
    }

    for (const apt of appointments) {
      const card = root.document.createElement('article');
      card.className = 'booking-card';

      // Header: Appointment No + Status badge
      const header = root.document.createElement('div');
      header.className = 'booking-card-header';

      const noSpan = root.document.createElement('span');
      noSpan.className = 'booking-no notranslate';
      noSpan.setAttribute('translate', 'no');
      noSpan.textContent = `${customerT('appointmentNoLabel')} ${apt.appointmentNo}`;
      header.appendChild(noSpan);

      const statusBadge = root.document.createElement('span');
      const safeStatusClass = `status-${String(apt.status || 'pending').toLowerCase()}`;
      statusBadge.className = `status-badge ${safeStatusClass}`;
      statusBadge.textContent = getStatusText(apt.status);
      header.appendChild(statusBadge);

      card.appendChild(header);

      // Time
      const timeDiv = root.document.createElement('div');
      timeDiv.className = 'booking-time';
      timeDiv.textContent = `📅 ${formatDateTime(apt.startAt)}`;
      card.appendChild(timeDiv);

      // Services
      const servicesList = root.document.createElement('div');
      servicesList.className = 'booking-services';

      for (const s of apt.services || []) {
        const itemDiv = root.document.createElement('div');
        itemDiv.className = 'booking-service-item';

        const nameSpan = root.document.createElement('span');
        nameSpan.className = 'notranslate';
        nameSpan.setAttribute('translate', 'no');
        nameSpan.textContent = s.durationMinutes ? `${s.name} (${s.durationMinutes} min)` : s.name;
        itemDiv.appendChild(nameSpan);

        const staffSpan = root.document.createElement('span');
        staffSpan.className = 'service-staff';
        const staffDisplay = s.staffName ? s.staffName : customerT('unassignedStaff');
        staffSpan.textContent = `👤 ${staffDisplay}`;
        if (s.staffName) {
          staffSpan.className += ' notranslate';
          staffSpan.setAttribute('translate', 'no');
        }
        itemDiv.appendChild(staffSpan);

        servicesList.appendChild(itemDiv);
      }
      card.appendChild(servicesList);

      // Contact options for shop
      if (shop.contactPhone || shop.whatsAppUrl) {
        const contactBar = root.document.createElement('div');
        contactBar.className = 'booking-contact-actions';

        if (shop.contactPhone) {
          const callLink = root.document.createElement('a');
          callLink.className = 'action-link';
          callLink.href = `tel:${shop.contactPhone}`;
          callLink.textContent = `📞 ${customerT('merchantCall') || '电话'}`;
          contactBar.appendChild(callLink);
        }

        if (shop.whatsAppUrl) {
          const waLink = root.document.createElement('a');
          waLink.className = 'action-link whatsapp';
          waLink.href = shop.whatsAppUrl;
          waLink.target = '_blank';
          waLink.rel = 'noopener noreferrer';
          waLink.textContent = `💬 ${customerT('merchantWhatsApp') || 'WhatsApp'}`;
          contactBar.appendChild(waLink);
        }

        card.appendChild(contactBar);
      }

      section.appendChild(card);
    }
  }

  async function executeQuery() {
    const phoneInput = root.document ? root.document.getElementById('queryPhone') : null;
    const countrySelect = root.document ? root.document.getElementById('countryCode') : null;
    const msgBox = root.document ? root.document.getElementById('queryMessage') : null;
    const queryBtn = root.document ? root.document.getElementById('queryBtn') : null;
    const section = root.document ? root.document.getElementById('bookingsSection') : null;

    if (!phoneInput) return;
    const phoneVal = phoneInput.value ? phoneInput.value.trim() : '';

    if (!phoneVal) {
      if (msgBox) {
        msgBox.className = 'message error';
        msgBox.textContent = customerT('phoneInvalid') || '请输入有效手机号';
      }
      return;
    }

    if (msgBox) {
      msgBox.className = 'message info';
      msgBox.textContent = customerT('checking');
    }
    if (queryBtn) queryBtn.disabled = true;

    try {
      const response = await root.fetch('/api/customer/my-bookings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({
          shopSlug: currentShopSlug,
          countryCode: countrySelect ? countrySelect.value : '+65',
          phone: phoneVal
        })
      });

      if (response.status === 429) {
        if (msgBox) {
          msgBox.className = 'message error';
          msgBox.textContent = customerT('queryTooFrequent');
        }
        if (section) section.hidden = true;
        return;
      }

      const result = await response.json().catch(() => null);

      if (!response.ok || !result || result.success !== true) {
        if (msgBox) {
          msgBox.className = 'message error';
          msgBox.textContent = customerT('queryFailed');
        }
        if (section) section.hidden = true;
        return;
      }

      if (msgBox) {
        msgBox.className = 'message';
        msgBox.textContent = '';
      }

      lastQueryResult = result.data;
      renderBookings(lastQueryResult);
    } catch (_) {
      if (msgBox) {
        msgBox.className = 'message error';
        msgBox.textContent = customerT('queryFailed');
      }
      if (section) section.hidden = true;
    } finally {
      if (queryBtn) queryBtn.disabled = false;
    }
  }

  function setLocale(loc) {
    currentLocale = loc === 'en' ? 'en' : 'zh-CN';
    try {
      root.localStorage?.setItem('gg_beauty_locale', currentLocale);
    } catch (_) {}
    renderTexts();
  }

  async function init() {
    if (!root.document) return;

    try {
      const savedLocale = root.localStorage?.getItem('gg_beauty_locale');
      if (savedLocale === 'en' || savedLocale === 'zh-CN') {
        currentLocale = savedLocale;
      } else if (root.navigator && root.navigator.languages) {
        const prefersZh = root.navigator.languages.some(l => String(l).toLowerCase().startsWith('zh'));
        currentLocale = prefersZh ? 'zh-CN' : 'en';
      }
    } catch (_) {}

    const locCandidate = shopContextApi.resolveCandidate(root.location);
    const params = new URLSearchParams(root.location ? root.location.search : '');
    currentShopSlug = locCandidate || params.get('shop') || 'gg-beauty';

    // Update shop brand heading
    const brandHeading = root.document.getElementById('shopBrandHeading');
    if (brandHeading) {
      brandHeading.textContent = currentShopSlug;
    }

    // Apply theme & contact bar
    if (root.ggCustomerTheme && typeof root.ggCustomerTheme.resolveTheme === 'function') {
      const theme = root.ggCustomerTheme.resolveTheme(currentShopSlug, {});
      if (root.document.documentElement) {
        root.ggCustomerTheme.applyTheme(root.document.documentElement, theme);
      }
    }

    const contactBarHost = root.document.getElementById('merchantContactBar');
    if (contactBarHost && root.ggMerchantContactBar?.mount) {
      root.ggMerchantContactBar.mount({ shopSlug: currentShopSlug, host: contactBarHost }).catch(() => {});
    }

    // Event listeners
    const zhBtn = root.document.getElementById('languageZh');
    if (zhBtn) zhBtn.addEventListener('click', () => setLocale('zh-CN'));

    const enBtn = root.document.getElementById('languageEn');
    if (enBtn) enBtn.addEventListener('click', () => setLocale('en'));

    const queryBtn = root.document.getElementById('queryBtn');
    if (queryBtn) queryBtn.addEventListener('click', executeQuery);

    const phoneInput = root.document.getElementById('queryPhone');
    if (phoneInput) {
      phoneInput.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
          e.preventDefault();
          executeQuery();
        }
      });
    }

    renderTexts();

    // Check if phone was passed in query params
    const initialPhone = params.get('phone');
    if (initialPhone && phoneInput) {
      phoneInput.value = initialPhone;
      await executeQuery();
    }
  }

  if (typeof root.document !== 'undefined') {
    if (root.document.readyState === 'loading') {
      root.document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
  }

  root.ggCustomerMyBookings = {
    init,
    executeQuery,
    setLocale,
    formatDateTime,
    getStatusText
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
