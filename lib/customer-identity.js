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
  if (lookup.customerId) return { ...lookup, verified: false };
  const result = await client.query(
    `INSERT INTO customers (shop_id,name,phone,email,phone_normalized)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [shopId, name, lookup.phone, email || null, lookup.phoneNormalized]
  );
  if (result.rows.length !== 1) throw new CustomerIdentityError('CUSTOMER_INSERT_MISMATCH');
  return { ...lookup, customerId: result.rows[0].id, verified: false };
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

const hasClientBookerContact = body => ['customerName', 'phone', 'countryCode', 'email']
  .some(key => body?.[key] !== undefined);

const maskPhone = value => {
  const normalized = normalizePhone(value);
  if (!normalized) return '';
  const digits = normalized.replace(/\D/g, '');
  return digits.length > 4 ? `•••• ${digits.slice(-4)}` : `•••• ${digits}`;
};

const bookingIdentityPresentation = session => ({
  authenticated: true,
  name: typeof session?.name === 'string' ? session.name : '',
  maskedPhone: maskPhone(session?.phone_normalized),
  isPhoneVerified: Boolean(session?.phone_verified_at)
});

const resolveVerifiedBooker = async (client,{shopId,session}) => {
  if (!session) return null;
  if (session.shop_id!==shopId) throw new CustomerIdentityError('CUSTOMER_SESSION_SHOP_MISMATCH');
  const result=await client.query(`SELECT id,phone,phone_normalized FROM customers
    WHERE shop_id=$1 AND id=$2 AND identity_status='verified_member'`,[shopId,session.customer_id]);
  if (result.rows.length===1) {
    return {customerId:result.rows[0].id,phone:result.rows[0].phone_normalized||result.rows[0].phone,phoneNormalized:result.rows[0].phone_normalized,verified:true};
  }
  return null;
};

const resolveBookingParties = async (client, { shopId, body, verifiedSession = null }) => {
  if (hasClientCustomerIdentity(body)) throw new CustomerIdentityError('CLIENT_CUSTOMER_ID_FORBIDDEN');
  const bookingFor = body?.bookingFor === undefined ? 'myself' : body.bookingFor;
  if (!['myself', 'someone_else'].includes(bookingFor)) {
    throw new CustomerIdentityError('BOOKING_RECIPIENT_MODE_INVALID');
  }
  let booker;
  let bookerDraft;
  if (verifiedSession) {
    if (verifiedSession.shop_id !== shopId) {
      throw new CustomerIdentityError('CUSTOMER_SESSION_SHOP_MISMATCH');
    }
    if (hasClientBookerContact(body)) {
      throw new CustomerIdentityError('AUTHENTICATED_BOOKER_CONTACT_FORBIDDEN');
    }
    const sessionCustomerResult = await client.query(
      `SELECT id, name, phone, phone_normalized, email, phone_verified_at
       FROM customers WHERE shop_id = $1 AND id = $2`,
      [shopId, verifiedSession.customer_id]
    );
    if (sessionCustomerResult.rows.length !== 1) {
      throw new CustomerIdentityError('CUSTOMER_SESSION_INVALID');
    }
    const customer = sessionCustomerResult.rows[0];
    const phone = customer.phone_normalized || customer.phone;
    if (!customer.name || !phone) throw new CustomerIdentityError('CUSTOMER_SESSION_INVALID');
    bookerDraft = contactDraft({ name: customer.name, phone, email: customer.email });
    booker = {
      customerId: customer.id,
      phone,
      phoneNormalized: customer.phone_normalized || normalizePhone(phone),
      verified: Boolean(customer.phone_verified_at)
    };
  } else {
    bookerDraft = contactDraft({ name: body?.customerName, phone: body?.phone, email: body?.email });
    if (!bookerDraft.name || !bookerDraft.phone) throw new CustomerIdentityError('BOOKER_CONTACT_REQUIRED');
    booker = await resolveOrCreateCustomer(client, { shopId, ...bookerDraft });
  }

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
  bookingIdentityPresentation,
  hasClientBookerContact,
  maskPhone,
  normalizePhone,
  recipientCustomerIdForBenefits,
  resolveBookingParties,
  resolveVerifiedBooker,
  createUnverifiedRecipient,
  resolveCustomerByPhone,
  resolveOrCreateCustomer
};
