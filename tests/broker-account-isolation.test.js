'use strict';

const assert = require('assert');
const { findDuplicateBrokerAssignments } = require('../lib/broker-account-isolation');

const duplicates = findDuplicateBrokerAssignments([
  { account_id:'same-owner', user_id:1, scope:'swing', mode:'paper' },
  { account_id:'same-owner', user_id:1, scope:'swing', mode:'live' },
  { account_id:'cross-scope', user_id:1, scope:'manual' },
  { account_id:'cross-scope', user_id:1, scope:'swing' },
  { account_id:'cross-user', user_id:1, scope:'momentum' },
  { account_id:'cross-user', user_id:2, scope:'momentum' },
]);

assert.deepStrictEqual(duplicates, ['cross-scope', 'cross-user']);
console.log('broker account isolation migration tests passed');