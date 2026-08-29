'use strict';
const assert=require('assert'); const {sanitizeSwingExecutionConfig,calculateLongQuantity,buildSwingEntryOrder}=require('../lib/swing-execution-policy');
const x=sanitizeSwingExecutionConfig({maxPositionDollars:9999,maxRiskDollars:9999},{maxPositionDollars:500,maxRiskDollars:50});
assert.equal(x.maxPositionDollars,500); assert.equal(x.maxRiskDollars,50); assert.equal(calculateLongQuantity({entry:10,stop:9,maxPositionDollars:100,maxRiskDollars:5}),5);
assert.equal(calculateLongQuantity({entry:10.01,stop:9,maxPositionDollars:100,maxRiskDollars:999}),9);
const order=buildSwingEntryOrder({symbol:'abc',qty:2,clientOrderId:'swing-ABC-T1-TP1-0',limitPrice:10.01,stop:9,target:12});
assert.equal(order.type,'limit'); assert.equal(order.time_in_force,'gtc'); assert.equal(order.limit_price,'10.01');
console.log(' ✓ swing execution policy');