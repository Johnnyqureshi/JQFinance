'use strict';

function findDuplicateBrokerAssignments(rows) {
  const ownersByAccount = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const accountId = String(row?.account_id || '').trim();
    if (!accountId) continue;
    if (!ownersByAccount.has(accountId)) ownersByAccount.set(accountId, new Set());
    ownersByAccount.get(accountId).add(`${row.user_id}:${row.scope}`);
  }
  return [...ownersByAccount.entries()]
    .filter(([, owners]) => owners.size > 1)
    .map(([accountId]) => accountId)
    .sort();
}

module.exports = { findDuplicateBrokerAssignments };