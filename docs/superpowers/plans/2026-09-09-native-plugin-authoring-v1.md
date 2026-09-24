# 原生插件开发规范与参考插件实现计划

> **面向 AI 代理的工作者：** 使用 superpowers:subagent-driven-development 或 executing-plans 逐任务实施；遵循 TDD 和完成前验证。已按审核意见修订，本阶段任务已完成。

**目标：** 提供与真实 Runtime 一致的插件开发类型、开发指南和可以安装调用的文本检查样例。

**架构：** 复用 Native v1 manifest、用户安装快照和独立 Tool Host。公开类型置于 `@vykor/plugins/sdk`，参考插件为零运行依赖的 `.mjs`，测试通过现有激活器运行。

**技术栈：** TypeScript、ESM、Vitest、Node.js 子进程。

**设计依据：** [原生插件开发规范设计](../specs/2026-09-09-native-plugin-authoring-v1-design.md)。Converter 不属于本计划。

## 任务 1：公开插件作者使用的类型

**文件：** 新建 `packages/plugins/src/sdk.ts`、`packages/plugins/type-tests/sdk.ts`、`packages/plugins/tsconfig.sdk-tests.json`；修改 `packages/plugins/package.json` 与 `packages/agent-runtime/src/native-tools/protocol.ts`。

- [x] 先编写类型样例，定义正确的 `NativeToolRegister`，并以 `@ts-expect-error` 覆盖缺少 invoke、结果类型错误、调用 context.terminal/context.settings 的情况。
- [x] 配置独立类型测试的 tsconfig：继承包配置、rootDir 为包根、include 为类型测试目录、noEmit 为 true；从公开子路径导入类型，验证 package exports 可被解析。
- [x] 执行 `pnpm --filter @vykor/plugins exec tsc -p tsconfig.sdk-tests.json`，确认公共入口尚不存在导致失败。
- [x] 根据设计新增类型和 `./sdk` 的 types 导出；只使用 type import/export，不添加运行期工具包装器。注册与调用的关键签名为：

```ts
export interface NativeToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  safeToRetry?: boolean;
  invoke(input: Record<string, unknown>, context: NativeToolInvocationContext): ToolResult | Promise<ToolResult>;
}
export type NativeToolRegister = (
  context: NativeToolRegistrationContext,
) => NativeToolDefinition[] | Promise<NativeToolDefinition[]>;
```

- [x] `NativeToolInvocationContext` 的字段严格按设计列出的实际宿主上下文定义；`ToolResult` 与权限类型复用现有导出。协议中的注册描述改为公共定义的 `Pick`，IPC 消息字段仍保留在内部。
- [x] 将类型用例纳入包 `check-types`，运行 plugins 与 agent-runtime 类型检查，以及现有 `src/native-tools/tool-host.test.ts`。
- [x] 类型检查配置覆盖真实 `.mjs` 样例并启用 allowJs/checkJs；通过 paths 将公开子路径解析至本仓库 SDK，包内类型测试仍验证 package exports。本阶段不引入样例运行依赖或 npm 发布。

## 任务 2：可运行的参考插件与调用验收

**文件：** 新建 `examples/plugins/text-inspector/` 下设计列出的五个文件；新建 `packages/agent-runtime/src/native-tools/text-inspector.test.ts`；修改 `turbo.json`、SDK 类型检查配置和现有 `tool-host.test.ts`。

- [x] 沿用 `tool-host.test.ts` 的真实注册表和 cleanup 模式创建测试。通过 `validateNativePlugin`、`loadNativePlugin`、`activateNativePluginTools` 加载仓库中的参考目录。
- [x] 先写工具不存在时失败的调用断言，再创建参考插件：

```ts
const result = await registry.get("TextInspectorCheck")!.execute(
  { text: "ok  \n\titem\n" }, { cwd: temporaryWorkspace },
);
expect(result).toEqual({ content: [{ type: "text", text: JSON.stringify({
  findings: [
    { line: 1, code: "trailing-whitespace" },
    { line: 2, code: "tab-indentation" },
  ], truncated: false,
}) }] });
```

- [x] 实现 manifest、Skill 与规则资源，Tool 使用 `.mjs` 导出 registerTools。输入 schema 使用 object、required text、string maxLength 100000、additionalProperties false。
- [x] 实际 `.mjs` 使用 `@type {import('@vykor/plugins/sdk').NativeToolRegister}`；checkJs 直接检查这份文件，验证类型接口与参考插件相连。
- [x] Turbo 中相关包 test/check-types 的 inputs 包含默认包文件及 `$TURBO_ROOT$/examples/plugins/text-inspector/**`。用 dry-run 检查文件进入输入，并对临时修改样例前后的任务 hash 做一次比较，随后恢复样例。
- [x] 实现逐行检查与 100 条结果上限；按设计固定问题顺序；返回文本内容块中的 JSON，不读写文件或调用外部进程。
- [x] 添加空文本、CRLF、同一行两个问题、101 个问题、无 text、text 类型错误、超长文本和多余参数用例；错误输入断言现有 `tool_input_invalid`。
- [x] 测试在 finally 中完成清理；断言注册表移除工具、Host inactive。保留既有超时、进程错误和名称冲突用例；新增调用前 AbortSignal 已取消、调用进行中主动取消、协作结束后 Host 可继续调用的真实子进程回归。

