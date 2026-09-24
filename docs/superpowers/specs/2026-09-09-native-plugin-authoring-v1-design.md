# 原生插件第一阶段：开发规范与参考插件

状态：实现、验收与独立审查已完成。

## 目标与范围

开发者可以从公开文档和参考代码出发，编写一个 Vykor Native Plugin，完成校验、本地开发链接、正式安装和实际工具调用，并知道错误从哪里查看、何时需要重载。

本阶段落实 [插件系统交接](../../plugin-system-handoff.md) 的 Native 运行格式与安装边界。Converter 到此停止扩展，不是本阶段的开发对象。

参考业务选为“文本检查助手”：检查调用者提供的文本，报告行尾空白与行首制表符。它不依赖文件读写、网络、密钥、第三方库或模型服务，因此可以在自动化测试中验证真实 Tool Host 调用。样例选择用于验证开发接口，不代表产品只能支持文本工具。

## 当前代码证据

| 已存在的能力 | 当前入口 | 对本阶段的影响 |
| --- | --- | --- |
| Native manifest 与路径校验 | `packages/plugins/src/manifest/schema-v1.ts`、`paths.ts` | 延续 schemaVersion 1，不增加第二种格式 |
| 五类组件加载 | `packages/plugins/src/load-native-plugin.ts` | 文档覆盖 Skills、Agents、Hooks、MCP、Node Tools |
| Tool 注册与调用 | `packages/agent-runtime/src/native-tools/host-entry.mjs` | 导出 `registerTools()`，工具提供 `invoke()`；不能写成宿主内部的 `execute()` |
| 调用上下文 | `native-tools/protocol.ts` 与 `host-entry.mjs` | 提供 cwd、sessionId、deadline、signal、plugin、permissions |
| 独立进程与调用保护 | `native-tools/tool-host.ts`、`activate.ts`、`guard.ts` | 复用参数检查、超时、取消、审计、名称冲突和清理 |
| 用户安装快照 | `packages/plugins/src/installation/` | 复用 link 与不可变安装，不增加样例专用安装器 |
| 开发重载 | `packages/client/src/commands/session-commands.ts` | 当前会话命令是 `/reload-plugins`，不宣传尚不存在的 `vk plugin reload` |

当前不存在完整的插件配置注入、密钥读取和持久数据访问 API。`permissions` 是授权声明及运行闸门的一部分，不是自动获得文件或网络操作能力的 API，也不是操作系统级沙箱。Tool Host 不继承 daemon 的任意环境变量。以上限制必须在开发指南中直接说明。

## 方案选择

采用“公开现有开发接口的类型定义 + 一个真实参考插件 + 自动验收”。类型入口放在 `@vykor/plugins/sdk`，首版仅用于 TypeScript 或 JSDoc 的开发期检查，插件运行代码无须导入 Vykor。

参考插件的 `.mjs` 必须使用公开子路径的 JSDoc 类型并纳入 `checkJs`。类型检查必须覆盖实际参考代码，不能只在 SDK 包内创建另一份正确样例。类型解析通过仓库测试配置建立，示例运行时保持零依赖。Turbo 对相关测试和类型检查显式包含 `examples/plugins/text-inspector/**`，避免修改包外样例后错误复用旧缓存。

只补文档无法发现类型与实际上下文的偏差；立即创建独立 SDK 包、脚手架 CLI 和配置/密钥系统则会同时引入多条新链路。本阶段先让现有接口有一个经过真实调用检验的公开入口。

## 公开开发接口

新增 `packages/plugins/src/sdk.ts`，导出下列类型，并通过 `packages/plugins/package.json` 的 `./sdk` 子路径暴露。该入口不执行安装、不启动 Runtime、不提供动态注册 Converter 的能力。

- `NativeToolPluginIdentity`：id、name、version、root。
- `NativeToolRegistrationContext`：plugin、permissions、log(level, message)。log 支持 debug、info、warn、error。
- `NativeToolInvocationContext`：plugin、permissions、cwd、可选 sessionId、deadline、AbortSignal 类型的 signal。deadline 为 Unix 毫秒时间戳；取消由 signal 通知。
- `NativeToolDefinition`：name、description、inputSchema、可选 safeToRetry、invoke(input, context)。input 为 `Record<string, unknown>`，结果为现有 `ToolResult`。
- `NativeToolRegister`：接收注册上下文，返回工具数组或其 Promise。

复用现有权限与结果类型，避免在 SDK 中复制另一套定义。不要导出 daemon 内部完整 ToolContext：其 terminal、jobs、settings 等能力并没有传入插件进程。

Runtime 的可复用描述类型使用公共定义的 Pick/引用，保留 IPC 请求编号、消息类型和方法等内部协议。`host-entry.mjs` 仍进行运行时验证；开发期类型检查不替代输入和返回值验证。

工具名称当前是全局注册名，SDK 不承诺自动加前缀。推荐样例名称为 `TextInspectorCheck`，冲突时沿用现有 `tool_name_conflict` 诊断。

## 参考插件

目录位置为 `examples/plugins/text-inspector/`：

```text
.vykor-plugin/plugin.json
skills/check-text/SKILL.md
skills/check-text/references/rules.md
tools/index.mjs
README.md
```

Manifest 使用 `id: example.text-inspector`、`name: text-inspector`、`version: 1.0.0`；显式声明 `./skills/check-text/SKILL.md` 和 Node Tool 的 `./tools/index.mjs`，运行设置为 node/process，不申请权限。

SKILL 负责指导模型将用户文本交给 `TextInspectorCheck`，再根据返回的行号解释问题。它不能声称工具读取了文件、修改了文本，或自动获取了工作区内容。

