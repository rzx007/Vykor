from pathlib import Path
from PIL import Image
import hashlib, json, zipfile

root=Path(__file__).resolve().parent.parent
product=root/"product"
manifest_path=product/"product-manifest.json"
if not manifest_path.exists():
    raise SystemExit("Capture manifest is missing. Run capture-product first.")
manifest=json.loads(manifest_path.read_text("utf-8"))
assert len(manifest["scenarios"])==4
for case in manifest["scenarios"]:
    case.pop("codeLayout",None)
    assert not any(x.startswith("ERROR:") for x in case["diagnostics"]), case
    assert len(case["text"].strip())>=80, case
    image=Image.open(product/case["file"]).convert("RGB")
    assert len(image.resize((120,80)).getcolors(9600) or [])>24, case
    image.save(product/Path(case["file"]).with_suffix(".webp").name,"WEBP",lossless=True,method=6)
manifest["captureValidated"]=True
manifest_path.write_text(json.dumps(manifest,ensure_ascii=False,indent=2),"utf-8")
errors=product/"capture-errors.json"
if errors.exists(): errors.unlink()

html='''<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Vykor 官网素材</title><style>*{box-sizing:border-box}body{margin:0;background:#151815;color:#edf0e8;font:17px/1.65 system-ui,sans-serif}main{max-width:1300px;margin:auto;padding:32px 24px}h1{font-size:36px;font-weight:500;line-height:1.2}h2{font-size:26px;font-weight:500;margin-top:64px}h3{font-size:20px;font-weight:500}p{max-width:56em}a{color:inherit;text-underline-offset:5px}nav{display:flex;gap:24px;flex-wrap:wrap;margin:28px 0}img{width:100%;height:auto;display:block;margin:20px 0}ul{padding-left:22px}small{font-size:15px;color:#c5cdbf}footer{margin-top:70px;color:#c5cdbf}</style></head><body><main><h1>Vykor 官网素材</h1><p>第一批：可编辑三维标识、四秒动画、静态备用图，以及使用实际桌面组件制作的示例界面。</p><nav><a href="model-preview.html">查看模型与动画</a><a href="brand/vykor-optical-mark.glb">GLB 模型</a><a href="brand/vykor-optical-mark.blend">Blender 源文件</a><a href="README.md">使用说明</a></nav><h2>三维标识</h2><p>依据项目现有的括号与机器人图标重建。绿色夹层可以单独关闭，环境光可在网页中生成。</p><img src="brand/hero-assembled.webp" alt="Vykor 完整三维标识"><h3>特写状态</h3><img src="brand/hero-closeup.webp" alt="Vykor 三维标识的近距离状态"><h2>产品场景</h2><p>以下画面使用 Vykor 仓库中的真实桌面组件与样式。项目、任务和文件内容均为标注过的示例数据，未调用模型，不是实际任务执行成功的记录。</p>'''
for key,title in [("workspace","工作台"),("coding","编程与文件"),("research","参考资料"),("document","文档与持续工作")]:
    html+='<h3>'+title+'</h3><a href="product/vykor-'+key+'.png"><img src="product/vykor-'+key+'.webp" alt="Vykor '+title+'示例界面"></a>'
html+='''<footer><p>端到端真实任务录屏尚未制作，需要在接入模型的 Vykor 演示环境中完成。使用说明与素材清单保留了这一边界。</p><p>GLB 已用 Three.js 加载并校验四秒动画。模型查看页已生成；内置浏览器的 file: 自动打开操作被安全策略拦截，未做该页的浏览器运行验证。</p></footer></main></body></html>'''
(root/"index.html").write_text(html,"utf-8")
checks=[]
for folder in ["brand","product"]:
 for p in sorted((root/folder).glob("*")):
  if p.is_file() and p.suffix!=".blend1":
   checks.append({"file":p.relative_to(root).as_posix(),"bytes":p.stat().st_size,"sha256":hashlib.sha256(p.read_bytes()).hexdigest()})
(root/"asset-manifest.json").write_text(json.dumps({"version":1,"assets":checks,"notIncluded":"End-to-end recording with real model execution"} ,ensure_ascii=False,indent=2),"utf-8")
zip_path=root.parent/"vykor-website-media-v1.zip"
with zipfile.ZipFile(zip_path,"w",zipfile.ZIP_DEFLATED,compresslevel=6) as z:
 for p in sorted(root.rglob("*")):
  if not p.is_file(): continue
  rel=p.relative_to(root)
  if "product-renderer" in rel.parts or p.suffix in [".blend1",".log"] or "__pycache__" in rel.parts: continue
  z.write(p,Path("vykor-website-media")/rel)
with zipfile.ZipFile(zip_path) as z:
 assert z.testzip() is None
print(json.dumps({"zip":str(zip_path),"zip_bytes":zip_path.stat().st_size,"catalog":str(root/"index.html"),"asset_files":len(checks),"product_scenes":len(manifest["scenarios"])},ensure_ascii=False))

