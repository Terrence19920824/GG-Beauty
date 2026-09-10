'use strict';

class CustomerIdentityError extends Error {
  constructor(code) {
    super(code);
    this.name = 'CustomerIdentityError';
    this.code = code;
  }
}

const normalizePhone = value => {
  if (typeof value !== 'string') return null;
  const compact = value.trim().replace(/[\s().-]+/g, '');
  const international = compact.startsWith('00') ? `+${compact.slice(2)}` : compact;
  return /^\+[1-9][0-9]{7,14}$/.test(international) ? international : null;
};

const resolveCustomerByPhone = async (client, { shopId, phone }) => {
  const trimmedPhone = typeof phone === 'string' ? phone.trim() : '';
  if (!trimmedPhone) throw new CustomerIdentityError('CUSTOMER_PHONE_INVALID');
  const phoneNormalized = normalizePhone(trimmedPhone);
  const result = phoneNormalized
    ? await client.query(
        'SELECT id FROM customers WHERE shop_id=$1 AND phone_normalized=$2 ORDER BY id',
        [shopId, phoneNormalized]
      )
    : await client.query(
        'SELECT id FROM customers WHERE shop_id=$1 AND BTRIM(phone)=BTRIM($2) ORDER BY id',
        [shopId, trimmedPhone]
      );
  if (result.rows.length > 1) throw new CustomerIdentityError('CUSTOMER_PHONE_AMBIGUOUS');
  return { customerId: result.rows[0]?.id || null, phone: trimmedPhone, phoneNormalized };
};

const resolveOrCreateCustomer = async (client, { shopId, name, phone, email }) => {
  const lookup = await resolveCustomerByPhone(client, { shopId, phone });
  if (lookup.customerId) return lookup;
  const result = await client.query(
    `INSERT INTO customers (shop_id,name,phone,email,phone_normalized)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [shopId, name, lookup.phone, email || null, lookup.phoneNormalized]
  );
  if (result.rows.length !== 1) throw new CustomerIdentityError('CUSTOMER_INSERT_MISMATCH');
  return { ...lookup, customerId: result.rows[0].id };
};

const recipientCustomerIdForBenefits = appointment => {
  const customerId = appointment?.recipient_customer_id;
  if (!customerId) throw new CustomerIdentityError('RECIPIENT_CUSTOMER_REQUIRED');
  return customerId;
};

module.exports = {
  CustomerIdentityError,
  normalizePhone,
  recipientCustomerIdForBenefits,
  resolveCustomerByPhone,
  resolveOrCreateCustomer
};
