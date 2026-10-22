# Vykor 官网素材 · 第一批

此目录只包含官网素材与可重建的制作源文件，不修改 Desktop 的产品代码。

## 三维标识

- `brand/vykor-optical-mark.glb`：约 132 KiB，glTF 2.0，包含名为 `scrollani` 的四秒动画。
- `brand/vykor-optical-mark.blend`：可编辑 Blender 源文件，含灯光与摄影机。
- `brand/model-verification.json`：实际用 Three.js GLTFLoader 加载并定位动画后的检查结果。
- `model-preview.html`：独立离线查看页，内嵌模型和 Three.js，不依赖 CDN。可拖动进度查看特写到完整标识。
- `brand/brand-manifest.json`：部件名称、动画长度、材质建议与图像清单。

模型依据 `apps/desktop/resources/icon.png` 的括号与机器人形体重新建模。没有复用 ego 的模型或环境贴图。

左右括号、连接杆、机器人和绿色夹层均为可分离部件。关闭 `Lime_Inlay_Left` 与 `Lime_Inlay_Right` 可得到更清透的镜片；打开则保留更强的品牌绿。

WebGL 透射材质需要环境照明。查看页提供 RoomEnvironment 的程序光照，不需要额外下载 HDR。模型本身不内嵌渲染场景的灯光。

```js
const clip = gltf.animations.find((clip) => clip.name === "scrollani")
const mixer = new THREE.AnimationMixer(gltf.scene)
const action = mixer.clipAction(clip)
action.setLoop(THREE.LoopOnce, 1)
action.clampWhenFinished = true
action.play()
// 滚动时调用。末帧略向前取样，避免动作被播放器当成下一轮。
mixer.setTime(Math.min(Math.max(progress, 0), 1) * (clip.duration - 0.00001))
```

内置浏览器的自动化安全策略不允许打开 file: URL，因此没有进行查看页的浏览器运行验证。GLB 的加载、网格数值、四秒动画与首尾状态已用 Three.js 实际检查。

## 静态备用图

| 文件 | 尺寸 | 用途 |
| --- | --- | --- |
| `brand/hero-closeup.png` / `.webp` | 1920 × 1080 | 镜片特写状态 |
| `brand/hero-assembled.png` / `.webp` | 1920 × 1080 | 完整标识状态 |
| `brand/vykor-mark-transparent.png` / `.webp` | 1400 × 1400，透明 | 小尺寸交接、减少动态效果与无 WebGL 备用 |

静帧由 Blender Cycles 渲染。网页默认使用 WebP，PNG 保留为源图。

## 产品界面素材

`product/` 的工作台、编程、参考资料和文档画面，使用仓库实际 Desktop React 组件与样式渲染。

画面中的项目、任务和文件内容均为制作素材用的**示例数据**，通过明确写着“示例任务”的会话展示。它们不是一次真实模型调用的完成记录，也不是测试成绩或用户案例。

制作过程使用独立临时 Electron profile，不读取现有 Vykor 用户配置，不发送模型请求。原始示例文案位于 `source/product/sample-data.ts`，渲染说明位于 `product/product-manifest.json`。

四组界面素材均为 2880 × 1620，提供 PNG 和无损 WebP。

**尚未制作：**接入模型后、从提交任务到实际执行完成的端到端录屏。该素材应在配置好模型的 Vykor 演示环境中录制，不能把示例截图剪辑成自动执行成功的证据。

## 重建

在仓库根目录运行：

```powershell
& 'C:\Program Files\Blender Foundation\Blender 5.2\blender.exe' --background --factory-startup --python artifacts/website-media/source/build-brand.py -- --out artifacts/website-media/brand
python artifacts/website-media/source/prepare-delivery.py
node artifacts/website-media/source/verify-model.mjs
node artifacts/website-media/source/build-viewer.mjs
node artifacts/website-media/source/build-product.mjs
node artifacts/website-media/source/run-capture.mjs
python artifacts/website-media/source/package-assets.py
```

Blender 脚本在独立后台进程中创建场景，不加载或更改正在编辑的场景。查看页内嵌 Three.js，其许可证保留在 `source/THREE-LICENSE.txt`。

