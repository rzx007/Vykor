# Desktop Browser Annotations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 改进浏览器批注的选择、高亮、输入和回看体验，保持普通网页操作和现有 Agent 权限边界。

**Architecture:** 网页内固定脚本负责命中元素和显示位置，Desktop 主进程持有保存记录与选择身份，Renderer hook 和面板负责草稿及用户反馈。Browser 服务继续决定标签页和页面身份；Server 只接收当前页面的有限批注，不依赖 Desktop 实现。

**Tech Stack:** TypeScript、Electron 现有 webview 与隔离执行环境、React、现有 IPC、Vitest；后续经用户确认，仅增加 `@medv/finder` 4.0.2，用于 guest 中的 CSS 选择器生成。

**Spec:** [已审核修订的设计](../specs/2026-10-04-desktop-browser-annotations-design.md)。

> 状态：已实现，验证记录见文末。按当前会话顺序执行，未自动提交或推送；真实 Electron 检查使用独立临时资料目录和隐藏窗口。

## Global Constraints

- 批注保存在当前标签页的主进程内存中，不增加数据库、云同步或跨会话恢复。
- 不安装 React Scan，不复制它的性能面板；普通 DOM 和 CSS 足够，不使用 Canvas、Worker 或动画库。
- 每页最多 20 条批注；意见最多 2,000 个字符，选择器最多 512 个字符、深度 12，目标说明最多 200 个字符，名称最多 180 个字符。
- 保存记录只有一份。DOM 引用留在页内脚本，矩形只属于当前快照，草稿只留在已挂载的 hook。
- 不增加 guest preload，不启用 Node，不关闭沙箱或网页安全检查，不增加任意脚本、原始 CDP 或 Agent 动作。
- 同地址刷新保留记录；地址改变清空记录。引用失效后只有唯一 ID 和语义属性/类名目标可以核对重定位，结构路径目标显示失效。
- 未保存草稿在暂时隐藏、切页、目标失效和页面变化后保留文字，但解除旧目标关联，重新选择前不能提交。
- 主进程在异步执行后、提交记录前再次核对身份。暂停、导航和关闭立即使旧操作失效，不排在 Agent 的长操作队列后。
- 保留工作区已有的无关变更。只修改本计划列出的文件，不顺带调整数据库、Developer mode 或浏览器权限。

## 审核结论和已修订事项

| 编号 | 原方案的缺口 | 修订和任务落点 |
| --- | --- | --- |
| R1 | 切页或隐藏时丢弃草稿，把常规操作变成意见丢失 | hook 保留文字、解除旧选择；任务 4 验证恢复与禁用旧目标保存 |
| R2 | 唯一选择器加同名特征仍可能把重排后的另一元素当作原目标 | 保存 `locatorKind`，失效的结构路径不重定位；任务 1、2 覆盖相同文字和 DOM 重排 |
| R3 | Browser 的 `active` 没有包含工具面板 `open`，隐藏面板不会停止读取 | `UtilityPanel` 单独传 `visible`，保留 Agent 的活动标签页语义；任务 4 接线 |
| R4 | 换主题会改变 webview ref 回调，引发短暂解绑；解绑不等于关闭标签页 | 记录按真实 guest 身份保留，同 guest 重绑不清空；任务 3 覆盖 |
| R5 | 周期读取同一点击状态，会重新打开用户已关闭的面板；迟到清理可能删除新选择层 | 使用交互版本与用户事件序号，清理仅对应旧版本；任务 1、2、4 验证 |
| R6 | 只拦 click 无法阻止目标的按下鼠标处理器；子框架事件不能当成主页面换页 | 拦截完整选择手势；主框架事件过滤；任务 1、3 验证 |
| R7 | 页内脚本和 Renderer 表单分处两个绘制空间，不能只凭类型定义认定浮层和缩放可行 | 首先验证真实 webview 的选择、滚动和 Renderer 浮层，再实现保存及正式界面；任务 1 是前置检查 |

这些修订已同步写入设计文件。无需独立审核系统、迁移层或额外状态管理库。

## 文件职责和统一接口

### 文件落点

| 文件 | 职责 |
| --- | --- |
| 新增 `apps/desktop/src/shared/browser-annotation.ts` | Desktop 数据和页内固定命令类型；只含数据，不导入运行环境 |
| 新增 `apps/desktop/src/main/features/browser/browser-annotation-script.ts` | 自包含固定页内脚本和代码生成入口，不执行 Electron 调用 |
| 新增 `apps/desktop/src/main/features/browser/browser-annotation-controller.ts` | 具体批注存储、选择身份、固定脚本调用和结果限制；不查找任意 guest |
| 修改 `apps/desktop/src/main/features/browser/browser-agent-service.ts` | 核对已附着 guest、活动标签页和导航身份，调用批注控制器 |
| 修改 `apps/desktop/src/main/features/browser/ipc.ts`、`apps/desktop/src/shared/ipc-channels.ts`、`apps/desktop/src/shared/desktop-api-contract.ts`、`apps/desktop/src/preload/desktop-api.ts` | 固定方法和调用方校验，替换旧 `inspectAt` 参数链路 |
| 新增 `apps/desktop/src/renderer/src/components/desktop/tools/use-browser-annotations.ts` | 草稿、快照读取、过期响应、事件消费和可见性管理 |
| 新增 `apps/desktop/src/renderer/src/components/desktop/tools/browser-annotation-panel.tsx` | 输入框、回看列表、保存及错误反馈，不直接调用 Electron |
| 修改 `apps/desktop/src/renderer/src/components/desktop/tools/browser-tool.tsx` | 接入 hook 和面板，保留现有导航与 webview 绑定 |
| 修改 `apps/desktop/src/renderer/src/components/desktop/layout/main-layout/utility-panel/utility-panel.tsx` | 只增加 Browser 批注需要的实际可见状态 |
| 修改 `packages/server/src/application/browser-tools/browser-host.ts`，扩展对应测试 | 在现有批注输出中增加 `selector`；不引入 Desktop 类型 |

