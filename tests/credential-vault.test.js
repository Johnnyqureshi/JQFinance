'use strict';

const assert = require('assert');
const { createCredentialVault } = require('../lib/credential-vault');

const vault = createCredentialVault('a-session-secret-that-is-long-enough-to-derive-a-separate-key');
const first = vault.encrypt('APCA-KEY-ONE');
const second = vault.encrypt('APCA-KEY-ONE');

assert(vault.isEncrypted(first));
assert.notStrictEqual(first, second, 'fresh nonces must produce different ciphertext');
assert.strictEqual(vault.decrypt(first), 'APCA-KEY-ONE');
assert.throws(() => vault.decrypt(`${first.slice(0, -2)}xx`), /cannot be decrypted|malformed/);
assert.throws(() => createCredentialVault('short'), /strong session secret/);

console.log('credential vault tests passed');