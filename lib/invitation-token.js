'use strict';

const crypto = require('node:crypto');

const MIN_TOKEN_BYTES = 32; // 256 bits of cryptographic entropy
const SHA256_HEX_LENGTH = 64;
const HEX_REGEX = /^[0-9a-f]+$/i;

/**
 * Generates a cryptographically strong random token.
 * Default is 32 bytes (256 bits), yielding a 64-character hex string.
 *
 * @param {number} [byteLength=32]
 * @returns {string} lowercase hex token string
 */
function generateToken(byteLength = MIN_TOKEN_BYTES) {
  if (typeof byteLength !== 'number' || !Number.isInteger(byteLength) || byteLength < MIN_TOKEN_BYTES) {
    throw new TypeError(
      `Token entropy must be at least ${MIN_TOKEN_BYTES} bytes (${MIN_TOKEN_BYTES * 8} bits).`
    );
  }
  return crypto.randomBytes(byteLength).toString('hex').toLowerCase();
}

/**
 * Computes the SHA-256 hash of a raw token.
 * Only the hash is ever persisted in database tables.
 *
 * @param {string} rawToken
 * @returns {string} 64-character lowercase hex string
 */
function hashToken(rawToken) {
  if (typeof rawToken !== 'string' || rawToken.trim().length === 0) {
    throw new TypeError('Raw token must be a non-empty string.');
  }
  return crypto.createHash('sha256').update(rawToken).digest('hex').toLowerCase();
}

/**
 * Validates whether a token string meets minimum format and entropy requirements.
 *
 * @param {string} token
 * @returns {boolean}
 */
function validateTokenFormat(token) {
  if (typeof token !== 'string') return false;
  const trimmed = token.trim();
  return trimmed.length >= MIN_TOKEN_BYTES * 2 && HEX_REGEX.test(trimmed);
}

/**
 * Validates whether a token hash meets SHA-256 hex format requirements.
 *
 * @param {string} hash
 * @returns {boolean}
 */
function validateTokenHashFormat(hash) {
  if (typeof hash !== 'string') return false;
  const trimmed = hash.trim();
  return trimmed.length === SHA256_HEX_LENGTH && HEX_REGEX.test(trimmed);
}

/**
 * Constant-time comparison of two SHA-256 token hashes.
 *
 * @param {string} hashA
 * @param {string} hashB
 * @returns {boolean}
 */
function timingSafeEqualHashes(hashA, hashB) {
  if (!validateTokenHashFormat(hashA) || !validateTokenHashFormat(hashB)) {
    return false;
  }
  const bufA = Buffer.from(hashA.toLowerCase(), 'hex');
  const bufB = Buffer.from(hashB.toLowerCase(), 'hex');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

module.exports = {
  MIN_TOKEN_BYTES,
  SHA256_HEX_LENGTH,
  generateToken,
  hashToken,
  validateTokenFormat,
  validateTokenHashFormat,
  timingSafeEqualHashes
};
