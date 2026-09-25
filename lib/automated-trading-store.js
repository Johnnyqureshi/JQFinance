'use strict';

const { Pool } = require('pg');

const REQUIRED_TABLES = Object.freeze([
  'broker_account_owners', 'broker_account_quarantine', 'automatic_live_bot_arms',
  'b2_settings', 'b2_credentials', 'b2_leases', 'b2_universe', 'b2_coverage',
  'b2_candidates', 'b2_trades', 'b2_exit_fills', 'b2_close_attempts', 'b2_alerts',
  'options_settings', 'options_alpaca_creds', 'options_alpaca_active_mode',
  'options_candidates', 'options_entry_reservations', 'options_trades',
  'options_fills', 'options_alerts', 'options_events', 'options_execution_leases',
  'broker_order_intents',
  'sd_settings', 'sd_credentials', 'sd_trades', 'sd_exit_fills', 'sd_close_attempts',
  'sd_scan_runs', 'sd_rejections', 'sd_candidates', 'sd_universe', 'sd_coverage',
  'sd_leases', 'sd_alerts',
]);

function isConnectivityError(error) {
  const code = String(error?.code || '').toUpperCase();
  return /^(ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|57P01|57P02|57P03|08)/.test(code)
    || /connection\s+(?:terminated|timeout|refused|reset)|timed?\s*out/i.test(String(error?.message || ''));
}

function createAutomatedTradingStore({ databaseUrl, pool: injectedPool } = {}) {
  if (!databaseUrl && !injectedPool) throw new Error('DATABASE_URL is required for automated trading persistence.');
  const pool = injectedPool || new Pool({
    connectionString: databaseUrl, max: 5, connectionTimeoutMillis: 8000,
    keepAlive: true, keepAliveInitialDelayMillis: 10000, maxLifetimeSeconds: 300,
  });
  let ready = false;
  let lastError = null;
  pool.on?.('error', error => {
    lastError = error;
    console.error('[TradingStore] PostgreSQL pool connection error:', error.message);
  });

  async function query(text, values = []) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try { return await pool.query(text, values); }
      catch (error) {
        lastError = error;
        if (!isConnectivityError(error) || attempt) throw error;
        await new Promise(resolve => setTimeout(resolve, 150));
      }
    }
    throw new Error('Automated trading PostgreSQL query failed.');
  }
  async function init() {
    const result = await query(`
      SELECT COUNT(*)::int AS count
      FROM pg_catalog.pg_tables
      WHERE schemaname='public' AND tablename = ANY($1::text[])
    `, [REQUIRED_TABLES]);
    if (Number(result.rows[0]?.count) !== REQUIRED_TABLES.length) {
      throw new Error('Automated trading PostgreSQL schema is missing; publish the development schema before enabling entries.');
    }
    ready = true; lastError = null;
    return { ready: true };
  }
  async function transaction(work) {
    if (!ready) throw new Error('Automated trading persistence is unavailable; entries remain paused.');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw error;
    } finally { client.release(); }
  }
  async function prepareIntent(client, intent) {
    if (!client || !intent?.strategy || !intent.accountId || !intent.clientOrderId) {
      throw new Error('Invalid broker intent.');
    }
    return client.query(`
      INSERT INTO broker_order_intents
        (user_id,strategy,account_id,mode,trade_id,purpose,client_order_id,request,state,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,'prepared',NOW())
      ON CONFLICT (strategy,account_id,client_order_id)
      DO UPDATE SET updated_at=NOW()
      RETURNING *
    `, [intent.userId, intent.strategy, intent.accountId, intent.mode, intent.tradeId || null,
      intent.purpose, intent.clientOrderId, JSON.stringify(intent.request || {})]);
  }
  return {
    query, transaction, prepareIntent, init,
    isReady: () => ready,
    lastError: () => lastError,
    close: () => injectedPool ? Promise.resolve() : pool.end(),
    requiredTables: REQUIRED_TABLES,
  };
}

module.exports = { createAutomatedTradingStore, isConnectivityError, REQUIRED_TABLES };