### 数据契约

任务 1 建立共享数据类型，任务 2、3、4 沿用同名类型。下列字段是实际需要的契约，不另外增加协议版本或事件总线。

```ts
export type AnnotationMode = "off" | "pick" | "review"
export type LocatorKind = "unique-id" | "semantic" | "path"
export type AnnotationRect = { x: number; y: number; width: number; height: number }
export type AnnotationViewport = { width: number; height: number }
export type AnnotationTarget = {
  target: string; selector: string; locatorKind: LocatorKind
  tagName: string; role: string; name: string
}
export type BrowserAnnotationRecord = AnnotationTarget & {
  id: string; pageUrl: string; comment: string
}
export type LocatedAnnotation = {
  record: BrowserAnnotationRecord
  status: "visible" | "offscreen" | "missing"
  rect: AnnotationRect | null
}
export type BrowserAnnotationSnapshot = {
  pageUrl: string; pageRevision: number; ready: boolean
  mode: AnnotationMode; interactionVersion: number; eventSequence: number
  selection: { selectionId: string; target: AnnotationTarget; rect: AnnotationRect } | null
  focusedAnnotationId: string | null
  viewport: AnnotationViewport | null
  annotations: LocatedAnnotation[]
}
export type AnnotationPageInput = { tabId: string; pageRevision: number }
export type AddAnnotationInput = AnnotationPageInput & { selectionId: string; comment: string }
export type AnnotationIdInput = AnnotationPageInput & { annotationId: string }
export type SetAnnotationModeInput = AnnotationPageInput & { mode: AnnotationMode }
```

网页内部持有元素引用，主进程仅通过 `handleId` 指向本次脚本选择。保存意见不传给网页脚本。

```ts
export type PageMarker = AnnotationTarget & { id: string; handleId: string | null }
export type PageAnnotationSnapshot = {
  mode: AnnotationMode; interactionVersion: number; eventSequence: number
  selected: (AnnotationTarget & { handleId: string; rect: AnnotationRect }) | null
  focusedAnnotationId: string | null
  viewport: AnnotationViewport
  markers: Array<{ id: string; status: LocatedAnnotation["status"]; rect: AnnotationRect | null }>
}
export type PageAnnotationCommand = { interactionVersion: number } & (
  | { action: "install"; mode: "pick" | "review" }
  | { action: "read" }
  | { action: "syncMarkers"; markers: PageMarker[] }
  | { action: "validateSelection"; handleId: string }
  | { action: "focusAnnotation"; annotationId: string }
  | { action: "stop" }
)
```

`validateSelection` 找不到仍连接的原元素时返回 `selected: null`，不能重新执行选择器后假装原选择仍有效。页内读写都只返回 `PageAnnotationSnapshot` 或安装/清理失败，不传回 DOM 对象。

### 方法契约

```ts
// browser-annotation-script.ts；常量在扫描现有代码无冲突后固定为 1004。
export const BROWSER_ANNOTATION_WORLD_ID = 1004
export declare function buildAnnotationScript(command: PageAnnotationCommand): string

// browser-annotation-controller.ts；仅 Main 内部类型，不能放进 shared。
import type { WebContents } from "electron"
export type AnnotationPageContext = {
  tabId: string; contents: WebContents; pageUrl: string; pageRevision: number; ready: boolean
  assertCurrent: () => void
}
export declare class BrowserAnnotationController {
  read(page: AnnotationPageContext): Promise<BrowserAnnotationSnapshot>
  setMode(page: AnnotationPageContext, input: SetAnnotationModeInput): Promise<BrowserAnnotationSnapshot>
  add(page: AnnotationPageContext, input: AddAnnotationInput): Promise<BrowserAnnotationSnapshot>
  focus(page: AnnotationPageContext, input: AnnotationIdInput): Promise<BrowserAnnotationSnapshot>
  remove(page: AnnotationPageContext, input: AnnotationIdInput): Promise<BrowserAnnotationSnapshot>
  suspend(webContentsId: number): void
  navigationStarted(webContentsId: number, pageRevision: number): void
  pageReady(webContentsId: number, pageUrl: string, pageRevision: number): void
  release(webContentsId: number): void
  project(webContentsId: number, pageUrl: string, pageRevision: number):
    Array<{ target: string; comment: string; selector: string }>
}
```

上面的声明描述契约，不要求把无实现的类骨架提交进代码。`assertCurrent` 是 Browser 服务内部提供的具体校验函数，不来自 IPC；控制器在页内调用前后、记录提交前调用它。不增设可替换脚本驱动接口，用假的 WebContents 测试现有 Electron 调用即可。

