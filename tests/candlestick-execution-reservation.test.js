'use strict';
const assert = require('assert');
const Database = require('better-sqlite3');

let passed = 0; let failed = 0;
function test(name, fn) { try { fn(); console.log(`  ✓ ${name}`); passed++; } catch (error) { console.error(`  ✗ ${name}\n    ${error.message}`); failed++; } }
const db = new Database(':memory:');
db.exec(`CREATE TABLE candlestick_signal_reservations (
  user_id INTEGER NOT NULL, symbol TEXT NOT NULL, signal_bar_at TEXT NOT NULL, trade_id INTEGER,
  PRIMARY KEY (user_id, symbol, signal_bar_at)
)`);
const reserve = db.prepare('INSERT OR IGNORE INTO candlestick_signal_reservations (user_id,symbol,signal_bar_at) VALUES (?,?,?)');

console.log('\nUltraBot3 signal reservations\n');
test('atomically gives one execution cycle ownership of a completed signal', () => {
  assert.strictEqual(reserve.run(7, 'NVDA', '2026-08-25T14:30:00Z').changes, 1);
  assert.strictEqual(reserve.run(7, 'NVDA', '2026-08-25T14:30:00Z').changes, 0);
  assert.strictEqual(reserve.run(7, 'NVDA', '2026-08-25T14:35:00Z').changes, 1);
});
test('keeps different accounts isolated while preventing per-account duplicates', () => {
  assert.strictEqual(reserve.run(8, 'NVDA', '2026-08-25T14:30:00Z').changes, 1);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS count FROM candlestick_signal_reservations').get().count, 3);
});
db.close();
console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);