# Text Inspector 原生插件样例

这个样例演示 Skill 和 Plugin Agent 如何将用户文本交给 Node Tool，并按返回行号解释问题。插件 ID 为 `example.text-inspector`，版本为 `1.0.0`，不申请权限。宿主在独立 Node 子进程中加载 `tools/index.mjs` 的 `registerTools` 导出。

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

工具只处理传入文本，无文件读写或额外进程调用，也不返回原始文本片段，因此声明 `safeToRetry: true`。同步检查受输入长度限制；它不承诺在同步循环期间及时收到取消消息。

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

重新打同一个插件 ID 的包并再次导入，就是手动更新或修复。这个样例不申请权限，所以正常情况下不会弹权限确认；如果你给 manifest 新增权限，重新导入时需要确认新增权限。

常见失败：

- 找不到 manifest：确认插件包内有且只有一个 `.vykor-plugin/plugin.json`。
- 导入成功但当前对话不能用：开新对话，或在没有运行中任务时执行 `/reload-plugins`。
- Tool Host 启动失败：检查 `tools/index.mjs` 是否能被 Node 正常 import，不要普通 import `@vykor/plugins/sdk`。
- 工具输入无效：只传 `{ "text": "..." }`，不要传字符串或额外字段。
