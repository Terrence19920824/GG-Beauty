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
  return /^(?:\+[1-9][0-9]{7,14}|[0-9]{8,15})$/.test(international) ? international : null;
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

// An unverified recipient must never claim an existing verified member merely
// because the booker knows that member's phone number. It receives a distinct
// contact identity with no normalized lookup key or verified entitlement.
const createUnverifiedRecipient = async (client, { shopId, name, phone, email }) => {
  const trimmedPhone = typeof phone === 'string' ? phone.trim() : '';
  if (!trimmedPhone) throw new CustomerIdentityError('CUSTOMER_PHONE_INVALID');
  const result = await client.query(
    `INSERT INTO customers (shop_id,name,phone,email,phone_normalized,identity_status)
     VALUES ($1,$2,$3,$4,NULL,'unverified_contact') RETURNING id`,
    [shopId, name, trimmedPhone, email || null]
  );
  if (result.rows.length !== 1) throw new CustomerIdentityError('CUSTOMER_INSERT_MISMATCH');
  return { customerId: result.rows[0].id, phone: trimmedPhone, phoneNormalized: null, verified: false };
};

const CUSTOMER_ID_INPUT_KEYS = [
  'customerId', 'customer_id', 'bookerCustomerId', 'booker_customer_id',
  'recipientCustomerId', 'recipient_customer_id'
];

const hasClientCustomerIdentity = body => CUSTOMER_ID_INPUT_KEYS.some(key => body?.[key] !== undefined) ||
  CUSTOMER_ID_INPUT_KEYS.some(key => body?.recipient?.[key] !== undefined || body?.booker?.[key] !== undefined);

const contactDraft = value => ({
  name: typeof value?.name === 'string' ? value.name.trim() : '',
  phone: typeof value?.phone === 'string' ? value.phone.trim() : '',
  email: typeof value?.email === 'string' && value.email.trim() ? value.email.trim() : null
});

const resolveBookingParties = async (client, { shopId, body }) => {
  if (hasClientCustomerIdentity(body)) throw new CustomerIdentityError('CLIENT_CUSTOMER_ID_FORBIDDEN');
  const bookingFor = body?.bookingFor === undefined ? 'myself' : body.bookingFor;
  if (!['myself', 'someone_else'].includes(bookingFor)) {
    throw new CustomerIdentityError('BOOKING_RECIPIENT_MODE_INVALID');
  }
  const bookerDraft = contactDraft({ name: body?.customerName, phone: body?.phone, email: body?.email });
  if (!bookerDraft.name || !bookerDraft.phone) throw new CustomerIdentityError('BOOKER_CONTACT_REQUIRED');
  const booker = await resolveOrCreateCustomer(client, { shopId, ...bookerDraft });
  if (bookingFor === 'myself') {
    return { bookingFor, booker, recipient: booker, bookerDraft, recipientDraft: bookerDraft };
  }
  const recipientDraft = contactDraft(body?.recipient);
  if (!recipientDraft.name || !recipientDraft.phone) throw new CustomerIdentityError('RECIPIENT_CONTACT_REQUIRED');
  const recipient = await createUnverifiedRecipient(client, { shopId, ...recipientDraft });
  return { bookingFor, booker, recipient, bookerDraft, recipientDraft };
};

const recipientCustomerIdForBenefits = appointment => {
  const customerId = appointment?.recipient_customer_id;
  if (!customerId) throw new CustomerIdentityError('RECIPIENT_CUSTOMER_REQUIRED');
  if (appointment?.recipient_identity_status !== 'verified_member') {
    throw new CustomerIdentityError('VERIFIED_RECIPIENT_REQUIRED');
  }
  return customerId;
};

module.exports = {
  CustomerIdentityError,
  normalizePhone,
  recipientCustomerIdForBenefits,
  resolveBookingParties,
  createUnverifiedRecipient,
  resolveCustomerByPhone,
  resolveOrCreateCustomer
};
