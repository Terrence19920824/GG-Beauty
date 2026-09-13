'use strict';

const crypto = require('crypto');
const { normalizePhone, CustomerIdentityError } = require('./customer-identity');

const COOKIE = 'gg_beauty_customer_session';
const OTP_TTL_MS = 5 * 60 * 1000;
const OTP_RESEND_MS = 60 * 1000;
const OTP_WINDOW_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PHONE_RATE_MAX = 3;
const FINGERPRINT_RATE_MAX = 10;

class CustomerMemberError extends Error {
  constructor(code, status = 400) { super(code); this.name = 'CustomerMemberError'; this.code = code; this.status = status; }
}

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const safeEqual = (left, right) => {
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
const normalizeCountryCode = value => /^\+[1-9][0-9]{0,3}$/.test(value || '') ? value : null;
const normalizeSelectedPhone = ({ countryCode, phone }) => {
  const raw = typeof phone === 'string' ? phone.trim() : '';
  if (!raw) return null;
  if (raw.startsWith('+') || raw.startsWith('00')) return normalizePhone(raw);
  const explicitCode = normalizeCountryCode(countryCode);
  if (!explicitCode) return null;
  const local = raw.replace(/[\s().-]+/g, '');
  return /^[0-9]{4,14}$/.test(local) ? normalizePhone(`${explicitCode}${local}`) : null;
};
const otpHash = ({ pepper, challengeId, code }) => sha256(`${pepper}\0${challengeId}\0${code}`);
const tokenHash = token => sha256(token);
const requestFingerprint = ({ pepper, ip, userAgent }) => sha256(`${pepper}\0${ip || ''}\0${userAgent || ''}`);
const normalizeDateOfBirth = value => {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new CustomerMemberError('DOB_INVALID');
  const date=new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0,10)!==value || date>=new Date()) throw new CustomerMemberError('DOB_INVALID');
  return value;
};
const normalizeGender = value => {
  if (value===undefined || value===null || value==='') return null;
  return ['female','male','non_binary','prefer_not_to_say'].includes(value) ? value : (()=>{throw new CustomerMemberError('GENDER_INVALID');})();
};

const runTransaction = async (pool, work) => {
  const client = await pool.connect();
  try { await client.query('BEGIN'); const result = await work(client); await client.query('COMMIT'); return result; }
  catch (error) {
    try { await client.query(error.commitTransaction===true?'COMMIT':'ROLLBACK'); } catch (_) {}
    throw error;
  }
  finally { client.release(); }
};

const resolveShop = async (client, shopSlug) => {
  const result = await client.query(
    `SELECT shop.id AS shop_id,shop.name AS shop_name,settings.default_phone_country_code,settings.dob_requirement
     FROM shops shop JOIN shop_customer_settings settings ON settings.shop_id=shop.id
     WHERE shop.slug=$1 AND shop.status='active'`, [shopSlug]);
  if (result.rows.length !== 1) throw new CustomerMemberError('SHOP_NOT_FOUND', 404);
  return result.rows[0];
};

