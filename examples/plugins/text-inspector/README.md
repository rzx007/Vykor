# Text Inspector 原生插件样例

这个样例演示完整流程：Skill 或 Plugin Agent 将文本交给 Node Tool；Desktop 在原文字结果旁显示交互入口；用户选择问题，经宿主确认后生成修复文本预览。插件 ID 为 `example.text-inspector`，版本为 `1.1.0`。安装需批准 `ui:render` 和 `ui:invoke-own-tools`，不申请文件、网络或剪贴板权限。

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

## 交互界面如何工作

`components.ui` 指向 `ui/manifest.json`，组件 `text-inspector` 的 HTML 入口是 `./ui/panel.html`。它声明卡片与会话侧栏两个显示位置，动作 `preview` 只绑定同插件的 `TextInspectorPreview`，完成后保持交互打开。

`TextInspectorCheck` 返回原文字结果，另在 `metadata.ui` 放入组件 ID、原文本与问题列表。宿主保存可信实例、版本号与执行状态；插件不能自行伪造这些字段。文本经 JSON 转义后的 UTF-8 长度超过 48,000 字节时不生成 UI 数据，仍返回原检查结果；这是为 64 KiB 动作参数上限保留空间，不是工具的输入长度上限。

在 Desktop 点击“打开交互”，勾选问题后点“生成修复预览”。确认弹窗由主界面提供，默认焦点在“返回”；取消不会执行工具。确认才调用 `TextInspectorPreview`，只替换所选问题：每个行首制表符换为 2 个空格、删除所选行的行尾空白，保留其他内容及 CRLF。新结果存回原实例，页面从 SDK 的快照通知更新；不增加模型输入或自动调用模型。

预览参数为 `{ "text": "原文本", "selected": ["1:trailing-whitespace"] }`。选项来自本次检查结果，最多 100 项，不允许重复、缺失或过期行号。插件工具会重新检查参数中的文本，不信任前端勾选值。

文本框只读，但可以选中后手动复制；插件没有剪贴板接口。Tab、空格和 Enter 使用原生浏览器控件；主题跟随宿主，旧快照只读时禁止修复。关闭显示可以再打开；“结束此交互”经确认后保存结束状态。禁用、重装、卸载或重载由宿主撤销旧界面，原文字结果仍保留。

## 修改与构建 UI

编辑 `ui/panel.template.html`（结构与样式）和 `ui/panel.mjs`（交互），不要手工修改生成的 `ui/panel.html`。在仓库根目录执行：

```sh
node examples/plugins/text-inspector/scripts/build-ui.mjs
```

脚本使用仓库已有 Vite，将公开 `@vykor/plugins/ui-sdk` 及其依赖打包进唯一 HTML。安装后的插件不需要构建工具或运行期依赖。生成文件随源码提交，打包前重新构建；构建会拒绝 Node 依赖。

前端只调用 `createPluginUiClient()`、`onSnapshot`、`requestAction`、`openSidebar`、`resize`、`dismiss` 和 `dispose`。SDK 通过宿主提供的 MessagePort 通信；不要手写通信协议，也不要访问父页面、Node、网络或宿主 preload。

真实 `.mjs` 通过 JSDoc 引用 `@vykor/plugins/sdk` 的 `NativeToolRegister` 类型，无运行期 SDK 依赖，也无需安装样例依赖。在仓库根目录运行：

```sh
node node_modules/typescript/bin/tsc -p packages/plugins/tsconfig.sdk-examples.json
```

在 `packages/agent-runtime` 目录运行真实子进程验收：

```sh
node ../../node_modules/vitest/vitest.mjs run src/native-tools/text-inspector.test.ts
```

`packages/plugins` 的 `check-types` 同时检查公开子路径类型用例和这份实际 `.mjs`。样例目录也参与相关测试与类型检查的 Turbo 缓存输入。

## 打包后在 Desktop 导入

在仓库根目录执行：

```powershell
New-Item -ItemType Directory -Force .\.plugin-dist
Compress-Archive -LiteralPath .\examples\plugins\text-inspector -DestinationPath .\.plugin-dist\text-inspector.zip -Force
tar -cf .\.plugin-dist\text-inspector.tar -C .\examples\plugins text-inspector
tar -czf .\.plugin-dist\text-inspector.tar.gz -C .\examples\plugins text-inspector
tar -czf .\.plugin-dist\text-inspector.tgz -C .\examples\plugins text-inspector
```

然后到 Desktop 插件页导入生成的 `.zip`、`.tar`、`.tar.gz` 或 `.tgz` 插件包。安装成功后开一个新对话，再用 `/text-inspector:check-text` 或自然语言要求模型使用 `TextInspectorCheck`。

如果要验证插件自己的 Agent，先在本轮选择 `example.text-inspector` 插件，再要求模型使用 `example.text-inspector:reviewer` 检查一段文本。这个 Agent 只在插件被选中时可见，创建后仍只能使用当前 Run 允许的插件能力。

重新打同一个插件 ID 的包并再次导入，就是手动更新或修复。由旧版 1.0.0 升级时需要批准新增的两项 UI 权限；声明中没有文件写入或网络权限。

常见失败：

- 找不到 manifest：确认插件包内有且只有一个 `.vykor-plugin/plugin.json`。
- 导入成功但当前对话不能用：开新对话，或在没有运行中任务时执行 `/reload-plugins`。
- Tool Host 启动失败：检查 `tools/index.mjs` 是否能被 Node 正常 import，不要普通 import `@vykor/plugins/sdk`。
- 工具输入无效：只传 `{ "text": "..." }`，不要传字符串或额外字段。
- 有文字但没有交互入口：检查当前 Desktop/后台是否支持 `pluginUi=1`、`pluginUiLifecycle=1`，是否关闭了 `plugins.uiEnabled`，以及文本是否超过 UI 的 48,000 字节限制。CLI/TUI 不等待 UI，继续使用文字结果。
- 已安装但 UI 不可用：在插件详情查看授权、启用状态和快照诊断；不要直接修改已安装快照。
