import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildWordContent} from '../tools/word-content.mjs';

test('report blocks keep document order, A4 margins and readable native tables',()=>{
  const ops=buildWordContent({title:'测试报告',blocks:[{type:'paragraph',text:'研究结论',style:'Heading1'},{type:'table',rows:[['方案','说明'],['A, B; C',''],[42,'边界']]},{type:'paragraph',text:'证据限制'}]});
  assert.equal(ops[0].props.marginLeft,'2.54cm');
  const table=ops.findIndex(op=>op.type==='table'),last=ops.findIndex(op=>op.props?.text==='证据限制');
  assert.ok(table>0&&last>table);
  assert.equal(ops[table].props.layout,'fixed');
  assert.ok(ops.some(op=>op.path==='/body/tbl[1]/tr[1]'&&op.props.header==='true'));
  assert.ok(ops.some(op=>op.props?.text==='A, B; C'));
  assert.ok(ops.some(op=>op.props?.text===''));
  assert.ok(!ops.some(op=>op.props?.['height.exact']));
});
test('report tables reject malformed rows, oversized columns and unsupported blocks',()=>{
  const run=block=>buildWordContent({title:'test',blocks:[block]});
  assert.throws(()=>run({type:'table',rows:[['a'],['b','c']]}),/矩形/);
  assert.throws(()=>run({type:'table',rows:[['a','b']],colWidths:['10cm','10cm']}),/列宽/);
  assert.throws(()=>run({type:'table',rows:[[Infinity]]}),/有限数字/);
  assert.throws(()=>run({type:'chart'}),/仅支持/);
  assert.throws(()=>run({type:'image'}),/src/);
});
