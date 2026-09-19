'use strict';

const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const { restoreAutomatedSnapshot } = require('../lib/automated-state');

(async () => {
  const dbPath = path.join(__dirname, '..', 'automated-trading.db');
  const ownerId = process.env.AUTOMATED_STATE_OWNER_ID || crypto.randomUUID();
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 8000 });
  const fence = await pool.query(`
    INSERT INTO automated_trading_fences(owner_id,epoch,lease_until,updated_at)
    VALUES ($1,1,NOW()+INTERVAL '30 seconds',NOW())
    ON CONFLICT (singleton) DO UPDATE SET owner_id=EXCLUDED.owner_id,
      epoch=automated_trading_fences.epoch+1, lease_until=EXCLUDED.lease_until, updated_at=NOW()
    WHERE automated_trading_fences.owner_id IS NULL
       OR automated_trading_fences.lease_until IS NULL
       OR automated_trading_fences.lease_until < NOW()
       OR automated_trading_fences.owner_id=EXCLUDED.owner_id
    RETURNING epoch
  `, [ownerId]);
  if (!fence.rowCount) throw new Error('Another VM owns the automated trading fence.');
  process.env.AUTOMATED_STATE_OWNER_ID = ownerId;
  const result = await restoreAutomatedSnapshot({
    databaseUrl: process.env.DATABASE_URL,
    dbPath,
  });
  await pool.end();
  process.env.AUTOMATED_STATE_RESTORED = result.restored ? 'true' : 'false';
  console.log(`[AutomatedState] startup ${result.restored ? `restored generation ${result.generation}` : 'found no durable snapshot'}`);
  require('../server');
})().catch(error => {
  console.error(`[AutomatedState] startup blocked: ${error.message}`);
  process.exitCode = 1;
});