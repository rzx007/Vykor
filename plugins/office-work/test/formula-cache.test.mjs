import {test} from 'node:test';
import assert from 'node:assert/strict';
import {formulaReport} from '../tools/excel-content.mjs';
const root=(format)=>({type:'cell',path:'/S/A1',format});
test('computed formulas without saved cache are not current',()=>{
 const r=formulaReport(root({formula:'2*3',computedValue:'6'}));
 assert.equal(r.evaluator_all_computed,true);
 assert.equal(r.cached_values_current,false);
 assert.equal(r.missing_cache_cells.length,1);
 const empty=formulaReport(root({formula:'2*3',cachedValue:null,computedValue:'6'}));
 assert.equal(empty.cached_values_current,false);assert.equal(empty.stale_cache_cells.length,0);
});
test('formula cache distinguishes zero, stale values and unevaluated formulas',()=>{
 assert.equal(formulaReport(root({formula:'0',cachedValue:0,computedValue:0})).cached_values_current,true);
 assert.equal(formulaReport(root({formula:'2*3',cachedValue:'5',computedValue:'6'})).stale_cache_cells.length,1);
 assert.equal(formulaReport(root({formula:'X()'})).cached_values_current,false);
});
