'use strict';
const assert=require('assert');
const p=require('../lib/leap-options-execution-policy');
const now=Date.UTC(2025,0,1);
const contracts=[
 {symbol:'QQQ260101C00550000',underlying_symbol:'QQQ',type:'call',expiration_date:'2026-01-01',strike_price:550,multiplier:100},
 {symbol:'QQQ260101C00560000',underlying_symbol:'QQQ',type:'call',expiration_date:'2026-01-01',strike_price:560,multiplier:100},
 {symbol:'QQQ270101C00550000',underlying_symbol:'QQQ',type:'call',expiration_date:'2027-01-01',strike_price:550,multiplier:100},
];
assert.equal(p.selectLeapContract(contracts,{symbol:'QQQ',underlyingPrice:505,now}).symbol,'QQQ260101C00560000');
assert.equal(p.selectLeapContract([{...contracts[0],multiplier:10}],{symbol:'QQQ',underlyingPrice:500,now}),null);
const quote={bid:10,ask:11,timestamp:new Date(now).toISOString()};
assert(p.normalizeOptionQuote(quote,{now}));
assert.equal(p.normalizeOptionQuote({...quote,bid:11},{now}),null);
assert.equal(p.normalizeOptionQuote({...quote,ask:30},{now}),null);
assert.equal(p.normalizeOptionQuote({...quote,timestamp:new Date(now-61000).toISOString()},{now}),null);
assert(p.quotePassesLeapGates({...contracts[0],open_interest:1,volume:1},quote,{now}));
assert.equal(p.quotePassesLeapGates({...contracts[0],open_interest:0},quote,{now}),null);
assert.equal(p.calculateLeapContracts({equity:100000,maxPositionDollars:3000,premium:10,multiplier:100}),3);
const id=p.immutableLeapClientOrderId({symbol:'QQQ',contractSymbol:'QQQ260101C00560000',nonce:'once'});
assert(/^jqf-leap-/.test(id));
assert(id.length <= 48);
assert.notEqual(id,p.immutableLeapClientOrderId({symbol:'QQQ',contractSymbol:'QQQ260101C00570000',nonce:'once'}));
const entry=p.buildLeapEntryOrder({contractSymbol:'QQQ260101C00560000',quantity:2,limitPrice:11,clientOrderId:id});
const target=p.buildLeapTargetOrder({contractSymbol:entry.symbol,quantity:2,averageEntryPremium:10.25,clientOrderId:id.replace('entry','target')});
assert(Object.isFrozen(entry)); assert.equal(target.limit_price,'20.50');
console.log(' ✓ LEAP options execution policy');