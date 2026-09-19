'use strict';

// Development-only schema application. Production schema changes are applied
// by Replit Publish; this script must never receive a production URL.
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

if (process.env.NODE_ENV === 'production' || process.env.REPLIT_DEPLOYMENT) {
  throw new Error('Refusing to apply development schema from a production process.');
}
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');

(async () => {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'automated-trading-schema.sql'), 'utf8'));
    console.log('Development automated-trading PostgreSQL schema applied.');
  } finally { await client.end(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });