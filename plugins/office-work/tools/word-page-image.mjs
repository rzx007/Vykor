import {inflateSync,deflateSync} from 'node:zlib';

const signature=Buffer.from('89504e470d0a1a0a','hex');
const invalid=()=>new Error('Word 分页截图尺寸或 PNG 格式不受支持，未保存检查证据。');
function crc(bytes){let n=0xffffffff;for(const b of bytes){n^=b;for(let i=0;i<8;i++)n=n>>>1^(n&1?0xedb88320:0);}return (n^0xffffffff)>>>0;}
function chunk(type,data){const name=Buffer.from(type),out=Buffer.alloc(data.length+12);out.writeUInt32BE(data.length);name.copy(out,4);data.copy(out,8);out.writeUInt32BE(crc(out.subarray(4,-4)),out.length-4);return out;}
function decode(bytes) {
  if(bytes.length<33||!bytes.subarray(0,8).equals(signature))throw invalid();
  let offset=8,header,ended=false;const compressed=[];
  while(offset+12<=bytes.length) {
    const length=bytes.readUInt32BE(offset),end=offset+12+length;
    if(end>bytes.length)throw invalid();
    const type=bytes.toString('ascii',offset+4,offset+8),data=bytes.subarray(offset+8,end-4);
    if(crc(bytes.subarray(offset+4,end-4))!==bytes.readUInt32BE(end-4))throw invalid();
    if(type==='IHDR'){if(header||offset!==8||length!==13)throw invalid();header=Buffer.from(data);}
    if(type==='IDAT')compressed.push(data);
    if(type==='IEND'){ended=true;break;}
    offset=end;
  }
  if(!ended||!header||!compressed.length)throw invalid();
  const width=header.readUInt32BE(0),height=header.readUInt32BE(4),channels=({2:3,6:4})[header[9]];
  if(!width||!height||width*height>32000000)throw new Error('Word 分页截图过大，请缩小检查范围或拆分文档。');
  if(header[8]!==8||!channels||header[10]!==0||header[11]!==0||header[12]!==0)throw invalid();
  const stride=width*channels,size=(stride+1)*height;
  const raw=inflateSync(Buffer.concat(compressed),{maxOutputLength:size});
  if(raw.length!==size)throw invalid();
  return {width,height,channels,stride,raw,header};
}
function paeth(a,b,c){const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);return pa<=pb&&pa<=pc?a:pb<=pc?b:c;}
// The official contact-sheet renderer paginates before composing the grid,
// preserving inherited headers/footers. Locate its complete white A4 boxes
// rather than depending on viewport size, fixed offsets or screenshot scaling.
export function extractWordPage(bytes,page) {
  const png=decode(bytes),rows=[],white=(x,y)=>{
    const i=x*png.channels,r=rows[y];return r[i]===255&&r[i+1]===255&&r[i+2]===255;
  };
  let previous=Buffer.alloc(png.stride);
  for(let y=0;y<png.height;y++) {
    const offset=y*(png.stride+1),filter=png.raw[offset],row=png.raw.subarray(offset+1,offset+1+png.stride);
    if(filter>4)throw invalid();
    for(let x=0;x<row.length;x++) {
      const a=x>=png.channels?row[x-png.channels]:0,b=previous[x],c=x>=png.channels?previous[x-png.channels]:0;
      const predictor=filter===0?0:filter===1?a:filter===2?b:filter===3?Math.floor((a+b)/2):paeth(a,b,c);
      row[x]=(row[x]+predictor)&255;
    }
    rows.push(row);previous=row;
  }
  const boxes=[];
  for(let y=0;y<png.height;) {
    const columns=[];
    for(let x=0;x<png.width;) {
      if(!white(x,y)){x++;continue;}
      const left=x;while(x<png.width&&white(x,y))x++;
      if(x-left>=100)columns.push({left,width:x-left});
    }
    if(!columns.length){y++;continue;}
    let bottom=y;
    for(const column of columns) {
      // Measure below antialiased corners. The final grid row may be centered
      // differently, so locate each row independently instead of fixed columns.
      const middle=column.left+Math.floor(column.width/2),edgeY=Math.min(png.height-1,y+5);
      let left=middle,right=middle;
      while(left>0&&white(left-1,edgeY))left--;while(right<png.width&&white(right,edgeY))right++;
      let end=y;while(end<png.height&&white(left+5,end))end++;
      const height=end-y,width=right-left;
      if(height<100||Math.abs(width/height-794/1123)>0.005)throw invalid();
      boxes.push({left,top:y,width,height});bottom=Math.max(bottom,end);
    }
    y=bottom+1;
  }
  boxes.sort((a,b)=>a.top-b.top||a.left-b.left);
  if(!boxes.length)throw invalid();
  const box=boxes[page-1];
  if(!box)throw new Error('截图页码超出实际渲染范围，未保存检查证据。');
  const rowBytes=box.width*png.channels,out=Buffer.alloc((rowBytes+1)*box.height);
  for(let y=0;y<box.height;y++)rows[box.top+y].copy(out,y*(rowBytes+1)+1,box.left*png.channels,(box.left+box.width)*png.channels);
  const header=Buffer.from(png.header);header.writeUInt32BE(box.width);header.writeUInt32BE(box.height,4);
  return {bytes:Buffer.concat([signature,chunk('IHDR',header),chunk('IDAT',deflateSync(out)),chunk('IEND',Buffer.alloc(0))]),rendered_pages:boxes.length};
}
