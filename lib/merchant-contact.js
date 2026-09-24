'use strict';

const { normalizePhone } = require('./customer-identity');

const normalizePublicPhone = value => {
  if (value === null || value === undefined || value === '') return null;
  return normalizePhone(value);
};

const normalizeAddress = value => {
  if (value === null || value === undefined) return null;
  const str = String(value).trim();
  return str.length > 0 ? str : null;
};

const normalizePostalCode = value => {
  if (value === null || value === undefined) return null;
  const str = String(value).trim();
  return str.length > 0 ? str : null;
};

const normalizeMapUrl = value => {
  if (value === null || value === undefined) return null;
  const str = String(value).trim();
  return str.length > 0 ? str : null;
};

const validateSettings = body => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'INVALID_MERCHANT_CONTACT_SETTINGS' };
  }
  const allowed = new Set([
    'contactPhone',
    'whatsAppPhone',
    'address',
    'postalCode',
    'mapUrl',
    'showAddress'
  ]);
  const keys = Object.keys(body);
  if (keys.length === 0 || keys.some(key => !allowed.has(key))) {
    return { error: 'INVALID_MERCHANT_CONTACT_SETTINGS' };
  }

  const values = {};

  if (keys.includes('contactPhone')) {
    const value = normalizePublicPhone(body.contactPhone);
    if (body.contactPhone !== null && body.contactPhone !== undefined && body.contactPhone !== '' && !value) {
      return { error: 'INVALID_MERCHANT_PHONE' };
    }
    values.public_contact_phone = value;
  }

  if (keys.includes('whatsAppPhone')) {
    const value = normalizePublicPhone(body.whatsAppPhone);
    if (body.whatsAppPhone !== null && body.whatsAppPhone !== undefined && body.whatsAppPhone !== '' && !value) {
      return { error: 'INVALID_MERCHANT_PHONE' };
    }
    values.public_whatsapp_phone = value;
  }

  if (keys.includes('address')) {
    const addr = normalizeAddress(body.address);
    if (addr && addr.length > 255) {
      return { error: 'INVALID_MERCHANT_ADDRESS' };
    }
    values.public_address = addr;
  }

  if (keys.includes('postalCode')) {
    const code = normalizePostalCode(body.postalCode);
    if (code && code.length > 16) {
      return { error: 'INVALID_MERCHANT_POSTAL_CODE' };
    }
    values.public_postal_code = code;
  }

  if (keys.includes('mapUrl')) {
    const urlStr = normalizeMapUrl(body.mapUrl);
    if (urlStr) {
      if (urlStr.length > 500) {
        return { error: 'INVALID_MERCHANT_MAP_URL' };
      }
      try {
        const parsed = new URL(urlStr);
        if (parsed.protocol !== 'https:') {
          return { error: 'INVALID_MERCHANT_MAP_URL' };
        }
      } catch (_) {
        return { error: 'INVALID_MERCHANT_MAP_URL' };
      }
    }
    values.public_map_url = urlStr;
  }

  if (keys.includes('showAddress')) {
    values.show_public_address = Boolean(body.showAddress !== false);
  }

  return { values };
};

const buildAutoMapUrl = (address, postalCode) => {
  const parts = [address, postalCode]
    .map(p => (p !== null && p !== undefined ? String(p).trim() : ''))
    .filter(Boolean);
  if (parts.length === 0) return null;
  const query = parts.join(' ');
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
};

const publicPresentation = row => {
  const showAddress = row.show_public_address !== false;
  const address = (showAddress && row.public_address) ? String(row.public_address).trim() : null;
  const postalCode = (showAddress && row.public_postal_code) ? String(row.public_postal_code).trim() : null;

  let mapUrl = null;
  if (showAddress) {
    if (row.public_map_url && /^https:\/\//i.test(String(row.public_map_url).trim())) {
      mapUrl = String(row.public_map_url).trim();
    } else if (address || postalCode) {
      mapUrl = buildAutoMapUrl(address, postalCode);
    }
  }

  return {
    shopName: row.shop_name,
    contactPhone: row.public_contact_phone || null,
    whatsAppUrl: row.public_whatsapp_phone ? `https://wa.me/${row.public_whatsapp_phone.replace(/\D/g, '')}` : null,
    address,
    postalCode,
    mapUrl,
    showAddress
  };
};

module.exports = {
  normalizePublicPhone,
  normalizeAddress,
  normalizePostalCode,
  normalizeMapUrl,
  validateSettings,
  buildAutoMapUrl,
  publicPresentation
};
