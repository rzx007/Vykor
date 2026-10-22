import {createRequire} from "node:module";
import {readFileSync,writeFileSync} from "node:fs";
import {dirname,resolve} from "node:path";
import {fileURLToPath} from "node:url";
const here=dirname(fileURLToPath(import.meta.url)),repo=resolve(here,"../../..");
const req=createRequire(resolve(repo,"apps/desktop/package.json"));
const esbuild=req("esbuild");
const three=resolve(repo,"node_modules/.pnpm/three@0.184.0/node_modules/three");
const built=await esbuild.build({entryPoints:[resolve(here,"model-viewer.mjs")],bundle:true,write:false,format:"esm",minify:true,target:"es2022",alias:{"three/addons":resolve(three,"examples/jsm"),"three":resolve(three,"build/three.module.js")}});
const model=readFileSync(resolve(here,"../brand/vykor-optical-mark.glb")).toString("base64");
const poster=readFileSync(resolve(here,"../brand/hero-assembled.webp")).toString("base64");
const html='<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Vykor 三维标识素材</title><style>*{box-sizing:border-box}body{margin:0;background:#151815;color:#ecefe9;font:16px/1.5 system-ui,sans-serif}header,footer{max-width:1500px;margin:auto;padding:20px 24px;display:flex;gap:24px;justify-content:space-between;align-items:center}h1{font-size:20px;font-weight:500;margin:0}a{color:inherit;text-underline-offset:4px}main{max-width:1500px;margin:auto}canvas{width:100%;height:68vh;display:block}img{width:100%;height:68vh;object-fit:contain}section{padding:20px 24px;display:flex;gap:18px;align-items:center;flex-wrap:wrap}input[type=range]{flex:1;min-width:150px;accent-color:#bcf523}button{border:0;background:#e8eee2;color:#151815;padding:10px 18px;font:inherit;cursor:pointer}label{display:flex;gap:8px;align-items:center}p{margin:0;color:#c2c9be}footer{font-size:14px;color:#c2c9be}@media(max-width:600px){header,footer{align-items:flex-start;flex-direction:column;gap:8px}canvas,img{height:52vh}}</style></head><body><header><h1>Vykor · 三维标识素材</h1><a id="download">下载 GLB 模型</a></header><main><canvas aria-label="可通过进度滑块查看的 Vykor 三维标识"></canvas><img id="fallback" hidden alt="Vykor 三维标识静态备用图" src="data:image/webp;base64,'+poster+'"><section><button id="start">镜片特写</button><input id="progress" aria-label="动画进度" type="range" min="0" max="1" step=".001" value="1"><button id="end">完整标识</button><label><input id="inlay" type="checkbox">绿色夹层</label></section><section><p id="status">正在加载模型…</p></section></main><footer><span>原创形体依据项目现有图标重建。拖动滑块可前进或返回。</span><span>此页仅检查素材，不是官网页面。</span></footer><script type="application/octet-stream" id="model-data">'+model+'</script><script type="module">'+built.outputFiles[0].text.replaceAll("</script","<\\/script")+'</script></body></html>';
writeFileSync(resolve(here,"../model-preview.html"),html);
console.log(JSON.stringify({preview:resolve(here,"../model-preview.html"),bytes:Buffer.byteLength(html)}));