Tool 接收 `{ text: string }`，拒绝其他字段；最多 100,000 个 UTF-16 code units，与现有 maxLength 检查保持一致。检查规则固定如下：

1. 按 LF 分行；移除每行末尾代表 CRLF 的单个 CR，再判断内容。
2. 以空格或制表符结尾的行报告 `trailing-whitespace`。
3. 以制表符开头的行报告 `tab-indentation`。
4. 行号从 1 开始；同一行的行首问题先于行尾问题返回。
5. 空文本返回空 findings；最多返回 100 条 findings，超出时 `truncated: true`。

返回值为 `content: [{ type: "text", text: JSON.stringify({ findings, truncated }) }]`。不返回原始文本片段，避免把用户正文复制进诊断。该工具无副作用，可声明 `safeToRetry: true`。同步检查有明确输入上限；不把同步循环读取 signal 描述成可及时接收进程消息。超时和强制结束行为复用已有测试；用户主动取消另补真实 Host 回归，覆盖调用前取消、调用中取消和取消后的继续调用。

## 五类组件的开发指南

新增 `docs/native-plugin-authoring.md`，区分“当前可用”和“未来规划”，包含：

- manifest 最小示例、稳定 ID 与版本、包内路径、附属资源保留规则。
- Skills：推荐显式列出 SKILL.md，说明运行时命令名使用插件 name 前缀。
- Agents：Markdown 入口和插件 ID 名称前缀；明确当前不会把 Agent 文件中的内嵌 hooks/MCP 直接激活。
- Hooks：Native 事件名及格式；命令执行位置和资源路径以现有实现为准，不复制外部格式事件名或假定 shell cwd 就是插件根。
- MCP：`servers` 对象、显式 stdio/http/sse；加载配置与连接服务分开说明；声明远端地址不意味着已完成认证。
- Node Tools：registerTools、invoke、上下文、结果、错误、取消、命名冲突；说明当前只支持 local 环境。
- 权限：以实际 `requestedPluginPermissions` 和 Tool 权限解析为依据。示例若声明文件读取，应使用 `filesystem: ["workspace:read"]` 和 Tool 条目中的 `filesystem:workspace:read`；不能沿用不被当前解析器识别的 `workspace.read`。
- 状态与调试：区分校验、安装、组件加载和激活；管理页整体 activation 当前不等价于精确运行状态。
- 配置、密钥和数据：说明当前 API 缺口以及普通卸载保留数据的约定；不指导作者写入安装快照或猜测未公开目录。

指南使用已存在的命令：`vk plugin validate`、`link`、`install-local`、`list --verbose`、`details`、`enable`、`disable`、`uninstall`，开发修改后通过会话 `/reload-plugins` 创建新的运行状态。

## 自动验收

验收使用临时用户配置目录与真实子进程，不调用语言模型，也不连接外部服务。

1. 包内静态检查：校验参考 manifest，确认恰好加载一个 Skill 与一个 Node Tool 入口，未知或错误路径返回诊断。
2. SDK 类型检查：真实 `.mjs` 参考插件通过公开 SDK 类型和 checkJs 编译；误写 execute、返回字符串、使用不存在的配置/终端属性时编译失败。包外样例修改必须使对应 Turbo 任务缓存失效。
3. 真实工具调用：通过既有激活器注册样例，输入 `"ok  \n\titem\n"`，得到第 1 行 trailing-whitespace 与第 2 行 tab-indentation；输入空串无问题；错误输入在调用前被拒绝。
4. 安装快照：将样例副本安装进临时用户目录，删除副本后从安装快照发现、验证、激活并调用成功。
5. 清理：两个不同 cwd 的运行实例各有真实 Host，通过 disable/uninstall 路由调用真实的清理链路，断言两边工具注销、Host 停止，后续发现不再加载；不能仅用空 mock 的调用次数作为完成证据。
6. 开发链接：通过真实 reload 路由关闭旧运行实例，下一次使用返回修改后的结果；权限变更时，slash 输出显示诊断及重新 link/批准的建议。重载仅使旧 Runtime 失效，实际激活发生在下一次使用，不把 HTTP 成功等同于插件激活成功。
7. 主动取消：用可协作等待的测试插件验证调用方 AbortSignal 被送到 Host；调用前取消不执行插件，调用中取消返回 tool_call_cancelled，插件结束后 Host 仍可接受下一次调用。

本阶段不重做安装器、组件激活器和管理页面。若样例验收发现已有实现缺陷，先写出复现用例再局部修正，并记录对现有插件的影响。

### 本轮验收边界

实际实现使用真实 PluginService、安装记录、发现/校验函数、ToolRegistry 和 Tool Host；路由控制测试适配器通过真实 DaemonOperationGate 持有并执行运行实例 cleanup，使用 PID 检查进程退出。slash 使用真实 VykorClient，通过注入 fetch 转入真实 Hono 路由。没有启动完整 AgentPool、模型会话或 TCP 监听，不将这些测试表述为完整桌面端端到端验收。

SDK 和实际样例类型检查，以及 client、agent-runtime、server 相关类型检查通过。缓存输入验证同时包含样例隐藏 manifest、客户端重载代码和共享测试 helper；临时修改样例使三个相关任务摘要变化后已恢复文件。

## 后续阶段

第二阶段处理安装预览、真实运行状态和 Desktop 原生安装入口。配置/密钥/持久数据宿主 API 单独设计，再向样例增加需要这些能力的场景。新增 Output Styles、Themes、Workflows、Monitors 以及动态组件分别成阶段，不为了展示能力而塞进参考插件。
