'use strict';

function createMomentumInverseCycleStore(db) {
  if (!db?.prepare) throw new Error('A database connection is required.');
  return {
    get(userId) {
      const row = db.prepare(`
        SELECT last_inverse_at,last_inverse_status,last_inverse_reason,last_inverse_symbol
        FROM momentum_settings WHERE user_id=?
      `).get(userId);
      return {
        at: row?.last_inverse_at || null,
        status: row?.last_inverse_status || null,
        reason: row?.last_inverse_reason || null,
        symbol: row?.last_inverse_symbol || null,
      };
    },
    update(userId, status, reason, symbol) {
      db.prepare(`
        UPDATE momentum_settings
        SET last_inverse_at=datetime('now'),last_inverse_status=?,
            last_inverse_reason=?,last_inverse_symbol=?
        WHERE user_id=?
      `).run(status, String(reason || '').slice(0, 500), symbol || null, userId);
    },
  };
}

module.exports = { createMomentumInverseCycleStore };