# DeepSeek Harness 借鉴备忘录

> 状态：历史参考笔记，不是当前实现说明。文中的 `TaskManager`、`WorkflowRunStore` 等名字保留当时语境；当前 Jobs 契约见 [Jobs Protocol](./jobs-protocol.md)。
> 文中的 Docker backend、active session 和 host/Docker file operations 也只记录当时实现，已被 [Native / WSL 运行环境](./sandbox-runtime-flow.md) 取代。

这份文档记录对 `deepseek-ai/deepseek-harness` 的一次横向观察。它不是立即落地计划，而是给后续合适时机做 `web`、`shell`、`sandbox`、`terminal`、文件工具和后台任务能力重构时提供方向。

参考入口：

- DeepSeek Harness packages: <https://github.com/deepseek-ai/deepseek-harness/tree/master/packages>
- Web subsystem: <https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/subsystems/web.md>
- Shell subsystem: <https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/subsystems/shell.md>
- Sandbox subsystem: <https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/subsystems/sandbox.md>
- Terminal subsystem: <https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/subsystems/terminal.md>
- FS package: <https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/packages/fs/README.md>
- Jobs package: <https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/packages/jobs/README.md>

## 总体判断

DeepSeek Harness 最值得借鉴的是能力边界，而不是某段具体实现。

它倾向于把每个能力族拆成四层：

- 能力契约：定义调用方看到的接口、输入、输出和错误形状。
- Provider 实现：接具体后端，例如本地 shell、sandbox shell、HTTP fetch、搜索服务。
- Model-facing tool：定义模型能调用的工具 schema 和展示文本。
- 策略与环境层：统一处理权限、工作目录、超时、网络、沙箱、环境变量和降级状态。

Vykor 当前已经有相当多实现，尤其是 `@vykor/sandbox`。后续不需要推倒重来，更适合在现有包内逐步补出这些边界。

## 落地进度

### 2026-08-17：第一阶段 Web seam 已完成

本次保持 `WebSearch` 和 `WebFetch` 的工具名称、输入 schema、默认 DuckDuckGo endpoint、超时和正常结果文本不变，完成了以下内部拆分：

- `packages/tools/src/web/types.ts`：定义 provider、request、result、availability 和结构化错误契约。
- `packages/tools/src/web/runtime.ts`：选择并检查 provider，统一处理未知错误、取消、HTML 转文本和输出截断。
- `packages/tools/src/web/providers/duckduckgo-search.ts`：负责 DuckDuckGo HTML 请求、结果解析和跳转 URL 还原。
- `packages/tools/src/web/providers/http-fetch.ts`：负责 HTTP 请求，分开返回状态、响应头和响应体。
- `packages/tools/src/web/search.ts`、`fetch.ts`：只负责工具输入、调用 runtime 和面向模型的结果文本。
- 默认 runtime 仍只装配 DuckDuckGo search provider 和普通 HTTP fetch provider，没有增加配置 UI 或新的外部服务。

错误现在可以区分：provider 不可用、输入 URL 不合法、网络失败、HTTP 非 2xx、响应读取失败、搜索结果解析失败和请求取消。`available()` 只检查本地配置，不发网络请求。

验证结果：Web provider/runtime/tool 共 13 个聚焦测试通过；`packages/tools` 中可正常收集的 122 个测试全部通过。完整 tools 测试和包级类型检查仍有 3 个测试套件被仓库现有的 `drizzle-orm/better-sqlite3` 依赖缺失阻断，与本次 Web 改动无关；Web 新增实现和测试已通过单独的严格类型检查。

下一步仍按本文顺序进入第二阶段 Shell executor。Web policy，特别是内网地址阻断、redirect 和响应体大小限制，尚未落地，不能因为 provider 边界已经拆出就视为安全策略已经完成。

### 2026-08-17：第二阶段 Shell executor 已完成

本次保持 `Bash` 的工具名称、输入 schema、默认 120 秒超时、Windows shell 方言检查、取消、超时提示和输出文本不变，完成了以下内部拆分：