Desktop API 固定为以下五个方法，全部返回快照：

```ts
readAnnotations(input: { tabId: string }): Promise<BrowserAnnotationSnapshot>
setAnnotationMode(input: SetAnnotationModeInput): Promise<BrowserAnnotationSnapshot>
addAnnotation(input: AddAnnotationInput): Promise<BrowserAnnotationSnapshot>
focusAnnotation(input: AnnotationIdInput): Promise<BrowserAnnotationSnapshot>
removeAnnotation(input: AnnotationIdInput): Promise<BrowserAnnotationSnapshot>
```

## Task 1：先验证实际页面选择，建立固定脚本

**Files：** 新增共享类型、固定脚本和 `apps/desktop/src/main/features/browser/browser-annotation-script.test.ts`。新增专用检查入口：`apps/desktop/tests/browser-annotations-electron/main.ts`、`host.html`、`page.html`、`electron.vite.config.ts`、`apps/desktop/scripts/test-browser-annotations-electron.mjs`；在 Desktop `package.json` 增加 `test:browser-annotations-electron`。不复用会启动整套插件功能的测试入口。

**Consumes：** 现有 Electron API 与 webview 安全设置，不依赖批注控制器或正式 Renderer。

**Produces：** `buildAnnotationScript()` 和上面的页内类型，能够在真实 guest 中安装、选择、读取、同步标记和清理。

- [ ] **1.1 创建固定本地夹具和实际输入断言。** `host.html` 只包含 webview 和一个模拟 Renderer 输入框；`page.html` 包含下列内容，再加入高度 140 px 的内层滚动容器（内容高度 1,200 px）、一个 iframe 和两个同名无 ID 按钮：

  ```html
  <form id="form">
    <button id="target" type="submit">提交</button>
  </form>
  <script>
    window.pageActions = { down: 0, click: 0, submit: 0 };
    target.addEventListener('pointerdown', () => window.pageActions.down++);
    target.addEventListener('click', () => window.pageActions.click++);
    form.addEventListener('submit', event => {
      event.preventDefault(); window.pageActions.submit++;
    });
  </script>
  ```

  Main 使用 `show: false` 的临时窗口、独立临时用户目录及实际 `<webview>`；guest 设置保持 `sandbox: true`、`contextIsolation: true`、`nodeIntegration: false`，移除 guest preload。使用 `webContents.sendInputEvent()` 发出真实按下和松开，不能只用 DOM 合成 click 冒充原生输入。

  ```ts
  // guest 来自 did-attach-webview；fixture 已完成 loadFile。
  const point = await guest.executeJavaScript(`(() => {
    const rect = document.getElementById('target').getBoundingClientRect();
    return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
  })()`)
  await guest.executeJavaScriptInIsolatedWorld(BROWSER_ANNOTATION_WORLD_ID, [{
    code: buildAnnotationScript({ action: "install", mode: "pick", interactionVersion: 1 }),
  }])
  guest.sendInputEvent({ type: "mouseMove", x: point.x, y: point.y })
  guest.sendInputEvent({ type: "mouseDown", x: point.x, y: point.y, button: "left", clickCount: 1 })
  guest.sendInputEvent({ type: "mouseUp", x: point.x, y: point.y, button: "left", clickCount: 1 })
  // 等待读取 selected.handleId 出现；断言全部网页操作计数仍为零。
  assert.deepEqual(await guest.executeJavaScript("window.pageActions"), {
    down: 0, click: 0, submit: 0,
  })
  ```

  按角色补齐断言：内层容器滚轮后 `scrollTop > 0`；iframe 点击只锁定外层且内部计数为零；在隔离世界中 `typeof process` 和 `typeof require` 均为 `undefined`。如果环境无法向隐藏窗口派送真实输入，只报告这个检查不可用，不改成合成事件后声称通过。

- [ ] **1.2 添加针对定位的失败测试。** 使用现有 jsdom 环境运行同一固定脚本；建立两个同名无 ID 按钮，选择第二个后删除或替换它，再读取其标记，必须是 `missing`；唯一 ID 元素失效后只有重新出现且特征匹配才可重定位。不要断言脚本字符串是否包含某段代码。

  ```ts
  // @vitest-environment jsdom
  import { expect, it, vi } from "vitest"
  import { buildAnnotationScript } from "./browser-annotation-script"
  it("runs as a self-contained script without Main module globals", () => {
    vi.stubGlobal("requestAnimationFrame", () => 1)
    document.body.innerHTML = '<button id="target">提交</button>'
    try {
      const state = window.eval(buildAnnotationScript({
        action: "install", mode: "pick", interactionVersion: 1,
      }))
      expect(state.mode).toBe("pick")
      expect(state.interactionVersion).toBe(1)
    } finally {
      window.eval(buildAnnotationScript({ action: "stop", interactionVersion: 1 }))
      vi.unstubAllGlobals()
    }
  })
  ```

