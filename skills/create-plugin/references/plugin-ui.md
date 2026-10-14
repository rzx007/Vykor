# 插件 UI

## 文件与实际运行流程

Native Plugin 根 manifest 仍是 `schemaVersion: 1`，通过 `components.ui: ["./ui/manifest.json"]` 声明定义。UI 定义和工具返回的建议均是 `schemaVersion: 2`：

```json
{
  "schemaVersion": 2,
  "components": [{
    "id": "text-inspector",
    "title": "文本格式检查",
    "entry": "./ui/panel.html",
    "surface": "session-sidebar",
    "actions": [{
      "id": "preview",
      "label": "生成所选修复预览",
      "tool": "TextInspectorPreview",
      "completion": "keep-open"
    }]
  }]
}
```

每个组件只选一个 `surface`：`tool-result` 是工具结果内联卡片，`session-sidebar` 是会话侧栏。“固定”指声明的位置不变；不会始终显示或自动打开。只有用户打开后才加载 HTML。没有 `surfaces`、`openSidebar()`、跨位置移动或旧版本兼容别名。

同插件 Native Tool 返回普通文字与 UI 建议：

```js
return {
  content: [{ type: "text", text: JSON.stringify({ findings, truncated }) }],
  metadata: { ui: {
    schemaVersion: 2, componentId: "text-inspector",
    data: { text, findings, truncated }
  } }
};
```

`entry` 相对于插件根目录。展示组件写 `actions: []`；`action.tool` 精确匹配同插件注册工具，参数 schema 来自工具，`completion` 为 `keep-open` 或 `resolve`。插件不生成可信 instanceId、revision 或 metadata.pluginUi/uiAction，这些由宿主验证并保存在原工具结果中。始终保留文字结果。

## 两种提交路径

- `requestAction(actionId, args)`：用户确认后调用组件声明的同插件 Native Tool，适合生成预览、执行业务操作；不把按钮请求变成普通模型消息。
- `requestConversation({ mode, expectedRevision, text, data })`：插件主动构造说明和所选数据，交给普通会话。`draft` 在必要确认后加入输入框，尚未发送；`submit` 经确认新建普通 Input/Run，由助手处理。它不会发送输入框已有草稿。宿主在 Server 一处构造最终带插件来源的文本。

没有宿主草稿 getter，也不能读父 DOM。说明 `text` 必须非空且最多 4096 个 Unicode 字符；`data` 必须是有限 JSON 对象，JSON UTF-8 最多 32 KiB。业务 snapshot.data 可到 256 KiB，不能直接全部交接。仅构造用户选择的必要内容；超限显示错误，让用户调整选择，不能默默裁掉内容。取消、失败和未知回执保留本地输入，不自动重试。

## 浏览器 SDK、快照与完整例子

复制 `assets/text-inspector/` 后只用 Node 运行 `node scripts/build-ui.mjs`。它把附带的 `ui/sdk.js`（全局 `VykorPluginUi`）、`ui/styles.css` 和 panel 源码内联成单文件 HTML。独立作者无需本仓库、pnpm、Vite 或网络。修改后重新构建；安装不会替作者构建。仓库维护者使用 `node examples/plugins/text-inspector/scripts/build-ui.mjs --export-author-assets` 从当前源机械导出 SDK/CSS，不能手改 bundle。

快照必需字段：instanceId、revision、status、data、actions、readOnly、appearance、capabilities、locale、surface。可选 activeAction、lastAction。appearance 包含 theme、colors、fontFamily、fontSizePx、reducedMotion；使用 `applyPluginUiAppearance(snapshot.appearance)` 设置公共 CSS 变量。capabilities.draft/submit 控制两种交接按钮。getSnapshot/onSnapshot 直接获得这些字段，没有独立 presentation 通道或顶层 theme。

readOnly 和 status 限制工具动作，不代替聊天交接能力判断。交接按钮按 capabilities 分别控制；resolved 或没有模型时仍可能允许 draft，但不允许 submit。

下面是完整浏览器入口：先把附带 SDK 和 CSS 内联进 HTML，再内联这段脚本。工具建议的 data 为 `{ choices: ["条目一", "条目二"] }`，组件声明固定 surface 和 actions: []。每次业务 revision 变化重建业务选项，同 revision 外观/能力更新保留输入。完整带 Native preview 的可运行例子见附带 panel.mjs/panel.template.html。