const createCustomerMemberIdentity = ({ pool, getProvider, pepper, now = () => new Date() }) => {
  if (!pool || typeof getProvider !== 'function') throw new Error('CUSTOMER_MEMBER_DEPENDENCY_INVALID');
  const secret = pepper || process.env.CUSTOMER_OTP_PEPPER;

  const requireSecret = () => { if (!secret) throw new CustomerMemberError('OTP_NOT_CONFIGURED', 503); };
  const getPublicConfig = async shopSlug => runTransaction(pool,async client=>{
    const shop=await resolveShop(client,shopSlug);
    return {shopName:shop.shop_name,defaultPhoneCountryCode:shop.default_phone_country_code,dobRequirement:shop.dob_requirement};
  });
  const requestOtp = async ({ shopSlug, countryCode, phone, purpose = 'sign_in', customerId = null, ip, userAgent }) => {
    requireSecret();
    if (!['sign_in','phone_change'].includes(purpose)) throw new CustomerMemberError('OTP_PURPOSE_INVALID');
    const provider = getProvider();
    if (!provider || typeof provider.sendOtp !== 'function') throw new CustomerMemberError('OTP_PROVIDER_UNAVAILABLE', 503);
    const normalized = normalizeSelectedPhone({ countryCode, phone });
    if (!normalized) throw new CustomerMemberError('PHONE_INVALID');
    const challengeId = crypto.randomUUID(), code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    const createdAt = now(), expiresAt = new Date(createdAt.getTime()+OTP_TTL_MS), resendAfter = new Date(createdAt.getTime()+OTP_RESEND_MS);
    const fingerprint = requestFingerprint({ pepper: secret, ip, userAgent });
    const challenge = await runTransaction(pool, async client => {
      const shop = await resolveShop(client, shopSlug);
      await client.query(
        `SELECT pg_advisory_xact_lock(lock_key)
         FROM unnest(ARRAY[
           hashtextextended($1 || ':otp-phone:' || $2, 0),
           hashtextextended($1 || ':otp-fingerprint:' || $3, 0)
         ]) AS requested_lock(lock_key)
         ORDER BY lock_key`,
        [shop.shop_id,normalized,fingerprint]);
      const rate = await client.query(
        `SELECT COUNT(*) FILTER (WHERE phone_normalized=$2) AS phone_count,
                COUNT(*) FILTER (WHERE request_fingerprint_hash=$3) AS fingerprint_count,
                MAX(resend_after) FILTER (WHERE phone_normalized=$2) AS resend_after
         FROM customer_otp_challenges WHERE shop_id=$1 AND created_at>$4`,
        [shop.shop_id,normalized,fingerprint,new Date(createdAt.getTime()-OTP_WINDOW_MS)]);
      const row = rate.rows[0];
      if (Number(row.phone_count)>=PHONE_RATE_MAX || Number(row.fingerprint_count)>=FINGERPRINT_RATE_MAX)
        throw new CustomerMemberError('OTP_RATE_LIMITED', 429);
      if (row.resend_after && new Date(row.resend_after)>createdAt) throw new CustomerMemberError('OTP_RESEND_TOO_SOON', 429);
      if (purpose==='phone_change') {
        const owned = await client.query('SELECT 1 FROM customers WHERE shop_id=$1 AND id=$2',[shop.shop_id,customerId]);
        if (owned.rows.length!==1) throw new CustomerMemberError('CUSTOMER_SESSION_INVALID',401);
      }
      await client.query(
        `INSERT INTO customer_otp_challenges(id,shop_id,customer_id,purpose,phone_normalized,code_hash,
          request_fingerprint_hash,provider_key,expires_at,resend_after,created_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [challengeId,shop.shop_id,customerId,purpose,normalized,otpHash({pepper:secret,challengeId,code}),fingerprint,provider.key||'test',expiresAt,resendAfter,createdAt]);
      return { challengeId,shopId:shop.shop_id,phoneNormalized:normalized,code,expiresAt };
    });
    try {
      const sent = await provider.sendOtp({ challengeId, phone: normalized, code, purpose, expiresAt });
      if (sent?.messageId) await pool.query('UPDATE customer_otp_challenges SET provider_message_id=$2 WHERE id=$1',[challengeId,sent.messageId]);
    } catch (_error) {
      await pool.query(`UPDATE customer_otp_challenges SET consumed_at=NOW() WHERE id=$1 AND consumed_at IS NULL`,[challengeId]);
      throw new CustomerMemberError('OTP_DELIVERY_FAILED', 503);
    }
    return { challengeId, expiresAt };
  };

  const consumeChallenge = async (client, { challengeId, code, purpose }) => {
    const result = await client.query('SELECT * FROM customer_otp_challenges WHERE id=$1 FOR UPDATE',[challengeId]);
    if (result.rows.length!==1) throw new CustomerMemberError('OTP_INVALID',401);
    const row=result.rows[0], current=now();
    if (row.purpose!==purpose || row.consumed_at || new Date(row.expires_at)<=current || row.attempts>=row.max_attempts)
      throw new CustomerMemberError('OTP_INVALID',401);
    const matches = typeof code==='string' && safeEqual(row.code_hash,otpHash({pepper:secret,challengeId,code}));
    if (!matches) {
      await client.query('UPDATE customer_otp_challenges SET attempts=attempts+1 WHERE id=$1',[challengeId]);
      const invalid=new CustomerMemberError('OTP_INVALID',401); invalid.commitTransaction=true; throw invalid;
    }
    await client.query('UPDATE customer_otp_challenges SET attempts=attempts+1,consumed_at=$2 WHERE id=$1',[challengeId,current]);
    return row;
  };

  const verifySignIn = async ({ challengeId, code, name, email, dateOfBirth, gender }) => {
    requireSecret();
    return runTransaction(pool, async client => {
      const challenge=await consumeChallenge(client,{challengeId,code,purpose:'sign_in'});
      const policy=(await client.query('SELECT dob_requirement FROM shop_customer_settings WHERE shop_id=$1',[challenge.shop_id])).rows[0];
      const dob=normalizeDateOfBirth(dateOfBirth), normalizedGender=normalizeGender(gender);
      const matches=await client.query(
        `SELECT DISTINCT customer_id FROM customer_phone_identities
         WHERE shop_id=$1 AND phone_normalized=$2 AND verified_at IS NOT NULL AND ended_at IS NULL ORDER BY customer_id`,
        [challenge.shop_id,challenge.phone_normalized]);
      if (matches.rows.length>1) throw new CustomerMemberError('CUSTOMER_PHONE_AMBIGUOUS',409);
      let customerId=matches.rows[0]?.customer_id;
      if (!customerId) {
        const legacy=await client.query(`SELECT id FROM customers WHERE shop_id=$1 AND phone_normalized=$2 ORDER BY id`,
          [challenge.shop_id,challenge.phone_normalized]);
        if (legacy.rows.length>1) throw new CustomerMemberError('CUSTOMER_PHONE_AMBIGUOUS',409);
        customerId=legacy.rows[0]?.id;
      }
      const existing=customerId ? (await client.query(
        'SELECT date_of_birth FROM customers WHERE shop_id=$1 AND id=$2',[challenge.shop_id,customerId])).rows[0] : null;
      if (policy?.dob_requirement==='required' && !dob && !existing?.date_of_birth) throw new CustomerMemberError('DOB_REQUIRED');
      if (!customerId) {
        if (typeof name!=='string' || !name.trim()) throw new CustomerMemberError('CUSTOMER_NAME_REQUIRED');
        const inserted=await client.query(
          `INSERT INTO customers(shop_id,name,phone,email,phone_normalized,phone_verified_at,identity_status,date_of_birth,gender)
           VALUES($1,$2,$3,$4,$3,$5,'verified_member',$6,$7) RETURNING id,member_code`,
          [challenge.shop_id,name.trim(),challenge.phone_normalized,email||null,now(),dob,normalizedGender]);
        customerId=inserted.rows[0].id;
      } else {
        await client.query(`UPDATE customers SET phone=$3,phone_normalized=$3,phone_verified_at=$4,identity_status='verified_member',
          date_of_birth=COALESCE($5,date_of_birth),gender=COALESCE($6,gender) WHERE shop_id=$1 AND id=$2`,
          [challenge.shop_id,customerId,challenge.phone_normalized,now(),dob,normalizedGender]);
      }
      await client.query(
        `INSERT INTO customer_phone_identities(shop_id,customer_id,phone_normalized,is_primary,verified_at)
         VALUES($1,$2,$3,TRUE,$4) ON CONFLICT DO NOTHING`,[challenge.shop_id,customerId,challenge.phone_normalized,now()]);
      const token=crypto.randomBytes(32).toString('base64url');
      await client.query(`INSERT INTO customer_sessions(shop_id,customer_id,token_hash,expires_at) VALUES($1,$2,$3,$4)`,
        [challenge.shop_id,customerId,tokenHash(token),new Date(now().getTime()+SESSION_TTL_MS)]);
      await client.query(`INSERT INTO customer_identity_audit(shop_id,customer_id,event_type,challenge_id) VALUES($1,$2,'otp_sign_in',$3)`,
        [challenge.shop_id,customerId,challengeId]);
      return { token,shopId:challenge.shop_id,customerId };
    });
  };

  const authenticate = async token => {
    if (!token) throw new CustomerMemberError('CUSTOMER_SESSION_INVALID',401);
    const result=await pool.query(
      `SELECT session.shop_id,session.customer_id,customer.member_code,customer.name,customer.email,
        customer.phone_normalized,customer.date_of_birth,customer.gender,shop.name AS shop_name,
        settings.dob_requirement,settings.default_phone_country_code
       FROM customer_sessions session JOIN customers customer ON customer.shop_id=session.shop_id AND customer.id=session.customer_id
       JOIN shops shop ON shop.id=session.shop_id
       JOIN shop_customer_settings settings ON settings.shop_id=session.shop_id
       WHERE session.token_hash=$1 AND session.revoked_at IS NULL AND session.expires_at>NOW() AND customer.identity_status='verified_member'`,[tokenHash(token)]);
    if (result.rows.length!==1) throw new CustomerMemberError('CUSTOMER_SESSION_INVALID',401);
    return result.rows[0];
  };

  const updateProfile = async ({ session, name, email, dateOfBirth, gender }) => runTransaction(pool,async client=>{
    const normalizedName=typeof name==='string'?name.trim():'';
    if (!normalizedName) throw new CustomerMemberError('CUSTOMER_NAME_REQUIRED');
    const dob=normalizeDateOfBirth(dateOfBirth),normalizedGender=normalizeGender(gender);
    const policy=(await client.query('SELECT dob_requirement FROM shop_customer_settings WHERE shop_id=$1',[session.shop_id])).rows[0];
    if (policy?.dob_requirement==='required' && !dob) throw new CustomerMemberError('DOB_REQUIRED');
    const result=await client.query(`UPDATE customers SET name=$3,email=$4,date_of_birth=$5,gender=$6
      WHERE shop_id=$1 AND id=$2 AND identity_status='verified_member' RETURNING id`,
      [session.shop_id,session.customer_id,normalizedName,email?.trim()||null,dob,normalizedGender]);
    if (result.rows.length!==1) throw new CustomerMemberError('CUSTOMER_SESSION_INVALID',401);
    await client.query(`INSERT INTO customer_identity_audit(shop_id,customer_id,event_type)
      VALUES($1,$2,'profile_updated')`,[session.shop_id,session.customer_id]);
    return {customerId:session.customer_id};
  });

  const confirmPhoneChange = async ({ session, challengeId, code }) => {
    requireSecret();
    return runTransaction(pool,async client=>{
      const challenge=await consumeChallenge(client,{challengeId,code,purpose:'phone_change'});
      if (challenge.shop_id!==session.shop_id || challenge.customer_id!==session.customer_id) throw new CustomerMemberError('OTP_INVALID',401);
      const owner=await client.query(`SELECT customer_id FROM customer_phone_identities WHERE shop_id=$1 AND phone_normalized=$2
        AND verified_at IS NOT NULL AND ended_at IS NULL FOR UPDATE`,[session.shop_id,challenge.phone_normalized]);
      if (owner.rows.some(row=>row.customer_id!==session.customer_id)) throw new CustomerMemberError('CUSTOMER_PHONE_AMBIGUOUS',409);
      await client.query(`UPDATE customer_phone_identities SET is_primary=FALSE,ended_at=$3
        WHERE shop_id=$1 AND customer_id=$2 AND is_primary AND ended_at IS NULL`,[session.shop_id,session.customer_id,now()]);
      await client.query(`INSERT INTO customer_phone_identities(shop_id,customer_id,phone_normalized,is_primary,verified_at)
        VALUES($1,$2,$3,TRUE,$4)`,[session.shop_id,session.customer_id,challenge.phone_normalized,now()]);
      await client.query(`UPDATE customers SET phone=$3,phone_normalized=$3,phone_verified_at=$4 WHERE shop_id=$1 AND id=$2`,
        [session.shop_id,session.customer_id,challenge.phone_normalized,now()]);
      await client.query(`INSERT INTO customer_identity_audit(shop_id,customer_id,event_type,challenge_id)
        VALUES($1,$2,'phone_changed',$3)`,[session.shop_id,session.customer_id,challengeId]);
      return { customerId:session.customer_id };
    });
  };

  return { authenticate,confirmPhoneChange,getPublicConfig,normalizeSelectedPhone,requestOtp,updateProfile,verifySignIn };
};

module.exports={ COOKIE,CustomerMemberError,createCustomerMemberIdentity,normalizeSelectedPhone,otpHash,tokenHash };