- `packages/tools/src/shell/types.ts`：定义 `ShellExecRequest`、`ShellExecSpec`、`ShellRunResult` 和 `ShellExecutor` 契约。
- `packages/tools/src/shell/executor.ts`：负责补齐 cwd、timeout、env、输出上限、session/settings、宿主 shell 和 runner 状态，并负责进程启动、输出收集、超时、取消及进程树清理。
- `packages/tools/src/shell/output.ts`：统一 UTF-8 / UTF-16LE 输出解码、换行归一化和输出截断。
- `packages/tools/src/shell/bash.ts`：改为通过 `createBashTool(executor)` 注入 executor，只负责工具输入、方言检查和结果文本渲染；默认 `bashTool` 继续使用本地默认 executor。

resolved spec 会明确记录 runner 状态：直接走宿主机、优先 sandbox 但允许降级、必须走 sandbox，或者已经有 active Docker sandbox。这个状态是执行前事实，不改变 `@vykor/sandbox` 当前已有的实际降级规则。

运行结果现在能在内部区分：命令返回非 0、runner 启动失败、执行超时和用户取消。Bash 对模型返回的文本暂时保持兼容；下一阶段接 sandbox policy 时，可以基于这些稳定字段给不同失败提供不同处理建议。

executor 只保留最多 `maxOutputChars + 1` 个字符，而不是先把无限输出全部放进内存再截断；工具层仍生成原有 `...[truncated]...` 标记。`env` 已进入 executor 契约，但没有新增到 Bash 工具 schema，供 hooks、cron 或未来调用方直接复用。

验证结果：Shell executor/tool/dialect 共 20 个测试通过；`packages/tools` 中可正常收集的 134 个测试全部通过。完整 tools 测试仍有 3 个测试套件被仓库现有的 `drizzle-orm/better-sqlite3` 依赖缺失阻断；Shell 新增实现和测试已通过单独的严格类型检查。

下一步进入第三阶段 Sandbox policy service。该阶段需要统一 shell、file、MCP、cron 和 child-agent 对 sandbox settings 的解释，并在跨能力结果中统一 runner failure、policy denial 和 command failure；本次只完成了 Shell 一侧的结果分类，没有提前修改其它能力。

### 2026-08-17：第三阶段 Sandbox policy service 已完成

本次在 `@vykor/sandbox` 内新增每次调用解析的 `SandboxPolicy`。它不是全局可变配置，而是由调用入口携带的 `cwd + workspaceRoot + sessionId + settings/config` 生成的策略快照。

主要落地点：

- `packages/sandbox/src/policy.ts`：新增 `DefaultSandboxPolicyService`、`resolveSandboxPolicy`、`SandboxPolicyDeniedError` 和失败分类函数。
- `packages/sandbox/src/types.ts`：新增 policy scope、mode、enforcement、filesystem/network 快照、结构化 denial 和 `runner | policy | command` 失败类型。
- `packages/sandbox/src/shell.ts`：`createProcess` / `createShellProcess` 每次调用解析或接收显式 policy。MCP stdio、cron、background task 和 agent task 都经过这两个中央入口。
- `packages/sandbox/src/lifecycle.ts`：runtime 启动也消费同一 policy，不再单独解释 `failIfUnavailable` 和 backend。
- `packages/sandbox/src/path-validator.ts`：路径结果增加 `decision`、`failureKind: "policy"` 和 `filesystem_denied`；显式空 `allowWrite` 现在能真实表达 read-only。
- `packages/tools/src/file/*`：文件路径检查和 host/Docker operations 选择改为消费 policy。
- `packages/tools/src/shell/*`：resolved shell spec 携带 policy，启动阶段能区分 runner failure 和 policy denial。
- `packages/mcp`、`packages/services/src/cron`、`packages/services/src/tasks`：增加可选显式 policy，并沿调用链传到中央 process factory；agent task 会继续把 policy 转交给实际子进程。

当前 policy mode 为 `off | read-only | workspace-write`；enforcement 为 `off | best-effort | required`。这两个字段分别回答“文件能力允许做到什么”和“runner 不可用时是否允许降级”，避免把文件权限和运行后端可用性混成一个布尔值。

兼容性方面，原有 `enabled=false`、best-effort host fallback、strict Docker fail-closed、active Docker session 路由和工具返回文本都保持不变。调用方不传显式 policy 时仍从当前 settings 解析；传入时以该次调用的 policy 为准。

验证结果：sandbox 60 个测试、MCP 29 个测试、Shell/File 24 个测试通过；cron、shell task 和 agent task 的显式 policy 定向测试通过。sandbox、MCP、tools 改动范围和 services 相关文件均通过本地严格 TypeScript 检查。全仓 Turbo 类型检查被当前 pnpm 启动器访问 registry 做签名校验失败所阻断，不是 TypeScript 错误。

仍未落地的部分：network allowed/denied domains 还没有真实拦截；HTTP/Web 的内网地址策略属于 Web policy；不同能力面向用户的错误展示还可以继续统一。下一阶段按本文进入 Terminal service 和 jobs 对齐。

### 2026-08-17：第四阶段 Terminal service 与 jobs 协议对齐已完成

独立协议与首次大改复盘已经拆出到 [Jobs 统一后台任务协议](./jobs-protocol.md) 和 [Jobs Protocol Review 2026-08-17](./jobs-protocol-review-2026-08-17.md)。本节只保留阶段摘要。

本阶段先审计了现有实现，没有重做已经存在的 Terminal。`@vykor/terminal`、`@vykor/terminal-node`、daemon Terminal service、HTTP SSE、Desktop IPC 和 Agent Terminal 工具原本已经具备 PTY、sandbox process、session ownership、scrollback、实时输出与清理能力；child session 也已经通过 `SessionTaskBridgeManager` 进入持久 `SessionTaskRecord` 投影。

本次补齐的是这些长期工作之间的共同控制面：

- 新增 `@vykor/jobs`，定义 owner-scoped `JobSnapshot`，统一 `running | stopping | completed | killed | failed` 状态，以及 `list/read/wait/send/cancel` 契约。
- 新增 daemon `DaemonJobService` 和 `/jobs` HTTP API。它不复制运行状态，而是聚合 Terminal provider、`SessionTaskRecord + TaskManager` 与 `WorkflowRunStore`。
- `ToolContext` 和 daemon Agent host 增加 `jobs` 能力，模型侧新增 `JobList`、`JobRead`、`JobWait`、`JobSend`、`JobCancel`。Terminal 工具注册面只保留 `TerminalOpen` 负责创建持久交互会话，后续观察与控制统一走 Job 工具。
- Terminal 输出存储增加 sequence cursor 和每次读取的字符上限；`wait` 等待真实进程结算。取消先进入 `stopping`，进程资源释放后才进入 `killed`，正常退出按 exit code 投影为 `completed` 或 `failed`。
- Workflow 持久快照增加 `ownerSession`，只有同一 durable session 能通过 jobs 读取或取消；历史无 owner workflow 不会被投影给任意 Agent。
- HTTP client 增加 jobs API；Desktop Terminal 对新的 status 事件和状态集合完成接入。

这次没有新增第二套 job 数据库，也没有把 Terminal 合并进 Bash。Terminal、TaskManager 和 WorkflowRunStore 仍分别拥有执行资源与原始状态，jobs 只负责授权、统一快照和控制路由。

验证结果：Terminal output cursor 3 个测试、Job tools 4 个测试、daemon jobs 4 个测试、jobs HTTP route 2 个测试、workflow store 7 个测试通过；精简后的 TerminalOpen 2 个测试通过。全仓 33 个 package 的 TypeScript 检查通过；相关聚焦回归共 39 个测试通过。

仍可后续增强：当前 Task/Workflow 的 wait 使用 store 快照轮询，未来可接各自事件源；jobs 还没有统一完成通知的 reported/claim 语义，也没有 per-owner 并发准入限制。这两项适合在确实需要自动 completion turn 和统一后台配额时再加。

## 本地现状

当前相关实现主要在：

- `packages/tools/src/web/search.ts`：`WebSearch` 工具，默认走 DuckDuckGo HTML endpoint，并在工具内解析结果。
- `packages/tools/src/web/fetch.ts`：`WebFetch` 工具，直接执行 HTTP fetch，并做简单 HTML-to-text。
- `packages/tools/src/shell/bash.ts`：`Bash` 工具，包含 shell dialect 检查、命令执行、超时、截断、取消和输出格式化。
- `packages/sandbox/src/*`：sandbox runtime，已经支持 `srt` / `docker` backend、网络模式、可复用容器、路径校验、active session 和生命周期管理。
- `packages/mcp/src/sandbox-stdio-transport.ts`：MCP stdio server 通过 `@vykor/sandbox` 的 `createProcess` 启动，让 MCP 也走相同 sandbox 规则。
- `packages/services`、`packages/server`、`packages/coordinator`、`packages/tools/src/agent`：已有 task/workflow/child-agent 等后台任务相关能力，但模型侧协议还可以更统一。

