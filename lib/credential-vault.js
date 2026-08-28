'use strict';

const crypto = require('crypto');

const ENVELOPE_PREFIX = 'enc:v1:';
const AAD = Buffer.from('qureshi-finance/alpaca-credentials/v1', 'utf8');
const SALT = Buffer.from('qureshi-finance/alpaca-credentials/salt/v1', 'utf8');
const INFO = Buffer.from('aes-256-gcm', 'utf8');

function createCredentialVault(sessionSecret) {
  if (typeof sessionSecret !== 'string' || sessionSecret.length < 32) {
    throw new Error('A strong session secret is required to protect broker credentials.');
  }

  const key = Buffer.from(crypto.hkdfSync(
    'sha256',
    Buffer.from(sessionSecret, 'utf8'),
    SALT,
    INFO,
    32,
  ));

  function encrypt(value) {
    if (typeof value !== 'string' || !value) {
      throw new Error('Cannot encrypt an empty broker credential.');
    }
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(AAD);
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${ENVELOPE_PREFIX}${Buffer.concat([nonce, tag, encrypted]).toString('base64url')}`;
  }

  function decrypt(envelope) {
    if (typeof envelope !== 'string' || !envelope.startsWith(ENVELOPE_PREFIX)) {
      throw new Error('Broker credential is not an encrypted envelope.');
    }
    let payload;
    try {
      payload = Buffer.from(envelope.slice(ENVELOPE_PREFIX.length), 'base64url');
    } catch (_) {
      throw new Error('Broker credential envelope is malformed.');
    }
    if (payload.length <= 28) throw new Error('Broker credential envelope is malformed.');
    const nonce = payload.subarray(0, 12);
    const tag = payload.subarray(12, 28);
    const ciphertext = payload.subarray(28);
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
      decipher.setAAD(AAD);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch (_) {
      throw new Error('Broker credential cannot be decrypted. Reconnect the account before trading.');
    }
  }

  return { encrypt, decrypt, isEncrypted: value => typeof value === 'string' && value.startsWith(ENVELOPE_PREFIX) };
}

module.exports = { createCredentialVault, ENVELOPE_PREFIX };