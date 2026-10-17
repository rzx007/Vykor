const only=(v,keys)=>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!keys.includes(k)))throw new Error('包含不支持的表格字段。');};
const cm=1440/2.54;
export const tableActions=['table_layout','insert_row','remove_row','insert_column','remove_column'];
export function tableEdit(item) {
  only(item,['action','path','props']);
  if(typeof item.path!=='string'||!/^\/body\/tbl\[[1-9]\d*\]$/i.test(item.path))throw new Error('请使用读取返回的正文表格路径。');
  const allowed=item.action==='table_layout'?['colWidths','repeat_header','allow_row_split']:item.action.startsWith('insert_')?['index','values','colWidths']:['index','expected_values','colWidths'];
  only(item.props,allowed);const props={...item.props};
  if(item.action==='table_layout'&&!Object.keys(props).length)throw new Error('至少提供一项表格排版设置。');
  for(const key of ['repeat_header','allow_row_split'])if(key in props&&typeof props[key]!=='boolean')throw new Error('表头与跨页设置须为布尔值。');
  if(props.colWidths!==undefined) {
    if(!Array.isArray(props.colWidths)||!props.colWidths.length||props.colWidths.length>8)throw new Error('列宽须为 1–8 项 cm 数组。');
    props.widths=props.colWidths.map(v=>{
      if(typeof v!=='string'||!/^\d+(?:\.\d+)?cm$/.test(v))throw new Error('列宽须使用 cm。');
      const width=Math.round(parseFloat(v)*cm);if(width<720||width>16000)throw new Error('每列至少 1.27cm，且不能超出页面。');return width;
    });delete props.colWidths;
  }
  if(item.action!=='table_layout') {
    if(!Number.isSafeInteger(props.index)||props.index<1)throw new Error('行列位置 index 须为从 1 开始的整数；插入到该位置之前，末尾可用数量加一。');
    const key=item.action.startsWith('insert_')?'values':'expected_values';
    if(!Array.isArray(props[key])||props[key].length<1||props[key].length>20||props[key].some(v=>typeof v!=='string'||v.length>2000))throw new Error('请提供文字数组，删除时传入刚读取的整行或整列原文。');
    if(item.action.endsWith('column')&&!props.widths)throw new Error('增删列须显式指定调整后所有列的 colWidths。');
  }
  return {action:item.action,path:item.path.toLowerCase(),props};
}
function shape(table) {
  const rows=table.children,cols=rows?.[0]?.children?.length;
  if(table.type!=='table'||!rows?.length||rows.length>20||!cols||cols>8||rows.some(r=>r.type!=='row'||r.children.length!==cols||r.children.some(c=>c.type!=='cell'||c.format?.colspan>1||Object.keys(c.format??{}).some(k=>/merge|span/i.test(k))||c.children.some(p=>p.type!=='paragraph'))))throw new Error('仅支持最多 20 行、8 列且没有合并单元格或嵌套表格的矩形表格。');
  return {rows:rows.length,cols};
}
export function tableCommands(table,op,body) {
  const {rows,cols}=shape(table),p=op.props,rowOp=op.action.endsWith('row'),inserting=op.action.startsWith('insert_'),removing=op.action.startsWith('remove_');
  const count=rowOp?rows:cols,newRows=rows+(rowOp?(inserting?1:removing?-1:0):0),newCols=cols+(!rowOp?(inserting?1:removing?-1:0):0);
  if(newRows<1||newRows>20||newCols<1||newCols>8)throw new Error('编辑后须保留 1–20 行、1–8 列。');
  if(op.action!=='table_layout') {
    if(p.index>count+(inserting?1:0))throw new Error('行列位置超出当前表格。');
    const values=rowOp?table.children[p.index-1]?.children.map(c=>c.text):table.children.map(r=>r.children[p.index-1]?.text);
    if(removing&&JSON.stringify(values)!==JSON.stringify(p.expected_values))throw new Error('待删除行列原文不符，请重新读取。');
    if(inserting&&p.values.length!==(rowOp?cols:rows))throw new Error('新增行列的文字数量与表格不符。');
  }
  if(p.widths) {
    const sections=body.children.filter(n=>n.type==='section');
    const lengths=['pageWidth','marginLeft','marginRight'].map(k=>sections.length===1&&sections[0].format?.[k]);
    if(lengths.some(v=>typeof v!=='string'||!/^\d+(?:\.\d+)?cm$/.test(v)))throw new Error('无法确定单节正文宽度，暂不调整列宽。');
    const available=Math.round((parseFloat(lengths[0])-parseFloat(lengths[1])-parseFloat(lengths[2]))*cm);
    if(p.widths.length!==newCols||p.widths.reduce((a,b)=>a+b,0)>available+3)throw new Error('列宽数量须匹配修改后列数，总宽不能超过正文宽度。');
  }
  const path=table.path,ops=[];
  if(inserting)ops.push({command:'add',parent:path,type:rowOp?'row':'column',index:p.index-1,props:rowOp?{}:{width:String(p.widths[p.index-1]),text:''}});
  if(removing)ops.push({command:'remove',path:`${path}/${rowOp?'tr':'col'}[${p.index}]`});
  if(inserting) {
    for(let i=0;i<p.values.length;i++) {
      const row=rowOp?p.index:i+1,col=rowOp?i+1:p.index;
      ops.push({command:'set',path:`${path}/tr[${row}]/tc[${col}]`,props:{text:p.values[i],font:'Microsoft YaHei',size:'10.5pt',bold:'false'}});
    }
    if(rowOp)ops.push({command:'set',path:`${path}/tr[${p.index}]`,props:{header:'false',cantSplit:'true'}});
  }
  if(p.widths) {
    ops.push({command:'set',path,props:{width:String(p.widths.reduce((a,b)=>a+b,0)),layout:'fixed'}});
    for(let r=1;r<=newRows;r++)for(let c=1;c<=newCols;c++)ops.push({command:'set',path:`${path}/tr[${r}]/tc[${c}]`,props:{width:String(p.widths[c-1])}});
  }
  if(p.repeat_header!==undefined)ops.push({command:'set',path:`${path}/tr[1]`,props:{header:String(p.repeat_header)}});
  if(p.allow_row_split!==undefined)for(let r=1;r<=newRows;r++)ops.push({command:'set',path:`${path}/tr[${r}]`,props:{cantSplit:String(!p.allow_row_split)}});
  return ops;
}
// Build the expected tree from the original, admitting only requested changes.
export function checkTableChange(before,after,op,same) {
  const expected=structuredClone(before),p=op.props,index=p.index-1,rowOp=op.action.endsWith('row');
  shape(after);
  const newCell=(cell,text)=>{if(!cell||cell.text!==text||cell.children.length!==1||cell.children[0].text!==text)throw new Error('新增单元格文字回读不符，未保存修改。');return structuredClone(cell);};
  if(op.action==='insert_row') {
    const row=after.children[index];if(!row||row.children.length!==p.values.length)throw new Error('新增行回读不符。');
    row.children.forEach((c,i)=>newCell(c,p.values[i]));expected.children.splice(index,0,structuredClone(row));
  }
  if(op.action==='remove_row')expected.children.splice(index,1);
  if(op.action==='insert_column')expected.children.forEach((r,i)=>{r.children.splice(index,0,newCell(after.children[i]?.children[index],p.values[i]));r.childCount=r.children.length;});
  if(op.action==='remove_column')expected.children.forEach(r=>{r.children.splice(index,1);r.childCount=r.children.length;});
  expected.childCount=expected.children.length;
  for(const [key,value] of Object.entries({rows:expected.children.length,cols:expected.children[0].children.length,_gridCols:expected.children[0].children.length})) {
    if(Number(after.format?.[key])!==value)throw new Error('表格行列数量回读不符。');
    expected.format[key]=after.format[key];
  }
  if(p.widths) {
    const total=p.widths.reduce((a,b)=>a+b,0),widths=after.format.colWidths?.split(',').map(v=>/^\d+dxa$/.test(v)?parseInt(v):NaN);
    if(JSON.stringify(widths)!==JSON.stringify(p.widths)||Number(after.format.width)!==total||after.format.layout!=='fixed')throw new Error('表格列宽回读不符，未保存修改。');
    for(const key of ['colWidths','width','layout'])expected.format[key]=after.format[key];
    expected.children.forEach((r,ri)=>r.children.forEach((c,ci)=>{
      if(after.children[ri]?.children[ci]?.format.width!==`${p.widths[ci]}dxa`||after.children[ri].children[ci].format._widthDerived===true)throw new Error('单元格列宽回读不符。');
      c.format.width=`${p.widths[ci]}dxa`;
      // Explicitly setting a previously grid-derived width clears this readback flag.
      delete c.format._widthDerived;
    }));
  }
  const flag=(row,actual,key,value)=>{if(Boolean(actual.format[key])!==value)throw new Error('表头或跨页设置回读不符。');if(key in actual.format)row.format[key]=actual.format[key];else delete row.format[key];};
  if(p.repeat_header!==undefined)flag(expected.children[0],after.children[0],'header',p.repeat_header);
  if(p.allow_row_split!==undefined)expected.children.forEach((r,i)=>flag(r,after.children[i],'cantSplit',!p.allow_row_split));
  if(!same(expected,after))throw new Error('表格编辑影响了未请求的文字、格式或结构，未保存修改。');
}