整体看，Vykor 已经具备“能跑”的 runtime 和工具能力，下一步最有价值的是把 provider、policy、tool rendering 和长期任务控制拆清楚。

## 值得借鉴的方向

### 1. Capability family 分层

DeepSeek Harness 的包更强调“能力族”边界。例如 `web` 不是一个孤立工具，而是由 web service、provider、tool 和环境配置组成。

后续可以在 Vykor 里形成类似分层，但不必马上拆成很多 workspace package：

- `packages/tools/src/web` 先抽出 `WebRuntime`、`WebSearchProvider`、`WebFetchProvider`。
- `packages/tools/src/shell` 先抽出 `ShellExecutor`、`ShellExecRequest`、`ShellExecSpec`、`ShellRunResult`。
- `packages/sandbox` 补一个 policy 解析层，让 shell、file、mcp、task runner 都共享同一套 sandbox 策略。

实际作用：调用工具的代码不用知道具体 backend；更换搜索服务、fetch 规则、shell runner 或 sandbox backend 时，不需要大面积改工具实现。

### 2. Web provider-neutral runtime

DeepSeek Harness 的 web 能力把 search/fetch 和 provider 解耦。可借鉴的细节：

- `available()` 只做便宜的本地配置检查，不发网络请求。
- 多个 provider 同时可用但没有明确选择时，返回“配置不明确”，而不是靠注册顺序猜。
- search 返回统一的 `sources[]`，包含标题、URL、snippet 等稳定字段。
- fetch 的 HTTP 状态和响应内容要分开表达，非 2xx 不一定等同于工具本身失败。
- provider 错误需要有类型，例如配置缺失、网络失败、响应过大、解析失败、策略拒绝。

Vykor 当前 `WebSearch` 写死 DuckDuckGo HTML endpoint，且解析逻辑在工具里。`WebFetch` 也直接在工具里处理 HTTP、HTML 清洗、截断和错误。后续可以先保留外部工具 schema，只把内部实现改成：

```ts
interface WebSearchProvider {
  name: string;
  available(): WebProviderAvailability;
  search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult>;
}

interface WebFetchProvider {
  name: string;
  available(): WebProviderAvailability;
  fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult>;
}
```

第一阶段仍然只有 DuckDuckGo/HTTP provider，也有价值，因为边界先稳住了。

### 3. Web policy 要尽早补

Web fetch 是比较容易出安全边界问题的能力。后续建议加一个统一 `WebPolicy`：

- 只允许 `http:` 和 `https:`。
- 默认拒绝 URL credentials，例如 `https://user:pass@example.com`。
- 限制 redirect 次数。
- 限制 response body size。
- 默认阻断 localhost、private IP、link-local 地址。
- 网络访问被禁用时给结构化错误，而不是普通 fetch failure。
- 允许用户或配置显式批准某些内网目标。

实际作用：避免模型通过 `WebFetch` 访问本机服务、云 metadata endpoint 或其它敏感内网地址。

### 4. Shell request/spec/result 三段式

DeepSeek Harness 把 shell 执行分成：

- Request：工具或插件传来的原始输入。
- Resolved spec：补齐 cwd、env、timeout、stdout cap、sandbox policy、runner mode 后的执行说明。
- Result：命令退出码、stdout/stderr、截断状态、超时状态、runner 状态。

Vykor 当前 `Bash` 工具已经有不错的 Windows shell dialect 检查，也能处理超时、取消、输出截断和 sandbox 启动错误。建议保留这些能力，但把执行部分抽为 executor：

```ts
interface ShellExecutor {
  resolve(request: ShellExecRequest, context: ShellExecContext): Promise<ShellExecSpec>;
  run(spec: ShellExecSpec, signal?: AbortSignal): Promise<ShellRunResult>;
  start?(spec: ShellExecSpec, signal?: AbortSignal): Promise<ShellProcessHandle>;
}
```

实际作用：`Bash` 工具只负责参数校验和结果渲染；本地 shell、Docker shell、SRT shell、未来后台 shell 和桌面 terminal 都可以复用同一套执行语义。