- [ ] **1.3 跑新测试确认缺少行为，再实现最小脚本。** 使用自包含函数生成固定脚本，内部定义其所需常量与函数，不捕获 Main 模块变量或导入。通过固定命令安装独立 Shadow Root、捕获完整手势、保留原生滚动，处理编号和 Escape；安装有版本检查，重复安装不会叠加监听。主文档挂一个轻量位置更新，不监控整个页面的全部属性变化。
- [ ] **1.4 验证脚本生命周期。** 先装版本 2，再执行版本 1 的迟到安装/清理，版本 2 仍可选择；停止后网页按钮恢复操作。页内编号位于 Shadow Root 内，普通页面元素查询不返回编号按钮。只输出有限字符串、合法模式及有限矩形。
- [ ] **1.5 验证两个绘制空间。** 页内框贴住实际元素；模拟 Renderer 输入框显示在 webview 上方并能获得焦点。页面缩放 80% / 125% 后依视口和 host 内容区比例换算位置，误差不超过 2 个 host CSS 像素；滚动内层容器后同样检查。截图或报告写入专用临时目录，测试退出关闭窗口、停止本地资源并清理临时资料目录。
- [ ] **1.6 运行并记录实际结果。**

  ```powershell
  pnpm --filter @vykor/desktop exec vitest run src/main/features/browser/browser-annotation-script.test.ts
  pnpm --filter @vykor/desktop test:browser-annotations-electron
  ```

  Electron 命令由 `electron-vite build --config tests/browser-annotations-electron/electron.vite.config.ts` 和专用 Node runner 组成；runner 使用已安装的 Electron，不安装另一套运行时，`windowsHide: true`，有 60 秒退出上限和结构化通过结果。

**审查点：** 先证明目标处理器、默认导航、内层滚动和 Renderer 浮层都符合要求。任一关键项目失败，先修正局部实现或记录具体限制；不直接开始任务 2，不把“存在这个 Electron API”当成方案已成立。

## Task 2：实现保存记录、选择身份和页面生命周期

**Files：** 新增 `browser-annotation-controller.ts`、`browser-annotation-controller.test.ts`；使用任务 1 的共享类型和脚本。

**Consumes：** `AnnotationPageContext` 中已核对的 guest 与 `assertCurrent()`、固定脚本。

**Produces：** 方法契约中的具体控制器；数据按 guest ID 保存，一页最多 20 条；`project()` 返回当前 ready 页面有限批注。

- [ ] **2.1 创建独立假 guest，不模拟脚本内部实现。** 让假的 `executeJavaScriptInIsolatedWorld` 返回任务 1 约定的有限快照；`assertCurrent` 检查可变的活动标记。所有临时变量在测试里定义：

  ```ts
  const run = vi.fn()
  let current = true
  const contents = {
    id: 42, isDestroyed: () => false,
    executeJavaScriptInIsolatedWorld: run,
  } as unknown as WebContents
  const page: AnnotationPageContext = {
    tabId: "tab-1", contents, pageUrl: "http://localhost/fixture", pageRevision: 1, ready: true,
    assertCurrent: () => { if (!current) throw new Error("页面已变化") },
  }
  const raw: PageAnnotationSnapshot = {
    mode: "pick", interactionVersion: 1, eventSequence: 1,
    selected: {
      handleId: "handle-1", target: "button: 提交", selector: "#target", locatorKind: "unique-id",
      tagName: "button", role: "button", name: "提交", rect: { x: 20, y: 30, width: 80, height: 24 },
    },
    focusedAnnotationId: null, viewport: { width: 800, height: 600 }, markers: [],
  }
  run.mockResolvedValue(raw)
  const controller = new BrowserAnnotationController()
  controller.pageReady(contents.id, page.pageUrl, page.pageRevision)
  await controller.setMode(page, { tabId: page.tabId, pageRevision: 1, mode: "pick" })
  const selected = (await controller.read(page)).selection!
  let finish!: (value: PageAnnotationSnapshot) => void
  run.mockReturnValueOnce(new Promise<PageAnnotationSnapshot>(resolve => { finish = resolve }))
  const saving = controller.add(page, {
    tabId: page.tabId, pageRevision: 1, selectionId: selected.selectionId, comment: "调整间距",
  })
  current = false
  controller.navigationStarted(contents.id, 2)
  finish(raw)
  await expect(saving).rejects.toThrow(/页面已变化|选择已失效/)
  expect(controller.project(contents.id, page.pageUrl, 2)).toEqual([])
  ```

- [ ] **2.2 写保存行为测试并确认失败。** 覆盖空意见、2,001 字符、20 条上限、非有限矩形、超长选择器、页内伪造模式、并行重复保存、旧 `selectionId`、未 ready 页面、异步期间切页、2 秒超时和迟到完成。重复提交只能产生一条记录；保存失败不消费仍有效的选择身份。
- [ ] **2.3 实现一个具体控制器。** 页内调用采用固定 world ID，结果校验后再生成主进程选择 ID；同一页内 handle 被重复读取时沿用同一个选择 ID。每次写入最多一个在途操作；保存前通过 `validateSelection` 核对原元素，执行 `page.assertCurrent()` 和版本检查，然后同步提交内存记录。意见不进入页内命令，保存完成后只同步不含意见的标记。

  ```ts
  // 在 add 的异步验证完成后，提交记录前执行；state 是本 guest 当前存储。
  page.assertCurrent()
  if (!state.ready || state.pageRevision !== input.pageRevision ||
      state.interactionVersion !== startedInteractionVersion ||
      state.selection?.selectionId !== input.selectionId ||
      checked.selected?.handleId !== state.selection.handleId) {
    throw new Error("选择已失效，请重新选择目标")
  }
  // 校验数量和文字长度后同步提交，再消费 selectionId。
  ```

  保存记录提交成功、后续标记同步失败时，记录仍已保存；返回当前存储快照，该条目标状态先为 `missing`。列表显示“已保存，目标位置暂不可用”，不误报“未保存”导致用户重复添加。