```js
const { createPluginUiClient, applyPluginUiAppearance } = VykorPluginUi;
const select = document.createElement("select");
const note = document.createElement("textarea");
note.value = "请分析所选内容。";
const status = document.createElement("p");
status.setAttribute("role", "status");
const draft = document.createElement("button");
draft.textContent = "加入输入框";
const submit = document.createElement("button");
submit.textContent = "交给助手";
document.body.append(select, note, draft, submit, status);
let snapshot, revision, pending = false;
function controls() {
  draft.hidden = !snapshot.capabilities.draft;
  submit.hidden = !snapshot.capabilities.submit;
  draft.disabled = pending || !snapshot.capabilities.draft;
  submit.disabled = pending || !snapshot.capabilities.submit;
}
function render(value) {
  applyPluginUiAppearance(value.appearance);
  snapshot = value;
  if (revision !== value.revision) {
    revision = value.revision;
    select.replaceChildren();
    for (const text of value.data.choices) {
      const option = document.createElement("option");
      option.textContent = text;
      option.value = text;
      select.append(option);
    }
  }
  controls();
}
(async () => {
  try {
    const client = await createPluginUiClient();
    render(await client.getSnapshot());
    const off = client.onSnapshot(render);
    for (const [button, mode] of [[draft, "draft"], [submit, "submit"]]) {
      button.addEventListener("click", async () => {
        if (button.disabled) return;
        try {
          const text = note.value.trim();
          const data = { selection: select.value };
          if (!text || [...text].length > 4096) throw new Error("说明需要 1–4096 个字符。");
          if (new TextEncoder().encode(JSON.stringify(data)).byteLength > 32 * 1024)
            throw new Error("所选内容超过 32 KiB，请减少选择。");
          pending = true; controls();
          const receipt = await client.requestConversation({ mode, expectedRevision: snapshot.revision, text, data });
          status.textContent = receipt.mode === "draft" ? "已加入输入框，尚未发送。" : "已受理，请查看会话回执。";
        } catch (error) {
          status.textContent = error.code || error.message;
        } finally {
          pending = false; controls();
        }
      });
    }
    window.addEventListener("pagehide", () => { off(); client.dispose(); }, { once: true });
  } catch (error) {
    draft.disabled = submit.disabled = true;
    status.textContent = error.code || error.message;
  }
})();
```

`onSnapshot` 立即提供当前快照并返回取消订阅函数。`resize(height)` 仅 tool-result 可用，160–640 px；侧栏不调用。`dismiss()` 经确认结束业务交互，不能撤销已执行工具；`dispose()` 清理页面通信，不改变业务状态。pending/running 回执只表示受理；unknown/timeout 要先查会话回执，不自动重试。

## 本地输入与隐藏/关闭

插件作者管理自己的表单、选择和光标。宿主切换侧栏标签或收起面板只是隐藏，保留同一 iframe 和本地输入；明确关闭显示会销毁 iframe，重新打开从当前业务快照初始化，未交接的本地输入不恢复。宿主不缓存插件表单。业务 revision 更新时才重建结果/选择；主题、字体、减少动画或能力同 revision 更新不能清空编辑。

## 安全与边界

UI 没有父 DOM、Node、preload、文件、网络、剪贴板、任意 IPC/工具权限。只用附带 SDK；不用 CDN、外部脚本/CSS/字体、嵌套 frame、手写 MessagePort 或 innerHTML 渲染用户内容。按钮具体说明会执行什么，支持键盘、窄宽度和 disabled 状态。样式由用户查看反馈，不能把行为检查称为视觉验收。

业务 data 最多 256 KiB，Native action args 最多 64 KiB，交接 data 最多 32 KiB；定义 JSON 最多 256 KiB，HTML 最多 2 MiB。标签最多 80 Unicode 字符；每插件最多 8 个定义、16 组件，每组件最多 16 动作。样例的 Native preview 为参数包装预留空间，把可交互文本 JSON UTF-8 限在 48,000 字节；更大文本只提供文字检查结果。

UI 自动请求安装权限 ui:render/ui:invoke-own-tools，即使 actions 为空；不替代参数和工具权限检查。当前 Desktop/后台需支持 pluginUi=2、pluginUiLifecycle=1 和本地隔离；普通会话交接还需 pluginUiConversation=1。增加 UI 的旧安装需要重新确认；重装 Skill 不能升级客户端。
