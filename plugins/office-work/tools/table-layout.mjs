const cm=72/2.54;
function length(value, fallback, zero=false) {
  if (value===undefined) return fallback;
  const match=String(value).match(/^(\d+(?:\.\d+)?)\s*(cm|mm|in|pt)$/i);
  if (!match) throw new Error('表格尺寸须带 cm、mm、in 或 pt 单位。');
  const points=Number(match[1])*({cm,mm:cm/10,in:72,pt:1}[match[2].toLowerCase()]);
  if (!Number.isFinite(points)||points<(zero?0:1)) throw new Error('表格尺寸须为有效正数。');
  return points;
}

// Conservative estimate only; font substitution and actual viewer layout still need review.
export function tableLayout(table) {
  const rows=table.rows, count=rows[0].length;
  const size=table.size===undefined?16:length(table.size,16);
  if (size<12||size>28) throw new Error('表格字号须为 12–28pt；不要缩成不可读的小字。');
  const x=length(table.x,1.6*cm,true), y=length(table.y,3.5*cm,true);
  const columns=table.colWidths===undefined?null:String(table.colWidths).split(',').map(s=>length(s.trim()));
  const width=length(table.width,columns?columns.reduce((a,b)=>a+b,0):30.7*cm);
  if (columns&&(columns.length!==count||Math.abs(columns.reduce((a,b)=>a+b,0)-width)>0.5)) throw new Error('列宽数量须与列数相同，列宽总和须等于表格宽度。');
  const widths=columns||Array(count).fill(width/count);
  if (x+width>960-18||widths.some(w=>w<36)) throw new Error('表格超出页面或列宽过窄，请调整列宽或拆页。');
  const estimated=rows.map(row=>Math.max(32,...row.map((cell,col)=>{
    const available=widths[col]-12;
    const lines=String(cell).split(/\r?\n/).reduce((total,line)=>{
      const units=Array.from(line).reduce((sum,char)=>sum+(/[\x00-\x7f]/.test(char)?0.65:1.05),0);
      return total+Math.max(1,Math.ceil(units*size/available));
    },0);
    return Math.ceil(lines*size*1.3+12);
  })));
  const uniform=table.rowHeight===undefined?null:length(table.rowHeight);
  if (uniform!==null&&estimated.some(height=>uniform<height)) throw new Error('指定行高不足以容纳文字，请增大行高、精简内容或拆页。');
  const rowHeights=uniform===null?estimated:estimated.map(()=>uniform);
  const minimum=rowHeights.reduce((a,b)=>a+b,0), height=length(table.height,minimum);
  if (height<minimum-0.5) throw new Error(`指定高度不足，估算至少需要 ${minimum}pt；请增高、精简内容或拆页。`);
  if (y+height>540-24) throw new Error('表格按当前字号与文字量将超出页面，请精简内容、调整列宽或拆页。');
  const extra=(height-minimum)/rowHeights.length;
  const finalRows=rowHeights.map(h=>h+extra);
  return {size,x,y,width,height:finalRows.reduce((a,b)=>a+b,0),widths,rowHeights:finalRows};
}

// Only explicit text boxes can be checked without guessing OfficeCLI defaults.
// Keep backgrounds and horizontally separate content out of this narrow guard.
export function assertTableTextClearance(table,shapes,page,tableNumber) {
  const points=value=>{
    const match=String(value??'').match(/^(\d+(?:\.\d+)?)\s*(cm|mm|in|pt|pc|px|q|emu)$/i);
    return match?Number(match[1])*({cm,mm:cm/10,in:72,pt:1,pc:12,px:0.75,q:cm/40,emu:1/12700}[match[2].toLowerCase()]):undefined;
  };
  const gap=6, bottom=table.y+table.height;
  for(const [i,shape] of (shapes??[]).entries()) {
    if(shape.text===undefined||!String(shape.text).trim()) continue;
    const [x,y,width,height]=['x','y','width','height'].map(key=>points(shape[key]));
    if([x,y,width,height].some(value=>value===undefined)||width<=0||height<=0) continue;
    if(x>=table.x+table.width||x+width<=table.x||y>=bottom+gap||y+height+gap<=table.y) continue;
    const start=Math.ceil((bottom+gap)/cm*100)/100;
    const advice=start*cm+height<=540-24
      ?`请将下方文本框的 y 调整到至少 ${start.toFixed(2)}cm，或重新安排表格与文字。`
      :'本页下方空间不足，请精简文字或拆页。';
    throw new Error(`第 ${page} 页第 ${tableNumber} 个表格（底部 ${(bottom/cm).toFixed(2)}cm）与第 ${i+1} 个文本框${shape.name?`（${shape.name}）`:''}重叠或间距不足 6pt。${advice}`);
  }
}
