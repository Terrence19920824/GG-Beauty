'use strict';

const { normalizePhone } = require('./customer-identity');

const normalizePublicPhone = value => {
  if (value === null || value === undefined || value === '') return null;
  return normalizePhone(value);
};

const validateSettings = body => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'INVALID_MERCHANT_CONTACT_SETTINGS' };
  const allowed = new Set(['contactPhone', 'whatsAppPhone']);
  const keys = Object.keys(body);
  if (keys.length === 0 || keys.some(key => !allowed.has(key))) return { error: 'INVALID_MERCHANT_CONTACT_SETTINGS' };
  const values = {};
  for (const [key, target] of [['contactPhone', 'public_contact_phone'], ['whatsAppPhone', 'public_whatsapp_phone']]) {
    if (keys.includes(key)) {
      const value = normalizePublicPhone(body[key]);
      if (body[key] !== null && body[key] !== undefined && body[key] !== '' && !value) return { error: 'INVALID_MERCHANT_PHONE' };
      values[target] = value;
    }
  }
  return { values };
};

const publicPresentation = row => ({
  shopName: row.shop_name,
  contactPhone: row.public_contact_phone || null,
  whatsAppUrl: row.public_whatsapp_phone ? `https://wa.me/${row.public_whatsapp_phone.replace(/\D/g, '')}` : null,
});

module.exports = { normalizePublicPhone, validateSettings, publicPresentation };
