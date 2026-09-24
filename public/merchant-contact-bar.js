(function (root) {
  'use strict';
  const locale = () => (root.ggI18n && root.ggI18n.normalizeLocale ? root.ggI18n.normalizeLocale(root.document.documentElement.lang) : 'en');
  const label = key => root.ggI18n && root.ggI18n.t ? root.ggI18n.t(key, locale()) : key;
  const safeHref = value => { try { const url = new URL(value, root.location.origin); return ['https:','tel:'].includes(url.protocol) ? url.href : ''; } catch (_) { return ''; } };
  async function mount({ shopSlug, host }) {
    if (!host || !shopSlug) return;
    const response = await root.fetch(`/api/customer/public-config?shopSlug=${encodeURIComponent(shopSlug)}`, { credentials: 'omit', cache: 'no-store' });
    const result = await response.json().catch(() => null);
    if (!response.ok || !result || result.success !== true) return;
    const data = result.data;
    const bar = root.document.createElement('nav'); bar.className = 'merchant-contact-bar'; bar.setAttribute('aria-label', label('merchantContactAria'));
    const name = root.document.createElement('strong'); name.className = 'merchant-contact-name notranslate'; name.translate = false; name.textContent = data.shopName || shopSlug; bar.appendChild(name);

    if (data.showAddress !== false && (data.address || data.postalCode)) {
      const addrRow = root.document.createElement('div');
      addrRow.className = 'merchant-contact-address notranslate';
      addrRow.translate = false;
      const addrPin = root.document.createElement('span');
      addrPin.setAttribute('aria-hidden', 'true');
      addrPin.textContent = '📍 ';
      addrRow.appendChild(addrPin);
      const addrText = root.document.createElement('span');
      addrText.className = 'merchant-contact-address-text';
      let formatted = data.address || '';
      if (data.postalCode) {
        formatted = formatted ? `${formatted} (${data.postalCode})` : data.postalCode;
      }
      addrText.textContent = formatted;
      addrRow.appendChild(addrText);
      bar.appendChild(addrRow);
    }

    const links = [];
    if (data.contactPhone && safeHref('tel:' + data.contactPhone)) links.push(['tel:' + data.contactPhone, 'merchantCall', false]);
    if (data.whatsAppUrl && safeHref(data.whatsAppUrl)) links.push([data.whatsAppUrl, 'merchantWhatsApp', true]);
    const resolvedMapUrl = (data.showAddress !== false)
      ? (data.mapUrl || ((data.address || data.postalCode)
          ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([data.address, data.postalCode].filter(Boolean).join(' '))}`
          : ''))
      : '';
    if (resolvedMapUrl && safeHref(resolvedMapUrl)) links.push([resolvedMapUrl, 'openMap', true]);
    links.push([`/member.html?shop=${encodeURIComponent(shopSlug)}`, 'membershipEntry', false]);
    links.push([`/?shop=${encodeURIComponent(shopSlug)}`, 'merchantBooking', false]);
    for (const [href, key, external] of links) {
      const a = root.document.createElement('a');
      a.href = href;
      a.className = 'merchant-contact-action';
      a.textContent = label(key);
      if (external) {
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
      }
      bar.appendChild(a);
    }
    host.replaceChildren(bar);
  }
  root.ggMerchantContactBar = { mount };
})(globalThis);
