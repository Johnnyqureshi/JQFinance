'use strict';
const assert=require('assert');
const {calculateSwingAllocations,ratchetSwingStop,buildSwingClientOrderId}=require('../lib/swing-management');
let failed=0; function test(n,f){try{f();console.log(` ✓ ${n}`)}catch(e){failed++;console.error(` ✗ ${n}: ${e.message}`)}}
test('allocations never exceed fill',()=>{const x=calculateSwingAllocations(7);assert.deepStrictEqual(x,{filledQuantity:7,target1:1,target2:1,target3:1,final:4});assert.equal(x.target1+x.target2+x.target3+x.final,7)});
test('tiny quantities stay integer-safe and preserve a runner',()=>{assert.deepStrictEqual(calculateSwingAllocations(1),{filledQuantity:1,target1:0,target2:0,target3:0,final:1});assert.deepStrictEqual(calculateSwingAllocations(3),{filledQuantity:3,target1:0,target2:0,target3:0,final:3});});
test('stops only ratchet upward',()=>assert.equal(ratchetSwingStop(10,9),10));
test('stops accept only a finite tighter level',()=>{assert.equal(ratchetSwingStop(10,11),11);assert.equal(ratchetSwingStop(10,NaN),10);});
test('client identifiers are strategy owned and deterministic',()=>assert.equal(buildSwingClientOrderId({symbol:'abc',tradeId:'t-1',purpose:'target',sequence:2}),'swing-ABC-T1-TARGET-2'));
if(failed)process.exit(1);