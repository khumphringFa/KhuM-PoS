import test from 'node:test';import assert from 'node:assert/strict';
import {lineTotal,totals,validateCart,integer} from '../public/core.js';
const p={id:'rice',name:'Rice',price:7200,cost:6000,stock:5000,expiry:''};
test('weighted items use integer quantities and paisa',()=>{assert.equal(lineTotal(7200,1250),9000);assert.deepEqual(totals([{price:7200,qty:1250}],500),{subtotal:9000,discount:500,total:8500});});
test('reject overselling, expired goods, duplicate lines and stale price',()=>{for(const [lines,products] of [[[{product_id:'rice',price:7200,qty:6000}],[p]],[[{product_id:'rice',price:7200,qty:1000}],[{...p,expiry:'2020-01-01'}]],[[{product_id:'rice',price:7200,qty:1000},{product_id:'rice',price:7200,qty:1000}],[p]],[[{product_id:'rice',price:7100,qty:1000}],[p]]])assert.throws(()=>validateCart(lines,products,'2026-11-15'));});
test('reject invalid financial input',()=>{for(const n of [NaN,Infinity,-1,0.5,'5',1e15])assert.throws(()=>integer(n));assert.throws(()=>totals([{price:100,qty:1000}],101));});
test('cart uses authoritative names and costs',()=>{assert.equal(validateCart([{product_id:'rice',price:7200,qty:1000,name:'fake',cost:0}],[p])[0].cost,6000);});