### 5. Sandbox policy 每次调用携带

DeepSeek Harness 的 sandbox 更强调“每次调用带 policy”，provider 不应该隐式持有全局策略。这个方向适合 Vykor。

当前 `@vykor/sandbox` 已经有 `ResolvedSandboxConfig`、`SandboxSession`、`startSandboxRuntime`、`createProcess` 等能力。后续可以补一层：

```ts
interface SandboxPolicy {
  mode: "off" | "workspace-write" | "read-only" | "strict";
  cwd: string;
  workspaceRoot: string;
  sessionId?: string;
  network: SandboxNetworkPolicy;
  filesystem: SandboxFilesystemPolicy;
  failClosed: boolean;
}

interface SandboxPolicyService {
  resolvePolicy(input: SandboxPolicyInput): SandboxPolicy;
}
```

实际作用：shell、file、mcp stdio、cron、child-agent 不需要各自解释 settings；一次性提权、只读任务、联网任务也能在同一套模型下表达。

### 6. 区分 runner failure、policy denial 和 command failure

后续结果结构里应该明确区分三类失败：

- Command failure：命令自己退出非 0，例如测试失败。
- Policy denial：sandbox 或权限策略拒绝执行，例如不允许写某路径。
- Runner failure：sandbox 或执行器本身没启动，例如 Docker 不可用。

实际作用：模型和用户能判断下一步是改命令、请求权限，还是修运行环境。现在很多工具容易把这些都混成普通 stderr 或 `isError: true`。

### 7. Terminal / PTY 与 Bash 分开

DeepSeek Harness 单独把 terminal 做成持久会话能力，而不是把它塞进一次性 shell 命令。

这点适合 Vykor：

- `Bash` 继续表示“一次性命令”。
- `Terminal` 表示“持久交互会话”，有 owner/session scope、scrollback、active send、readiness、cleanup。
- 桌面端 PTY、CLI TUI、daemon terminal 可以共享 terminal service，而不是各自封装进 shell 工具。

实际作用：长期运行的 dev server、REPL、watch task、交互式进程不会污染 `Bash` 的简单语义。

### 8. Jobs 协议统一后台任务

DeepSeek Harness 的 jobs 包把后台任务抽成通用控制协议。Vykor 已经有 task/workflow/child-agent/terminal 等多种长期状态，后续可以统一模型侧体验：

- `job_read`：读取最近输出或状态。
- `job_wait`：等待完成或下一次状态变化。
- `job_cancel`：取消后台任务。
- `job_list`：列出当前 session 相关后台任务。

不一定需要新增这些名字，也可以映射到已有 task tools。关键是不同后台能力的状态和控制方式要一致。

### 9. 文件工具 read-before-edit 和 version guard

DeepSeek Harness 的 FS 能力强调写前必须观察当前文件状态。可借鉴为：

- 编辑文件前要求工具层知道文件最近一次读取版本。
- 写入时检查版本仍匹配，避免覆盖用户刚改的内容。
- 对没读过的文件，只允许创建或显式覆盖。
- 对 sandbox 文件操作，保留 resolved path、policy decision 和版本信息。

实际作用：降低误改、覆盖用户改动和跨 session 并发编辑带来的风险。

## 暂不建议照搬

### 1. 不照搬 Cordis/ctx 插件体系

DeepSeek Harness 大量使用 `ctx.*` service 和 plugin composition。Vykor 已经有自己的 `ToolDefinition`、runtime builder、server/services/sandbox 分层。

建议只借鉴边界和契约，不迁移框架。

### 2. 不急着拆成大量 workspace package

DeepSeek Harness 把 provider 和 tool 拆得很细，这适合稳定平台 API 和插件生态。Vykor 当前可以先在现有包内拆模块：

- `packages/tools/src/web/runtime.ts`
- `packages/tools/src/web/providers/http-fetch.ts`
- `packages/tools/src/shell/executor.ts`
- `packages/sandbox/src/policy.ts`

等接口稳定后，再考虑拆出 `@vykor/web`、`@vykor/shell` 等独立包。

### 3. 不把 terminal 做成 Bash 的后台模式

一次性 shell 和持久 terminal 的生命周期、输出读取、取消语义不同。合并实现会让工具表面简单、内部复杂。建议保持两个能力。

