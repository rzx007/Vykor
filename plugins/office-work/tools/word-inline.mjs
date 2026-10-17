const keys=['bold','italic','size','color'];
export function inlineRange(paragraph,props) {
  const start=paragraph.text.indexOf(props.find);
  if(start<0||paragraph.text.indexOf(props.find,start+1)>=0)throw new Error('局部格式文字在段落中须恰好出现一次。');
  const runs=paragraph.children;
  if(!runs?.length||runs.some(r=>r.type!=='run'||r.childCount!==0||typeof r.text!=='string')||runs.map(r=>r.text).join('')!==paragraph.text)throw new Error('局部格式仅支持普通文字段落；不拆改含链接、字段或复杂内嵌对象的内容。');
  return [start,start+props.find.length];
}
function runFormat(format) {
  const result={...format};
  for(const key of keys)if(key in result){delete result[`effective.${key}`];delete result[`effective.${key}.src`];}
  return result;
}
export function checkInlineChange(before,after,props,same) {
  const [start,end]=inlineRange(before,props);
  inlineRange(after,props);
  if(before.text!==after.text)throw new Error('局部格式意外改变段落文字，未保存修改。');
  const spans=node=>{let offset=0;return node.children.map(run=>{const span={start:offset,end:offset+run.text.length,run};offset=span.end;return span;});};
  const oldRuns=spans(before),newRuns=spans(after);
  const boundaries=[...new Set([0,before.text.length,start,end,...oldRuns.flatMap(r=>[r.start,r.end]),...newRuns.flatMap(r=>[r.start,r.end])])].sort((a,b)=>a-b);
  for(let i=0;i<boundaries.length-1;i++) {
    const at=boundaries[i],oldRun=oldRuns.find(r=>r.start<=at&&r.end>at)?.run,newRun=newRuns.find(r=>r.start<=at&&r.end>at)?.run;
    if(!oldRun||!newRun)throw new Error('局部格式文字片段回读不完整。');
    const expected=runFormat(oldRun.format),actual=runFormat(newRun.format);
    if(at>=start&&at<end)for(const key of keys)if(props[key]!==undefined){expected[key]=props[key];delete expected[`effective.${key}`];delete expected[`effective.${key}.src`];}
    if(!same(expected,actual))throw new Error('局部格式回读不符或影响了其他文字，未保存修改。');
    if(!same({...oldRun,text:'',format:{}},{...newRun,text:'',format:{}}))throw new Error('局部格式改变了文字片段结构，未保存修改。');
  }
  const expected=structuredClone(before);
  expected.children=after.children;expected.childCount=after.childCount;
  // Paragraph summaries reflect its first run; keep paragraph-mark and layout protected.
  for(const key of keys)for(const name of [key,`effective.${key}`,`effective.${key}.src`]) {
    if(name in after.format)expected.format[name]=after.format[name];else delete expected.format[name];
  }
  if(!same(expected,after))throw new Error('局部格式影响了段落其他设置，未保存修改。');
  return {find:props.find,start,end};
}
