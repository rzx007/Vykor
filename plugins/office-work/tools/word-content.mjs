const cm=1440/2.54;
const text=(v,max=12000)=>{if(typeof v!=='string'||!v.trim()||v.length>max)throw new Error('文字须非空且不超过允许长度。');return v;};
const only=(v,keys)=>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!keys.includes(k)))throw new Error('包含不支持的内容字段。');};
export function buildWordContent(input) {
  if(!Array.isArray(input.blocks)||!input.blocks.length||input.blocks.length>120)throw new Error('文档须提供 1–120 个有序 blocks。');
  const ops=[{command:'set',path:'/body/sectPr[1]',props:{pageWidth:'21cm',pageHeight:'29.7cm',marginTop:'2.54cm',marginBottom:'2.54cm',marginLeft:'2.54cm',marginRight:'2.54cm'}}];
  let tables=0,paragraphs=0,images=0;
  const paragraph=(value,title=false)=>{
    only(value,['type','text','style','align','pageBreakBefore','keepNext','keepLines','widowControl']);
    const style=title?'Title':value.style??'Normal';
    if(!['Title','Heading1','Heading2','Normal'].includes(style)||(!title&&style==='Title'))throw new Error('正文样式仅支持 Normal、Heading1、Heading2。');
    if(value.align!==undefined&&!['left','center','right','justify'].includes(value.align))throw new Error('段落对齐方式无效。');
    const pagination={};
    for(const key of ['pageBreakBefore','keepNext','keepLines','widowControl'])if(value[key]!==undefined){if(typeof value[key]!=='boolean')throw new Error('分页控制须为布尔值。');pagination[key]=String(value[key]);}
    ops.push({command:'add',parent:'/body',type:'paragraph',props:{text:text(value.text),style,font:'Microsoft YaHei',size:({Title:'22pt',Heading1:'16pt',Heading2:'14pt',Normal:'11pt'})[style],align:value.align??'left',lineSpacing:'1.5x',spaceAfter:'6pt',...(style!=='Normal'?{keepNext:'true',keepLines:'true'}:{}),...pagination}});
    paragraphs++;
  };
  paragraph({text:input.title},true);
  for(const block of input.blocks) {
    if(block.type==='paragraph') {paragraph(block);continue;}
    if(block.type==='image') {
      if(++images>8)throw new Error('单次最多插入 8 张图片。');
      ops.push(...imageBlocks(wordImage(block),paragraphs+1));paragraphs+=3;continue;
    }
    if(block.type!=='table')throw new Error('blocks 仅支持 paragraph、table 和 image。');
    only(block,['type','rows','colWidths']);
    const rows=block.rows,cols=rows?.[0]?.length;
    if(!Array.isArray(rows)||!rows.length||rows.length>20||!Number.isSafeInteger(cols)||cols<1||cols>8||rows.some(r=>!Array.isArray(r)||r.length!==cols))throw new Error('表格须为 1–20 行、1–8 列的矩形。');
    const total=Math.floor(15.92*cm);
    if(block.colWidths!==undefined&&!Array.isArray(block.colWidths))throw new Error('colWidths 须为 cm 列宽数组。');
    const widths=block.colWidths===undefined?Array.from({length:cols},(_,i)=>Math.floor(total/cols)+(i===cols-1?total%cols:0)):block.colWidths.map(v=>{
      const m=String(v).match(/^(\d+(?:\.\d+)?)cm$/);if(!m)throw new Error('Word 列宽须为 cm 单位。');return Math.round(Number(m[1])*cm);
    });
    if(widths.length!==cols||widths.some(w=>w<720)||Math.abs(widths.reduce((a,b)=>a+b,0)-total)>3)throw new Error('列宽须覆盖 15.92cm 正文宽度，每列至少 1.27cm；请精简内容或调整列数。');
    const table=`/body/tbl[${++tables}]`;
    ops.push({command:'add',parent:'/body',type:'table',props:{rows:String(rows.length),cols:String(cols),width:String(total),colWidths:widths.join(','),layout:'fixed',padding:'100','border.all':'single;4;CBD5E1'}});
    rows.forEach((row,r)=>{
      ops.push({command:'set',path:`${table}/tr[${r+1}]`,props:{cantSplit:'true',...(r===0?{header:'true'}:{})}});
      row.forEach((cell,c)=>{
        if((typeof cell!=='string'&&(typeof cell!=='number'||!Number.isFinite(cell)))||String(cell).length>2000)throw new Error('单元格须为不超过 2000 字符的文字或有限数字。');
        ops.push({command:'set',path:`${table}/tr[${r+1}]/tc[${c+1}]`,props:{text:String(cell),width:String(widths[c]),font:'Microsoft YaHei',size:'10.5pt',bold:String(r===0),...(r===0?{fill:'EAF0F7'}:{})}});
      });
    });
  }
  if(JSON.stringify(ops).length>160000)throw new Error('内容过多，请缩小本次报告。');
  return ops;
}
import {wordImage,imageBlocks} from './word-images.mjs';