- [ ] **2.4 写并实现生命周期测试。** 导航开始立即暂停投影并使选择失效；同地址 ready 保留记录，新地址 ready 清空；`suspend` 保留记录但停止交互，`release` 清空；只返回当前 URL 和页面版本的已保存记录。删除更新保存来源，不能仅移除 UI 标记。
- [ ] **2.5 跑聚焦测试和 node 类型检查。**

  ```powershell
  pnpm --filter @vykor/desktop exec vitest run src/main/features/browser/browser-annotation-controller.test.ts
  pnpm --filter @vykor/desktop typecheck:node
  ```

**审查点：** 主进程没有第二份草稿或 DOM；停止交互不会等待长队列，迟到结果既不能提交记录，也不能关闭新版选择层。

## Task 3：接入真实标签页、IPC 和 Agent 输出

**Files：** 修改 Browser 服务及其 `browser-agent-service.test.ts`，文件落点中的共享 IPC 声明、Desktop API 契约、preload 和 `main/features/browser/ipc.ts`；新增 `main/features/browser/ipc.test.ts`。修改 Server `browser-host.ts` 和 `__test__/browser-tool.test.ts`。Developer mode 的文件和动作不重构。

**Consumes：** 任务 2 控制器，当前 Browser 服务的窗口所属关系和活动标签页。

**Produces：** 五个 Desktop 固定方法、页面版本生命周期、当前页面的 `{ target, comment, selector }` Agent 结果。

任务 3 和任务 4 是同一个接口迁移单元的两个工作部分。任务 3 先验证 Main 和 Server 的结果，最终 Desktop IPC/API 与 Renderer 在任务 4 一起切换；中间状态不作为可发布成果，不为中间编译增加旧参数兼容层。

- [ ] **3.1 为实际服务和 IPC 写失败测试。** 错误 sender、非所属 guest、非活动标签页、缺字段、数组冒充对象、非整数页面版本以及旧版本请求全部拒绝。不要只把输入 `as` 为 TypeScript 类型后转交。
- [ ] **3.2 接入主框架事件及异步身份校验。** 继续在 `trackGuest` 中维护导航监听；只在主框架导航开始递增版本，在主文档就绪后调用 `pageReady`。同文档地址变化单独处理，过滤第三个参数 `isMainFrame`，取消导航后也要核对当前文档状态。现有 Developer mode 回调保留。

  ```ts
  // 放在 trackGuest 内；服务中的 annotations 已替换为控制器实例。
  let previousMainUrl = guest.getURL()
  const annotations = this.annotations
  guest.on("did-navigate-in-page", (_event, url, isMainFrame) => {
    if (!isMainFrame || url === previousMainUrl) return
    const revision = advanceAnnotationPageRevision(guest.id)
    annotations.navigationStarted(guest.id, revision)
    annotations.pageReady(guest.id, url, revision)
    previousMainUrl = url
  })
  ```

  `advanceAnnotationPageRevision(webContentsId): number` 是 Browser 服务内更新批注页面版本 Map 的小方法，不改写现有诊断导航序号。`AnnotationPageContext.assertCurrent()` 再次核对实际活动 tab、owner、guest、页面版本和 ready 状态，供控制器提交前使用。
- [ ] **3.3 区分暂停与释放。** `setActiveTab` 主动暂停旧 guest；`unbindTab` 暂停，真实 `destroyed` 或绑定到另一个 guest 才释放旧记录。测试同 guest 短暂解绑/重绑及主题切换不会清空。关闭或切页不依赖旧 Renderer 再发一个能通过活动标签页检查的请求。
- [ ] **3.4 定义窄接口和对应 IPC 校验测试。** 各 IPC 先验证输入和 `BrowserWindow.fromWebContents(event.sender)`，再由服务决定 guest。preload 和 API 使用同一共享类型；实际切换与任务 4 的 Renderer 修改一起完成。删除旧 `inspectAt` 和旧参数，不提交或发布两套并行行为。
- [ ] **3.5 接入 Agent 投影并测试真实工具输出。** Browser 服务原有观察出口改为调用 `project()`；更新已有 click 测试中直接调用旧 `addAnnotation` 的设置过程，不为测试保留旧生产方法。

  ```ts
  it("returns annotation selectors as data without expanding Browser actions", async () => {
    const tool = createBrowserTool({ execute: async () => ({
      url: "http://localhost/fixture", title: "Fixture", pageText: "提交",
      annotations: [{ target: "button: 提交", comment: "调整间距", selector: "#target" }],
    }) }, async () => "unused.png", async () => ({}))
    const result = await tool.execute({ action: "inspect" }, {
      cwd: ".", sessionId: "s1", requestPermission: async () => ({ status: "approved" }),
    })
    const text = result.content.find(block => block.type === "text")!
    expect(JSON.parse(text.text).annotations).toEqual([
      { target: "button: 提交", comment: "调整间距", selector: "#target" },
    ])
    expect(tool.inputSchema).toMatchObject({
      properties: { action: { enum: ["inspect", "navigate", "click", "type", "scroll"] } },
    })
  })
  ```