运行：`pnpm --filter @vykor/agent-runtime exec vitest run src/native-tools/text-inspector.test.ts src/native-tools/tool-host.test.ts`。

## 任务 3：正式安装与开发链接验收

**文件：** 新建 `packages/agent-runtime/src/native-tools/native-plugin-authoring.test.ts`、Server 插件生命周期集成测试；修改 `packages/client/src/commands/session-commands.ts` 的重载结果展示并补测试。只在回归证明必要时调整安装/发现/激活代码。

- [x] 每个用例复制参考插件到独立临时源目录，将 `VYKOR_CONFIG_DIR` 指向另一临时目录，并在 finally 恢复环境变量和停止 Tool Host。
- [x] 正式安装：调用 `installLocalNativePlugin`，删除临时源目录，使用 `discoverInstalledNativePlugins` 和 `verifyInstalledNativePlugin` 从快照继续加载并调用。断言 origin native、user scope、已持久化摘要和空权限请求。
- [x] 开发 link：在真实 Host 首次调用后修改工具实现，通过 reload 路由调用 Runtime 清理，再经现有发现/激活入口重建，确认新 Host 返回新结果；断言旧实例工具注销。
- [x] 在链接目录增加权限声明，经 reload 路由获取结果，再验证实际 slash 输出展示 invalid、权限诊断及重新 link/批准的建议；随后确认新发现阶段跳过插件。输出明确“下次使用时重新加载”，不声称已经激活。
- [x] 静态校验与 discover 阶段不得执行插件入口，用临时样例的顶层标记副作用验证这一点；只有激活时才允许在 Tool Host 子进程中执行该入口。
- [x] 必须新增 disable/uninstall 生命周期验收：两个不同 cwd 都激活真实 Host，路由使用实际 Plugin Service 和 Runtime 清理（可用只负责持有 cleanup 的测试适配器，不能空 mock），断言两边工具注销、Host 停止、安装记录更新及后续发现不加载。无须调用模型，不改变用户级安装模型。

运行：`pnpm --filter @vykor/agent-runtime exec vitest run src/native-tools/native-plugin-authoring.test.ts`，再运行 plugins 包测试和相关服务测试。

## 任务 4：作者指南、文档入口与交接

**文件：** 新建 `docs/native-plugin-authoring.md`；补充参考插件 README；更新 `docs/README.md`、`docs/plugins-contributions-design.md`、`docs/plugin-system-handoff.md`。

- [x] 作者指南按设计覆盖五类组件、公开类型、输入返回值、实际权限格式、local 环境要求与配置/密钥/数据边界。所有 manifest 和调用例子与真实测试样例对应。
- [x] 写明从仓库根目录运行的已有命令：

```sh
vk plugin validate ./examples/plugins/text-inspector
vk plugin link ./examples/plugins/text-inspector
vk plugin list --verbose
vk plugin details example.text-inspector
vk plugin install-local ./examples/plugins/text-inspector
vk plugin disable example.text-inspector
vk plugin enable example.text-inspector
vk plugin uninstall example.text-inspector
```

上面的安装/管理命令属于作者手册；自动验收使用临时用户配置，不能修改开发者真实安装状态。开发修改后的重载使用会话 `/reload-plugins`。

- [x] 给新顶层文档添加“> 状态：当前开发指南。”和 docs 目录入口。SDK 在本仓库内可用，未发布前不能宣传为已发布 npm 包。
- [x] 执行类型检查、任务 2/3 的验收、相关 Native/服务回归、`node scripts/check-docs.mjs` 和暂存内容的空白检查。
- [x] 独立审查重点核对：公开类型与实际 Host 一致；导入类型不启动 Runtime；示例无隐含服务依赖；静态阶段不执行入口；停用后清理；文档没有宣称未实现的能力。
- [x] 将交接状态从“规划”更新为实际完成情况，记录测试数和未支持项；代码提交、合并和推送按用户指令执行。

## 完成标准

作者可以照指南运行参考插件；公开类型由编译器检查；参考工具确实通过独立进程被调用；正式快照与开发 link 都有回归；不扩大 Converter、Desktop、新 Component 或配置/密钥系统范围。

## 完成记录（2026-09-09）

- Native plugins 包：48 项通过。
- client session-commands：28 项通过（含重载诊断和空列表警告）。
- Tool Host：11 项通过（含公开上下文和两种主动取消）。
- 真实文本检查样例：13 项通过。
- 正式安装与静态入口验收：2 项通过。
- Server 生命周期及相邻服务/路由回归：44 项通过（含6项真实重载、跨cwd停用与卸载）。
- 以上去重合计146项；SDK公开子路径、实际样例checkJs及plugins/agent-runtime/client/server类型检查通过，CLI实际validate样例通过，文档检查183个Markdown通过。
- Turbo缓存输入包含隐藏manifest与样例资源；临时修改README使agent-runtime test、plugins check-types、server test三个hash变化，随后恢复。Server test额外显式包含客户端源码和共享测试helper。
- 任务审查与最终独立审查通过；最后修正文档的交接状态及输出限额说明。未自动提交或推送本阶段工作。

验收使用真实PluginService、磁盘安装状态、ToolRegistry、Host子进程及PID退出检查；控制测试适配器执行真实cleanup，通过注入fetch调用真实Hono路由。不包含完整AgentPool、TCP鉴权部署或模型/UI端到端测试。
