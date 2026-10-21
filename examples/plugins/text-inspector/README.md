# Text Inspector 原生插件样例

这个样例演示完整流程：Skill 或 Plugin Agent 将文本交给 Node Tool；Desktop 在原文字结果旁显示交互入口；用户选择问题，经宿主确认后生成修复文本预览。插件 ID 为 `example.text-inspector`，版本为 `1.2.0`。安装需批准 `ui:render` 和 `ui:invoke-own-tools`，不申请文件、网络或剪贴板权限。

入口由 `.vykor-plugin/plugin.json` 显式声明：`skills/check-text/SKILL.md` 提供调用指引，`agents/reviewer.md` 提供插件 Agent `example.text-inspector:reviewer`，`references/rules.md` 解释检查规则，`tools/index.mjs` 提供全局工具名 `TextInspectorCheck`。

输入示例：

```json
{ "text": "ok  \n\titem\n" }
```

返回结果的 `content[0].text` 是以下 JSON 字符串：

```json
{
  "findings": [
    { "line": 1, "code": "trailing-whitespace" },
    { "line": 2, "code": "tab-indentation" }
  ],
  "truncated": false
}
```

只接受 `text` 字段，长度上限为 100,000 个 UTF-16 代码单元。按 LF 分行并移除行末单个 CR；同行先报告行首制表符，再报告行尾空白。最多返回 100 条问题，存在更多问题时 `truncated` 为 `true`。无效输入由宿主返回 `tool_input_invalid`。

工具只处理传入文本，无文件读写或额外进程调用，因此声明 `safeToRetry: true`。普通检查文字仍只包含问题行号；短文本另附 UI 数据，预览操作会返回修复后的完整文本。同步检查受输入长度限制；它不承诺在同步循环期间及时收到取消消息。


# 插件应用（MCP Apps）

根清单保持 schemaVersion 1，唯一新页面入口是 `components.apps: ["./ui/apps.json"]`。复制 `assets/text-inspector/ui/apps.json`：其 schemaVersion 为 1，backend 为 `native-tools`，resources 把精确 `ui://` URI 映射到插件内单文件 HTML，tools 引用实际注册的 `TextInspectorCheck`、`TextInspectorPreview`，surfaces 提供会话打开入口。参数 schema 来自 Native Tool 注册，不能复制、改写或增加工具别名。Native Tools 仍通过原 Tool Host、Guard 和权限执行，不需要额外 MCP 进程。

工具保留普通 content 文字，页面数据写 `metadata.appData: { text, findings, truncated }`；宿主把它转为 MCP `structuredContent`。普通业务工具不生成可信 appId、requestId、版本或执行状态。注册 app-only 可见性不代表获得执行权限。

## 页面入口与结果

```js
import { App, applyHostStyleVariables } from "@modelcontextprotocol/ext-apps";
const app = new App({ name: "My App", version: "1.0.0" }, {});
function show(result) {
  if (result.isError) throw new Error("工具失败，请查看回执");
  // 校验 structuredContent 后显示；这里不能再次调用工具或保存。
}
app.ontoolresult = show; // 只消费初始/模型主动推送
app.onhostcontextchanged = context => {
  if (context.styles?.variables) applyHostStyleVariables(context.styles.variables);
};
await app.connect();
// 用户明确点击按钮后：主动返回值不会自动触发 ontoolresult。
const result = await app.callServerTool({ name: "TextInspectorCheck", arguments: { text: "hello " } });
show(result);
```

必须先登记通知再 connect。直接打开只有空表单，不伪造工具结果。完整处理错误、选区和 48,000 字节交互边界的代码见 `assets/text-inspector/ui/panel.mjs`。主题通过官方 hostContext 更新，不清空输入；使用宿主语义颜色，支持键盘及减少动态效果。

## 可见上下文与普通消息

`app.updateModelContext({ content: [{type:"text",text}], structuredContent: selection })` 把明确选中的内容加入原会话可见条目；不覆盖输入框，也不自动发送。普通发送时仍重新检查来源、授权和版本。用户可移除条目。

`app.sendMessage({ role:"user", content:[{type:"text",text}] })` 经宿主确认后发送普通用户消息，成功保持应用打开。只支持文本角色 user，不发送主输入框已有草稿。先检查 `app.getHostCapabilities()` 的 message/updateModelContext 能力。消息总共最多 4096 个 Unicode 字符；上下文结构化 JSON 最多 32 KiB。只携带必要选区，超限提示用户减少选择，不静默裁剪。

工具参数最多 64 KiB、Native appData 最多 256 KiB、MCP 结果最多 1 MiB、HTML 最多 16 MiB、资源解码总量最多 8 MiB。样例原文 JSON UTF-8 超过 48,000 字节时仍返回文字检查结果，省略交互数据。

## 构建、安装和更新

作者复制完整目录后执行 `npm ci`（首次新建锁文件用 `npm install`）和 `npm run build`。package.json/package-lock.json 锁定官方 `@modelcontextprotocol/ext-apps` 1.1.2，以 esbuild 正常打包模块。依赖准备需要 npm 或本地缓存；安装产物 `ui/panel.html` 是完整离线单文件，安装时不构建，也不下载依赖。不得分发 node_modules、使用 CDN、外部脚本/字体或私有页面 SDK。

修改源码后重建 HTML，增加插件版本，按原 install-local/重新导入流程升级。不修改用户安装快照和 dataDir；新权限仍按原规则批准。安装需要 ui:render/ui:invoke-own-tools，仍需实际工具权限、角色 allowedTools、deny 与环境检查。

## 常驻页面边界

切换面板或会话仅隐藏同一 iframe，保留输入和光标。隐藏脚本不能发起新工具、消息或上下文请求；已发送工作继续结算。取消、丢响应和 unknown 不自动重放。unknown 持久阻止后续工具和消息，重开不能解除。

官方 1.1.2 的实验能力 schema 会剥离自定义 namespace，当前不装配 widgetState。窗口关闭或重启不保证表单恢复；跨重启业务数据由插件自行使用原 dataDir 保存。页面没有 Node、preload、父 DOM、文件、网络、子 frame、任意 IPC 或剪贴板权限。不要手写通信协议或用 innerHTML 渲染用户数据。

更新：重新打包同一插件 ID 并导入 1.2.0；沿用原批准规则，不增加文件或网络权限。