- [ ] **3.6 运行相关检查。**

  ```powershell
  pnpm --filter @vykor/desktop exec vitest run src/main/features/browser/browser-agent-service.test.ts src/main/features/browser/ipc.test.ts src/main/features/browser/browser-developer-service.test.ts
  pnpm --filter @vykor/server exec vitest run src/application/browser-tools/__test__/browser-tool.test.ts
  pnpm --filter @vykor/desktop typecheck:node
  pnpm --filter @vykor/server check-types
  ```

**审查点：** 子框架和同 guest 重绑不误清理；主界面的可见性没有成为普通 Browser 新的权限条件。IPC 入口没有接受原始脚本、选择器或 WebContents ID。

## Task 4：接入界面、草稿和批注回看

**Files：** 新增 hook、面板和对应 `use-browser-annotations.test.tsx`、`browser-annotation-panel.test.tsx`。修改 BrowserTool、UtilityPanel、IPC/API 类型的最终迁移部分；新增 `browser-tool.test.tsx` 覆盖绑定和组合行为。

**Consumes：** 任务 3 的固定 API 和快照。

**Produces：** 完整 UI；只有实际可见时读取页面；不再存在旧透明全屏点击遮罩和文字选择入口。

hook 的边界固定为：

```ts
export type BrowserAnnotationHookOptions = { tabId: string; visible: boolean; ready: boolean }
export type BrowserAnnotationUi = {
  snapshot: BrowserAnnotationSnapshot | null
  draft: string; pending: boolean; error: string | null
  selection: BrowserAnnotationSnapshot["selection"]
  viewedAnnotationId: string | null
  setDraft(value: string): void
  startPicking(): Promise<void>
  showSaved(): Promise<void>
  hide(): Promise<void>
  save(): Promise<void>
  focus(annotationId: string): Promise<void>
  remove(annotationId: string): Promise<void>
  cancelEditor(): void
}
export declare function useBrowserAnnotations(options: BrowserAnnotationHookOptions): BrowserAnnotationUi
```

面板消费该结果与 webview 容器矩形，不接受 Desktop API 或 Electron 对象。

- [ ] **4.1 按现有 jsdom + React `act` 模式写行为测试，不安装测试库。** 以一个测试 Probe 暴露 hook 返回值，mock `window.desktop.browser` 的五个固定方法，使用 fake timers 驱动读取。测试草稿文字、失败保留、连续读取同一事件、切页和可见性变化，而不是逐个断言内部 useState。

  ```ts
  // 测试文件使用 jsdom，并导入 act、createRoot、vi、expect 和 hook/types。
  vi.useFakeTimers()
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  const metadata: BrowserAnnotationSnapshot = {
    pageUrl: "http://localhost/fixture", pageRevision: 1, ready: true,
    mode: "off", interactionVersion: 0, eventSequence: 0,
    selection: null, focusedAnnotationId: null, viewport: null, annotations: [],
  }
  const picking = { ...metadata, mode: "pick" as const, interactionVersion: 1 }
  const locked: BrowserAnnotationSnapshot = {
    ...picking, eventSequence: 1,
    selection: {
      selectionId: "selection-1", rect: { x: 20, y: 30, width: 80, height: 24 },
      target: {
        target: "button: 提交", selector: "#target", locatorKind: "unique-id",
        tagName: "button", role: "button", name: "提交",
      },
    },
  }
  const readAnnotations = vi.fn().mockResolvedValue(metadata)
  const addAnnotation = vi.fn().mockRejectedValue(new Error("页面已变化，请重新选择目标"))
  const previousDesktop = Object.getOwnPropertyDescriptor(window, "desktop")
  Object.defineProperty(window, "desktop", { configurable: true, value: { browser: {
    readAnnotations, addAnnotation,
    setAnnotationMode: vi.fn(async (input: SetAnnotationModeInput) =>
      input.mode === "off" ? metadata : picking),
    focusAnnotation: vi.fn().mockResolvedValue(metadata),
    removeAnnotation: vi.fn().mockResolvedValue(metadata),
  } } })
  let lastUi!: BrowserAnnotationUi
  function Probe(options: BrowserAnnotationHookOptions) {
    lastUi = useBrowserAnnotations(options)
    return null
  }
  const root = createRoot(document.createElement("div"))
  try {
    await act(async () => { root.render(<Probe tabId="tab-1" visible ready />) })
    await act(async () => { await lastUi.startPicking() })
    readAnnotations.mockResolvedValue(locked)
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    expect(lastUi.selection?.selectionId).toBe("selection-1")
    act(() => lastUi.setDraft("请增大留白"))
    await act(async () => { await lastUi.save() })
    expect(addAnnotation).toHaveBeenCalledOnce()
    expect(lastUi.draft).toBe("请增大留白")
    await act(async () => { root.render(<Probe tabId="tab-1" visible={false} ready />) })
    expect(lastUi.draft).toBe("请增大留白")
    expect(lastUi.selection).toBeNull()
    expect(lastUi.pending).toBe(false)
  } finally {
    await act(async () => root.unmount())
    if (previousDesktop) Object.defineProperty(window, "desktop", previousDesktop)
    else Reflect.deleteProperty(window, "desktop")
    vi.useRealTimers()
    vi.unstubAllGlobals()
  }
  ```

  将这段测试放入 `it`，并让 `save()` 把受控错误转成 hook 的 `error` 后正常返回。不能在没有选择时调用 `save()` 后误以为测试覆盖了保存失败。
