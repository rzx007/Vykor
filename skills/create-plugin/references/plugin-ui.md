# 插件 UI

## 实际运行流程

manifest 指定 UI 定义；同插件 Native Tool 返回 UI 建议数据；宿主验证后把可信实例保存在原工具结果中。Desktop 按需显示内联卡片或会话侧栏。HTML 用浏览器 SDK 读快照、请求动作；用户在宿主弹窗确认后，后台才调用该动作对应的工具。界面关闭、业务结束和取消运行是不同操作。

声明 UI 不会自动打开窗口，不会让普通工具调用等待界面。始终保留文字结果，CLI/TUI、UI 关闭或旧客户端都能读取它。

## 三个必需部分

1. Native manifest 声明 `"ui": ["./ui/manifest.json"]`，同时声明真正存在的工具入口。
2. `ui/manifest.json` 声明组件与动作：

```json
{
  "schemaVersion": 1,
  "components": [{
    "id": "text-inspector",
    "title": "文本格式检查",
    "entry": "./ui/panel.html",
    "surfaces": ["tool-result", "session-sidebar"],
    "actions": [{
      "id": "preview",
      "label": "生成所选修复预览",
      "tool": "TextInspectorPreview",
      "completion": "keep-open"
    }]
  }]
}
```

3. 初始检查工具返回文字与 UI 建议：

```js
return {
  content: [{ type: "text", text: JSON.stringify({ findings, truncated }) }],
  metadata: { ui: {
    schemaVersion: 1,
    componentId: "text-inspector",
    data: { text, findings, truncated }
  } }
};
```

entry 相对于插件根目录，不是定义文件目录。纯展示组件显式写 `actions: []`。action.tool 必须精确匹配同插件真实注册的 Native Tool 名称，不能指向内置、其他插件或 MCP 工具；inputSchema 取自工具，不在 UI 定义里复制。completion 必须为 `keep-open` 或 `resolve`。

插件不生成可信 instanceId、revision 或 `metadata.pluginUi`、`metadata.uiAction`。这些由宿主保存，伪造保留字段不会获得身份。

## 浏览器 SDK 与离线构建

本 Skill 的 `assets/text-inspector/ui/sdk.js` 是浏览器 SDK 的独立构建，暴露 `VykorPluginUi.createPluginUiClient()`。样例构建脚本把它与界面代码一起内联进 HTML，无需 Vykor 源码或下载 npm SDK。不要让 HTML 用外部 `<script src>` 加载它。

界面源码可按下面的接口组织；变量与 render 由插件实现：

```js
const client = await VykorPluginUi.createPluginUiClient();
const off = client.onSnapshot(snapshot => {
  render(snapshot); // 用 textContent/value；按 readOnly 与 activeAction 禁用操作。
});
button.addEventListener("click", async () => {
  try {
    await client.requestAction("preview", { text, selected });
  } catch (error) {
    showError(error.code);
  }
});
window.addEventListener("pagehide", () => { off(); client.dispose(); }, { once: true });
```

完整可运行的业务逻辑、状态处理和按钮样式见附带样例的 `ui/panel.mjs` 与 `ui/panel.template.html`。在复制后的插件目录执行 `node scripts/build-ui.mjs`，提交和打包生成的 `ui/panel.html`；安装和校验不会替作者构建。

| SDK 方法 | 用途及边界 |
| --- | --- |
| `getSnapshot()` | 读取当前实例的快照 |
| `onSnapshot(listener)` | 立即收到快照并订阅更新，返回取消订阅函数 |
| `requestAction(actionId, args)` | 请求宿主确认后执行已声明的工具，不接收任意工具名 |
| `openSidebar()` | 从 tool-result 移到同一实例的侧栏；侧栏里隐藏此按钮 |
| `resize(height)` | 仅 tool-result 可用，限制在 160–640 px |
| `dismiss()` | 经宿主确认结束业务交互，不撤销已经执行的工具 |
| `dispose()` | 清理页面通信，不改变业务状态 |

快照包含 instanceId、revision、status、data、actions、readOnly、theme、locale、surface，以及可选 activeAction、lastAction。数据以快照通知为准：pending/running 回执只表示受理，不是成功；lastAction.executionState 为 unknown 时不自动重试。结果更新后清理旧选择，让用户重新选择。

取消确认会返回 `plugin_ui_user_cancelled`，保持可操作；`plugin_ui_revision_conflict` 要刷新状态并重新选择。初始化或请求失败应显示真实错误、保留原始文字结果，不无限停在加载状态。只读、会话忙和已结束时，禁止提交新动作。

## 安全与交互

UI 没有父页面 DOM、Node、preload、文件、网络、剪贴板、任意 IPC 或任意工具权限。禁止 CDN、外部脚本/CSS/字体、嵌套 frame、手写 MessagePort 协议和使用 innerHTML 渲染用户输入。

主动作突出显示，并说清会执行什么；导航、收起用次要样式；结束或不可恢复操作与普通收起明确区分。不要把“生成预览”写成“已经保存”，不要把“结束交互”写成“撤销修改”。支持主题、窄宽度、键盘焦点与 disabled 状态。

UI 数据是有限 JSON 对象，最多 UTF-8 256 KiB；动作参数最多 UTF-8 64 KiB。定义 JSON 最多 256 KiB，HTML 最多 2 MiB；标签最多 80 个 Unicode 字符。单插件最多 8 个定义文件、16 个组件，每组件最多 16 个动作。样例把可交互文本限制在 JSON 转义后的 UTF-8 48,000 字节，以给包装与选择项留空间；较大文本只返回普通文字检查结果。

声明 UI 自动请求 `ui:render` 和 `ui:invoke-own-tools` 两项安装授权，即使 actions 为空也一样。授权不替代参数和工具权限检查。新增 UI 的旧安装必须重新确认；需要支持 pluginUi=1、pluginUiLifecycle=1 和本地隔离能力的 Desktop/后台，旧安装版不能靠重装 Skill 获得这些功能。
