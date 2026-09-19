'use strict';

function resolvePort(value, fallback = 5000) {
  const candidate = value == null || value === '' ? fallback : Number(value);
  if (!Number.isSafeInteger(candidate) || candidate < 1 || candidate > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535.');
  }
  return candidate;
}

module.exports = { resolvePort };