- [ ] **4.2 实现有限读取和用户事件消费。** 每 100 ms 发起一次串行读取，最多一个在途；结束、隐藏或失去活动状态时使请求序号失效。只在页面/交互/事件序号变化时处理锁定或编号点击；同一序号重复返回不会重新打开查看面板。保存操作与读取的迟到响应不能互相覆盖。
- [ ] **4.3 接入正确的可见性，不改变 Agent 活动 tab。**

  ```tsx
  <BrowserTool
    tab={tab}
    active={activeTab?.id === tab.id}
    visible={open && activeTab?.id === tab.id}
    onUpdate={(patch) => updateBrowserTab(tab.id, patch)}
  />
  ```

  BrowserTool 新增必需的 `visible` prop，只用于批注 hook；`active` 继续用于现有 tab 绑定。传入 hook 的 `ready` 为 `webviewReadyRef.current && !tab.loading`，沿用现有加载事件触发界面更新。webview 未 ready 时不安装脚本；卸载请求暂停，销毁由 Main 兜底。主题变化更新颜色，不在 hook 中清空记录或草稿。
- [ ] **4.4 实现输入与列表。** 目标旁表单获得焦点，窄面板内翻转并限位，目标离开视口时表单收至底部。保存禁用重复提交，成功后显示编号并继续选择；20 条上限可删除后再存。失败、暂停、导航后保留文字并禁用旧目标保存；取消才清空。列表包含有标签的定位、删除按钮和目标失效说明。
- [ ] **4.5 实现键盘与清理。** `Ctrl/Cmd + Enter` 保存，Enter 换行；Escape 取消当前编辑或查看，再退出选择。页内 Escape 经递增事件序号传到 hook；Renderer 意见框聚焦后自己处理快捷键，两边不重复消费。关闭列表后继续读取相同 focus 事件，列表不会被重新打开。
- [ ] **4.6 移除旧批注代码与接口，执行聚焦检查。** 删除 BrowserTool 的旧 `annotationTarget`、计数、透明遮罩和 `.inspectAt()` 调用，删除对应旧 IPC/API 声明及服务方法。保留正常导航和 CSS 注入。

  ```powershell
  pnpm --filter @vykor/desktop exec vitest run src/renderer/src/components/desktop/tools/use-browser-annotations.test.tsx src/renderer/src/components/desktop/tools/browser-annotation-panel.test.tsx src/renderer/src/components/desktop/tools/browser-tool.test.tsx
  pnpm --filter @vykor/desktop typecheck:web
  pnpm --filter @vykor/desktop typecheck:node
  rg -n "browserInspectAt|\.inspectAt\(" apps/desktop/src
  ```

  最后一条无匹配是预期结果。保存草稿和已保存记录不是同一份数据，不能用批注总数推断保存成功。

**审查点：** 用户操作的结果能看见，隐藏时停止读，草稿不会被常规切页丢弃；hook、面板、BrowserTool 各自职责清楚，没有引入全局 store。

## Task 5：检查整体行为和更新当前能力说明

**Files：** 更新 `docs/browser-capabilities.md`，本计划记录实际执行结果；只有检查发现具体问题时才调整对应生产文件和测试。

- [ ] **5.1 用任务 1 的实际 Electron 检查入口验证最终脚本。** 加入保存后编号、删除、两个同名节点重排、同地址刷新和主文档换地址场景。重跑是因为脚本和生命周期接线已经改变，不另建第二套浏览器测试框架。
- [ ] **5.2 完成一次正式 Desktop UI 检查。** 普通 HTML、React 页面各完成选择、输入、保存、回看；覆盖内层滚动、iframe 外层、目标删除、深浅主题、窄面板、缩放 80% / 125% 和高 DPI。检查主题切换、面板隐藏、切标签页后记录与草稿符合设计。任务 1 的模拟输入框不能代替正式 hook 和组件验收；环境不支持某项时记录具体未验证项。
- [ ] **5.3 核对输出和改动范围。** Browser 工具动作仍只有五个原动作；当前页面批注进入工具结果，草稿和矩形不进入；页面没有 Node/preload 或新增权限；记录只有 Main 一份。已有聚焦测试和类型检查通过后，只重跑本任务实际修改涉及的检查，不再跑整仓测试。
- [ ] **5.4 将当前能力说明改成实际状态。** 尚未开始写代码时保留“设计方案、尚未实现”；代码已经实现但真实 Electron 检查未通过时写明“实现中，验收未完成”及具体未验证项。验证完成后再记录当前已支持的能力，不把计划当成果。运行：

  ```powershell
  node scripts/check-docs.mjs
  git diff --check -- docs/browser-capabilities.md apps/desktop packages/server
  ```