### 4. 不先做多 provider 复杂配置 UI

Web provider runtime 第一阶段可以只有一个默认 provider。先把内部契约建好，再逐步接 Exa、Jina Reader、浏览器上下文、插件 provider。

## 后续落地顺序建议

### 第一阶段：Web seam

目标：不改变 `WebSearch` / `WebFetch` 外部工具 schema，只重构内部边界。

建议任务：

- 新增 `WebSearchProvider`、`WebFetchProvider`、`WebRuntime` 类型。
- 把 DuckDuckGo HTML search 包成默认 search provider。
- 把当前 HTTP fetch 包成默认 fetch provider。
- 新增结构化错误类型。
- 给 search/fetch provider 写单测，工具测试只关注渲染和错误映射。

验收标准：

- 原有 WebSearch/WebFetch 行为不回退。
- provider 缺失、网络失败、解析失败、HTTP 非 2xx 能被区分。
- 工具层不再直接写死 provider 细节。

### 第二阶段：Shell executor

目标：把 `Bash` 工具里的执行逻辑拆成可复用 executor。

建议任务：

- 新增 `ShellExecRequest`、`ShellExecSpec`、`ShellRunResult`。
- 把 timeout、cwd、stdout cap、env、sandbox session 解析放进 resolve 阶段。
- 保留现有 Windows dialect mismatch 检查。
- 让 `Bash` 工具只负责输入 schema、调用 executor、格式化输出。

验收标准：

- 现有 shell 测试通过。
- timeout、abort、UTF-16LE Windows 错误解码、输出截断行为不回退。
- executor 可被 hooks、cron、task runner 或未来 terminal 复用。

### 第三阶段：Sandbox policy service

目标：统一 shell、file、mcp、cron、child-agent 对 sandbox settings 的解释。

建议任务：

- 新增 `SandboxPolicyService` 或 `resolveSandboxPolicy`。
- 把 filesystem/network/failClosed/session scope 归一化。
- 结果里区分 runner failure、policy denial、command failure。
- 为 MCP stdio、file tools、shell executor 补同一套 policy 输入。

验收标准：

- sandbox disabled、degraded、unavailable、denied 都有稳定结果形状。
- Docker/SRT 现有能力不回退。
- file 和 mcp 仍通过对应 e2e。

### 第四阶段：Terminal service 和 jobs 对齐

目标：持久 PTY 和长期任务用统一状态协议表达。

建议任务：

- 明确 `Bash` 与 `Terminal` 的能力边界。
- 为 terminal session 引入 owner/session scope、active send、scrollback cap。
- 将 terminal、workflow、child task 的状态投影成统一 job/task view。
- 补 `wait/read/cancel/list` 这类统一控制语义，名称可复用现有 task tools。

验收标准：

- dev server、watch task、REPL 可以通过持久 terminal 管理。
- 一次性 shell 命令仍保持简单结果。
- UI/CLI 能以一致方式展示长期任务状态。

### 第五阶段：File version guard

目标：降低编辑覆盖用户变更的风险。

建议任务：

- 文件读取结果携带版本信息，至少包含 mtime/size/hash 中的组合。
- edit/write 要求传入 observed version，除非显式 create/overwrite。
- 版本不匹配时返回冲突错误，提示重新读取。
- sandbox 路径校验和版本校验都作为结构化事实返回。

验收标准：

- 未读即改的危险路径被拦住或要求显式覆盖。
- 用户并发修改文件时不会被静默覆盖。
- 现有 file tool 行为在普通单 agent 场景下仍顺滑。

## 最小切入点

如果只挑一个近期可做的小切入，建议从 Web seam 开始：

1. 新增 provider 接口和默认 provider。
2. 保持现有工具 schema 不变。
3. 把工具内 HTML 解析、fetch、错误映射移入 provider/runtime。
4. 补 provider 单测。

这个改动面小，能验证“能力契约 + provider + tool rendering”的方向是否适合 Vykor。验证顺了，再把同样模式推广到 shell 和 sandbox policy。

## 一句话结论

DeepSeek Harness 的核心启发是：把能力做成可组合服务，而不是把所有逻辑堆进模型工具函数。Vykor 已经有强 runtime 基础，后续最该补的是 provider-neutral runtime、每次调用携带的 policy、结构化失败类型，以及长期任务的统一控制协议。