- [ ] **5.5 记录交付证据。** 在下面填写实际检查命令、通过输出和具体限制；任务未执行前保持以下状态，不填预计结果，不自动提交工作区已有变更。

## 当前执行记录

### 后续 finder 接入

- 用户确认只采用 `@medv/finder` 4.0.2，未引入 `pick-dom-element`。通过 pnpm 10.30.2 安装固定版本并跳过安装脚本，lockfile 只增加该包的 importer、完整性摘要及空依赖记录，共 8 行；没有更新其他依赖。
- `browser-annotation-selector.ts` 只负责选择器生成与候选过滤；`scripts/browser-annotation-selector-plugin.ts` 在构建时打包该入口和 finder，生产、Vitest、Electron 检查共用同一插件。生成脚本随 Main 打包，仅在选择安装命令中注入隔离世界，包含原始 MIT 许可声明，不使用 CDN 或运行时下载。
- 选择器计算只发生在锁定目标时；限制祖先深度、候选类名、搜索时间与检查次数，拒绝超长或不唯一结果。恢复语义目标时仍核对角色、标签和名称；仅按位置生成的选择器不跨文档猜测恢复。
- 增加稳定属性恢复、敏感属性排除、歧义/身份变化拒绝的行为测试，并在真实 Electron 中验证同页刷新后按 `data-testid` 恢复标记。其余选择、高亮、记录存储、IPC 与界面流程保持原有职责。
- 本次接入验证：4 个相关测试文件 36 项测试通过，Desktop node/web 类型检查通过，所改代码 lint 无错误或警告；真实 Electron 检查包含 `finder-semantic-reload` 并通过，正式 Desktop Main/preload/renderer 构建退出 0。没有再次运行整仓测试，未提交或推送。

### 初期实现记录

- 任务 1–4 已完成：固定页内选择脚本、主进程保存与生命周期、窄 IPC、Agent 批注输出、正式 hook/面板和可见性接线。删除旧 `inspectAt` 和透明全屏点击遮罩；初期未新增运行时依赖或数据库，后续 finder 接入见上文。
- 真实 Electron 39.8.10 检查覆盖原生点击拦截、内层滚动、iframe 外层、隔离环境无 Node、80% / 125% 页面缩放，以及真实 BrowserTool 在普通 HTML/React 页面中的原生输入、保存、定位、删除和深浅主题/窄面板显示。截图位于 `.superpowers/browser-annotations/captures/`；临时资料目录在检查退出时清理。
- 集成检查补充验证选择模式不会阻止 Agent Browser 点击。修正旧点击脚本拼接空表达式的语法错误；只有全部现有授权通过后才结束选择模式并等待页内清理，拒绝操作不改变用户选择状态。
- 回归检查覆盖：旧读取/安装/停止请求不影响新选择层、同一选择的读取与保存验证重叠、同 guest 重绑和主/子框架导航、暂停与保存失败保留草稿、同一次编号事件不重复打开、回看退出不丢隐藏草稿、输入框使用实际父容器并限制在内容区内、可编辑元素名称不收集默认输入内容。
- pnpm 全局入口会联网获取其执行版本，本环境改用已经安装的 Vitest/TypeScript/Electron Vite 入口；没有为此安装或更新依赖。
- 最终验证（2026-10-05）：Desktop 8 个相关文件 73 项测试、Server 8 项测试全部通过；Desktop node/web 与 Server 三项类型检查退出 0；正式 Desktop 主进程、preload、renderer 构建退出 0。文档检查通过，旧 `inspectAt` 调用和频道搜索无匹配。
- 任务 5 已完成当前环境的自动及视觉检查，工作保留在 `codex/browser-annotations`，未提交或推送，工作区其他会话的变更保留。

执行命令（分别在 Desktop / Server 目录运行）：

```powershell
# Desktop：8 个相关测试文件
node ../../node_modules/vitest/vitest.mjs run src/main/features/browser/browser-agent-service.test.ts src/main/features/browser/browser-developer-service.test.ts src/main/features/browser/browser-annotation-controller.test.ts src/main/features/browser/browser-annotation-script.test.ts src/main/features/browser/ipc.test.ts src/renderer/src/components/desktop/tools/use-browser-annotations.test.tsx src/renderer/src/components/desktop/tools/browser-annotation-panel.test.tsx src/renderer/src/components/desktop/tools/browser-tool.test.tsx
node ../../node_modules/typescript/bin/tsc --noEmit -p tsconfig.node.json --composite false
node ../../node_modules/typescript/bin/tsc --noEmit -p tsconfig.web.json --composite false
node node_modules/electron-vite/bin/electron-vite.js build --config tests/browser-annotations-electron/electron.vite.config.ts
node scripts/test-browser-annotations-electron.mjs
node node_modules/electron-vite/bin/electron-vite.js build

# Server
node ../../node_modules/vitest/vitest.mjs run src/application/browser-tools/__test__/browser-tool.test.ts
node ../../node_modules/typescript/bin/tsc --noEmit
```

本机 Windows 的检查不代表其他操作系统和所有显示器缩放组合的完整矩阵；保持 iframe 内部及 Shadow DOM 内部不支持、记录不跨进程恢复的范围。最终检查结果以本次命令实际退出状态为准，不把规划示例当作已运行测试。
