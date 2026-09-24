# LSP Client 设计

> 状态：提议设计，尚未实现。当前代码仍是 `Lsp` 工具调用正则和 ripgrep 的近似搜索；本文定义把它替换成真实 Language Server Protocol 客户端的目标边界、运行流程和验收标准。

## 一句话结论

Vykor 不自己实现语言语义，也不手写 JSON-RPC framing。

第一版使用微软的 `vscode-languageserver-protocol/node` 处理 LSP 消息、请求响应关联、取消和协议类型；Vykor 自己负责语言服务器配置、受沙箱约束的进程启动、连接复用、文档同步、路径映射、权限和 Tool 结果。

```text
模型调用 Lsp
  -> QueryEngine 把 Runtime 持有的 LspHost 放进 ToolContext
  -> Lsp Tool 校验输入并调用 LspHost
  -> LspManager 按 server + workspace 复用连接
  -> LspServerConnection 确保服务器已 initialize
  -> DocumentTracker 确保文件已 didOpen / didChange
  -> vscode-languageserver-protocol 发送真实 textDocument/* 请求
  -> 服务器返回 Location / Hover / Symbol / Diagnostic
  -> Vykor 转回宿主机路径、1-based 坐标和受限文本结果
```

## 为什么要替换当前实现

当前 `packages/services/src/lsp/index.ts` 并没有连接语言服务器：

- `connect()` 只修改一个布尔值；
- `command` 和 `args` 没有用于启动语言服务器；
- `documentSymbols()` 用正则提取少数顶层声明；
- `workspaceSymbolSearch()` 和 `findReferences()` 启动 `rg`；
- `goToDefinition()` 把文本引用全部标成 definition；
- `hover()` 永远返回 `null`；
- `packages/tools/src/search/lsp.ts` 每次调用都会创建一个新的临时 client；
- 没有 initialize、initialized、didOpen、didChange、shutdown 和 exit；
- 没有项目索引、文档版本、诊断缓存或服务器能力判断。

这些结果只能叫文本近似搜索，不能提供 LSP 的语义保证。同名局部变量、import alias、重载、类型定义、继承关系和生成文件都会产生错误结果。

真实实现完成后，正则和 ripgrep 不再作为 `Lsp` 的静默 fallback。需要文本搜索时继续使用 `Grep`；如果以后确实需要符号文本搜索，应使用另一个明确命名的工具，不能让调用方误以为结果来自语言服务器。

## 设计目标

第一阶段必须满足：

1. 通过标准 LSP stdio 连接真实语言服务器。
2. 同一个 Runtime、服务器配置和 workspace 复用同一个进程。
3. definition、references、hover、document symbols 和 workspace symbols 来自服务器。
4. 文件请求前发送正确的 didOpen/didChange，并维护递增版本。
5. diagnostics 来自 publish 或 pull diagnostics，不用执行编译命令伪造。
6. Tool 对外继续使用宿主机路径和 1-based 行列号。
7. 进程启动经过当前 `ExecutionEnvironment.process`；Native 环境中的 SRT 策略仍由底层进程工厂执行。
8. Runtime 关闭时先 shutdown/exit 语言服务器，再停止沙箱。
9. 服务器未配置、未安装、崩溃、超时和不支持操作必须返回不同错误。
10. `Lsp` 保持只读；任何 WorkspaceEdit 只预览，不直接修改文件。

第一阶段不追求：

- 同时内置所有语言服务器；
- 在 Vykor 中重新实现 TypeScript/Python/Go AST；
- 接入桌面编辑器的未保存 buffer；
- 自动安装语言服务器；
- 自动执行 server 发起的 command 或 applyEdit；
- 完整模拟 VS Code Extension Host；
- 在第一次实现中支持增量文本 diff、semantic tokens 或 code actions。

## 三方库决策

### 选择

使用：

```text
vscode-languageserver-protocol/node
```

它是微软 `vscode-languageserver-node` 仓库中的工具无关协议包。Node 入口提供：

- `createProtocolConnection`；
- `StreamMessageReader` / `StreamMessageWriter`；
- `InitializeRequest` / `ShutdownRequest` 等生命周期类型；
- `DefinitionRequest` / `HoverRequest` 等带类型请求；
- `DidOpenTextDocumentNotification` 等通知；
- `Location`、`LocationLink`、`Diagnostic`、`Hover` 等协议类型。

它依赖 `vscode-jsonrpc`，后者负责 Content-Length framing、请求 ID、pending response、消息队列、取消和连接关闭。Vykor 不再新增自己的 framing、dispatcher 或 pending-request 实现。

`@vykor/services` 应直接声明它实际 import 的包。若代码从 `vscode-jsonrpc` 直接 import `CancellationTokenSource` 等对象，也要把 `vscode-jsonrpc` 声明为直接依赖，不依赖传递依赖偶然存在。

安装时必须固定经过本仓库 Node 版本验证的版本，不写宽泛范围。当前开发环境使用 Node 24 和 ESM；旧版 `vscode-jsonrpc` 曾存在 Node 24 子路径解析问题，因此合入前必须运行 ESM import smoke test，确认最终 lockfile 解析出的版本具有正确的 `exports["./node"]`。

### 不选择完整 `vscode-languageclient`

`vscode-languageclient` 面向 VS Code 扩展，依赖 VS Code workspace、document、diagnostic collection、output channel、extension lifecycle 和类型转换。Vykor 运行在 CLI/daemon Runtime 中，不应为了复用高层 client 而模拟 VS Code Extension Host。

### 不选择 `monaco-languageclient`

它面向 Monaco 和浏览器/WebSocket 场景。当前 `Lsp` 是服务端 Agent Tool，不属于 Desktop renderer。以后桌面端加入代码编辑器时，可以另行评估前端 language client，但不能替代 daemon 中的语义工具。

### 暂不选择 `@lspeasy/client`

它提供接近目标的 headless typed client，但目前属于 pre-1.0，API 稳定性和使用验证不足。可以作为原型对照，不作为 Runtime 基础能力的首选依赖。

## 所有权和包边界

### `@vykor/core`

只定义工具可依赖的抽象能力，不依赖 services 或具体 LSP 库：

```ts
export interface LspHost {
  documentSymbols(input: LspDocumentInput): Promise<LspSymbol[]>;
  workspaceSymbols(input: LspWorkspaceSymbolInput): Promise<LspSymbol[]>;
  definition(input: LspPositionInput): Promise<LspLocation[]>;
  references(input: LspPositionInput): Promise<LspReference[]>;
  hover(input: LspPositionInput): Promise<LspHover | null>;
  diagnostics(input: LspDocumentInput): Promise<LspDiagnostic[]>;
}

export interface ToolContext {
  // existing capabilities
  lsp?: LspHost;
}
```

这些 core 类型是 Vykor 自己的稳定 DTO，不直接把三方 `ProtocolConnection`、`Location` 或 `Diagnostic` 泄漏到 tools 和客户端包。

`QueryEngine` 增加 `setLspHost()`，构造 ToolContext 时注入。其模式与现有 MCP、Terminal 和 Jobs host 一致。

### `@vykor/services`

拥有真实实现：

```text
packages/services/src/lsp/
├─ index.ts
├─ manager.ts
├─ server-connection.ts
├─ documents.ts
├─ configuration.ts
├─ paths.ts
├─ normalize.ts
└─ errors.ts
```

- `manager.ts`：选择服务器、查 workspace root、维护连接池。
- `server-connection.ts`：spawn、initialize、request、notification、shutdown、crash recovery。
- `documents.ts`：读取文件、hash、version、didOpen/didChange/didClose。
- `configuration.ts`：扩展名、languageId、root marker 和受信任 server 配置。
- `paths.ts`：宿主机路径、执行环境路径和 file URI 双向转换。
- `normalize.ts`：把协议结果规整成 core DTO。
- `errors.ts`：稳定错误分类和可操作提示。

### `@vykor/agent-runtime`

在 composition root 创建 `LspManager`，把它注入 QueryEngine，并注册 Runtime cleanup：

```ts
const lspManager = new LspManager({
  cwd,
  settings,
  sessionId: options.sessionId,
  pathMapper: executionEnvironment.paths,
});

runtime.queryEngine.setLspHost(lspManager);
runtime.addCleanup(() => lspManager.close());
```

LspManager 构造时不启动进程。第一次有适用请求时才延迟启动，这保证执行环境已经就绪，也避免没有使用 LSP 的会话承担启动成本。

### `@vykor/tools`

`packages/tools/src/search/lsp.ts` 不再 import services 和 `new LspClient()`。它只负责：

1. 验证 operation 的必需字段；
2. 把用户输入交给 `context.lsp`；
3. 控制最大结果数和文本大小；
4. 格式化成 ToolResult；
5. 在 host 未配置时返回明确错误。

工具不选择 server command，不持有连接，也不负责进程回收。

## 配置

在 Settings 中增加：

```ts
export interface LspSettings {
  enabled?: boolean;
  startupTimeoutMs?: number;
  requestTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  maxOpenDocuments?: number;
  maxResults?: number;
  servers?: Record<string, LspServerSettings>;
}

export interface LspServerSettings {
  enabled?: boolean;
  command: string;
  args?: string[];
  languages: string[];
  extensions: Record<string, string>;
  rootMarkers?: string[];
  env?: Record<string, string>;
  initializationOptions?: unknown;
  workspaceSettings?: Record<string, unknown>;
}
```

其中 `extensions` 同时完成扩展名到 languageId 的映射：

```json
{
  "lsp": {
    "enabled": true,
    "startupTimeoutMs": 15000,
    "requestTimeoutMs": 10000,
    "servers": {
      "typescript": {
        "command": "typescript-language-server",
        "args": ["--stdio"],
        "languages": [
          "typescript",
          "typescriptreact",
          "javascript",
          "javascriptreact"
        ],
        "extensions": {
          ".ts": "typescript",
          ".tsx": "typescriptreact",
          ".js": "javascript",
          ".jsx": "javascriptreact",
          ".mts": "typescript",
          ".cts": "typescript",
          ".mjs": "javascript",
          ".cjs": "javascript"
        },
        "rootMarkers": [
          "tsconfig.json",
          "jsconfig.json",
          "package.json"
        ]
      }
    }
  }
}
```

server command、args、env 和 initializationOptions 只能来自受信任设置，不能出现在模型可写的 Tool input 中。

Settings 合并必须对 `lsp` 和 `lsp.servers` 做显式嵌套合并，不能让项目只覆盖一个 server 时删除所有全局 server。配置验证失败时应在 Runtime 创建或首次使用前给出字段级诊断。

第一版不默认自动安装 `typescript-language-server`。未安装时返回包含 server ID、command、实际执行环境和安装建议的错误。

## 服务器选择和 workspace root

请求入口给出 `filePath` 时：

1. 规范化为 cwd 内的宿主机绝对路径；
2. 解析扩展名；
3. 在启用的 server 配置中匹配 languageId；
4. 从文件目录向上查找最近的 root marker；
5. 查找最多到 Runtime cwd，不能越过信任边界；
6. 找不到 marker 时使用 Runtime cwd；
7. 用 `serverId + canonical workspace root + execution identity` 形成连接 key。

多个 server 同时匹配一个扩展名时不能依赖对象遍历顺序。配置应拒绝歧义，或以后增加明确 priority；第一版优先拒绝并要求用户修正配置。

`workspace_symbol` 没有 filePath 时不能只凭 query 猜语言。第一版输入增加可选 `language` 或 `server`；当当前 Runtime 只有一个启用 server 时可以省略，否则返回歧义错误。

## 连接生命周期

`LspServerConnection` 状态机：

```text
idle
  -> starting
  -> initializing
  -> ready
  -> stopping
  -> stopped

starting / initializing / ready
  -> failed

failed
  -> starting（下一次安全请求允许一次受控重启）
```

### 启动

通过现有沙箱入口启动 argv 进程：

```ts
const child = await createProcess(
  [config.command, ...(config.args ?? [])],
  {
    cwd: executionWorkspaceRoot,
    sessionId,
    settings,
    env: config.env,
    stdio: ["pipe", "pipe", "pipe"],
  },
);
```

禁止使用 shell 字符串拼接。stdin/stdout 不存在时立即失败。stderr 进入有上限的 ring buffer 和结构化日志，不混入协议 stdout。

创建 protocol connection 后必须先注册 server-to-client handler，再 `listen()` 和 initialize，避免初始化过程中服务器发来的 request 没有人应答。

### Initialize

初始化参数至少包含：

- `processId`；
- `clientInfo`；
- 执行环境可见的 `rootUri`；
- `workspaceFolders`；
- 支持的 position encoding；
- workspace symbol、document symbol、definition、references、hover 和 diagnostics capability；
- server 配置中的 initializationOptions。

收到 InitializeResult 后保存 `ServerCapabilities`，再发送 `initialized`。只有这一步完成后状态才能进入 ready。

同一个连接的并发首次请求共用一个 `startPromise`，不能启动两个进程：

```ts
if (state === "ready") return;
if (startPromise) return startPromise;
startPromise = startInternal();
return startPromise;
```

### Server-to-client 消息

第一版必须处理：

- `textDocument/publishDiagnostics`：按 URI 和 version 缓存；
- `window/logMessage`：写结构化日志；
- `window/showMessage`：记录但不弹阻塞 UI；
- `workspace/configuration`：只返回该 server 允许看到的配置；
- `client/registerCapability` / `client/unregisterCapability`：记录动态能力；
- `workspace/applyEdit`：默认返回 `applied: false`，说明只读策略；
- 未知 request：返回 MethodNotFound，不悬挂服务器。

未知 notification 可以记录 debug 日志后忽略。

### 关闭

正常关闭顺序：

```text
停止接收新请求
  -> 等正在执行的请求在短窗口内完成
  -> send shutdown request
  -> 收到 response
  -> send exit notification
  -> 等子进程退出
  -> dispose protocol connection
```

shutdown 超时后终止进程，但 cleanup 仍继续，不让一个失联 server 阻塞整个 Runtime 关闭。

Runtime cleanup 注册顺序必须通过测试保证：LSP 先退出，执行环境后释放。不能先终止 WSL 环境进程再尝试给其中的 server 发送 shutdown。

## 文档同步

语言服务器不会自动读取 Tool 提到的文件。每个位置类请求前，DocumentTracker 要保证服务器看到当前磁盘内容。

状态：

```ts
interface OpenDocumentState {
  uri: string;
  hostPath: string;
  executionPath: string;
  languageId: string;
  version: number;
  contentHash: string;
  lastUsedAt: number;
}
```

流程：

```text
读取当前文件
  -> 未打开：didOpen(version=1, full text)
  -> 已打开且 hash 变化：version++, didChange(full text)
  -> 已打开且 hash 未变：不发通知
  -> 更新 lastUsedAt
  -> 发语义请求
```

第一版只使用 full document sync。即使服务器声明 incremental sync，也先发完整内容，避免第一阶段引入 diff 和 UTF 编码区间换算。确认目标服务器兼容后，再单独实现增量更新。

同一连接内的文档同步要串行，保证 version 顺序。多个读取请求可以在同步完成后并发。

达到 `maxOpenDocuments` 时按 LRU 淘汰，发送 didClose 并删除状态。连接崩溃或重启后清空全部 open document 状态；下一次请求重新 didOpen。

第一版只反映文件系统已保存内容。未来桌面编辑器需要未保存 buffer 时，由产品入口显式提供 `DocumentSnapshotProvider`，不能让 services 猜测 renderer 状态。

## 路径和坐标

### 宿主机与执行环境

WSL 中的语言服务器使用 Linux 路径：

```text
host:      D:\code\project\src\a.ts
execution: /mnt/d/repo/src/a.ts
uri:       file:///mnt/d/repo/src/a.ts
```

因此 `ExecutionEnvironment` 需要提供明确路径映射：

```ts
export interface ExecutionPathMapper {
  toExecutionPath(hostPath: string): string;
  toHostPath(executionPath: string): string;
}
```

发给服务器的 cwd、rootUri、workspaceFolders 和 textDocument URI 全部使用 execution path；服务器返回的 Location、LocationLink 和 diagnostics URI 全部转换回 host path。

映射失败、URI scheme 不是 `file`、或者返回路径越过 workspace 时，结果不能直接交给模型。第一版返回明确的 unsupported/external location 标记；默认不读取外部内容。

路径转换必须复用 `ExecutionEnvironment.paths`。不能在 WSL 模式下发送 Windows URI 后假装查询成功。当前只支持 Windows 盘符项目；WSL Linux 文件系统项目在 Git/worktree 和路径映射完整接入前明确拒绝。

### 行列号

Tool 对外继续使用 1-based：

```text
line=1, character=1 表示第一行第一个位置
```

LSP 内部使用 0-based Position。入口减一，结果加一。

character 的单位取决于协商的 position encoding。第一版声明 UTF-16 并保存服务器选择；如果服务器选择未实现的编码，应明确拒绝，而不是返回错误列号。

## Tool 契约

第一版 operations：

```text
document_symbol
workspace_symbol
go_to_definition
find_references
hover
diagnostics
```

位置类操作要求 `filePath + line + character`。旧 `symbol` 字段不再作为 definition/references/hover 的语义依据；如果需要兼容期，应只用于展示或给出迁移错误，不再执行文本搜索。

推荐 schema：

```ts
{
  operation: "go_to_definition" |
    "find_references" |
    "hover" |
    "document_symbol" |
    "workspace_symbol" |
    "diagnostics";
  filePath?: string;
  line?: number;
  character?: number;
  query?: string;
  language?: string;
  includeDeclaration?: boolean;
  limit?: number;
}
```

operation 映射：

| Tool operation | LSP method | 必需输入 |
|---|---|---|
| `document_symbol` | `textDocument/documentSymbol` | `filePath` |
| `workspace_symbol` | `workspace/symbol` | `query`，多 server 时还需 language/server |
| `go_to_definition` | `textDocument/definition` | `filePath`, `line`, `character` |
| `find_references` | `textDocument/references` | `filePath`, `line`, `character` |
| `hover` | `textDocument/hover` | `filePath`, `line`, `character` |
| `diagnostics` | pull diagnostic 或 publish cache | `filePath` |

服务器 capability 不支持对应方法时返回 `unsupported_operation`，不能返回 `(no results)`。

### 输出限制

所有结果必须有上限：

- location/reference 默认最多 50 条；
- workspace symbol 默认最多 50 条；
- hover 文档截断到配置上限；
- 单条 preview 截断；
- Tool 总输出沿用全局输出限制；
- 截断时明确显示 `showing N results; output truncated`。

Tool 文本使用宿主机相对路径和 1-based 坐标：

```text
packages/services/src/lsp/manager.ts:42:11
  class LspManager
```

core DTO 保留完整结构，文本格式化只发生在 tools 层。以后 ToolResult 增加 structured content 时，不需要重写 services。

## Diagnostics

诊断可能来自两条路径：

1. 服务器在 didOpen/didChange 后推送 `textDocument/publishDiagnostics`；
2. 支持 pull diagnostics 的服务器响应 `textDocument/diagnostic`。

第一版策略：

- 始终注册 publish handler；
- 服务器声明 diagnosticProvider 时优先 pull；
- 否则在文档同步后等待一个短、可配置的 settle 窗口读取 publish cache；
- cache 按 connection + URI 保存，并记录 version；
- 旧 version 的诊断不能覆盖新 version；
- server restart 时清空 cache；
- timeout 返回 diagnostics pending/timeout，不冒充“零错误”。

severity 映射为稳定字符串：

```text
1 -> error
2 -> warning
3 -> information
4 -> hint
```

结果保留 source、code、message、range 和 relatedInformation；文本输出可以裁剪 relatedInformation，但 core DTO 不丢失。

## 取消、超时和崩溃

### 两种 AbortSignal

ToolContext 已区分：

- `abortSignal`：本次 Tool 调用及其 timeout；
- `runAbortSignal`：当前 Agent run 生命周期。

共享语言服务器不能绑定本次 Tool 的 `abortSignal`。调用取消时只取消当前 LSP request；Runtime close 才停止 server 进程。

实现一个 AbortSignal 到 JSON-RPC CancellationToken 的桥接，并在完成后移除监听器，避免长生命周期 connection 累积 listener。

### 超时

- initialize 使用 startup timeout；
- 普通请求使用 request timeout；
- shutdown 使用较短 shutdown timeout；
- 超时先取消请求，不立即杀 server；
- 连续超时达到阈值后才把连接标记 unhealthy。

### 崩溃

child close/error 后：

1. 标记 failed；
2. 让 protocol connection reject 未完成请求；
3. 清空文档状态和 diagnostics；
4. 保存 stderr 尾部和 exit 信息；
5. 删除 pool 中不可复用状态；
6. 下一次只读请求允许受控重启一次。

重启必须有频率限制。短时间连续崩溃时进入 cooldown，并把最近 stderr 提供给用户。不能在一个 Tool 调用中无限重启。

## 错误模型

services 使用可判别错误 code：

```text
lsp_disabled
server_not_configured
ambiguous_server
server_command_not_found
server_start_failed
server_initialize_failed
server_crashed
server_unhealthy
unsupported_operation
invalid_position
path_outside_workspace
path_mapping_failed
document_read_failed
request_timeout
request_cancelled
protocol_error
```

Tool 把 code 转成可操作提示，并设置合适的 `failureKind`：

- path/trust/capability 拒绝：`policy`；
- command 不存在或退出失败：`command`；
- 协议、连接和 server crash：`transport`；
- timeout：`timeout`；
- AbortSignal：`interrupted`。

“没有语义结果”才返回正常空数组；配置或运行错误不能转换成空结果。

## 权限与安全边界

`Lsp` 作为只读 Tool 的前提：

1. Tool input 不能设置 command、args 或 env。
2. 文件路径必须在 Runtime cwd 内，并在 services 再做一次 canonical path 校验。
3. server 进程必须通过当前环境的 `process.execProcess`。
4. 项目级 server 配置必须经过与项目插件同等级别的信任门控。
5. 默认拒绝 `workspace/applyEdit`。
6. 默认不执行 server 请求的 workspace command。
7. rename、formatting 和 code action 第一版只返回预览；真正写盘必须走 Edit/Write 权限。
8. 服务器返回的外部 URI 默认不读取。
9. 环境变量只传显式允许的配置，不把整个宿主环境无条件复制给 WSL 进程。
10. 日志不得记录文件完整内容或敏感 initializationOptions。

语言服务器本身可能加载项目插件、扫描 workspace 或启动子进程；“请求是只读”不代表 server 进程天然安全。沙箱和项目配置信任仍然是硬边界。

## 可观察性

每个连接至少记录：

- server ID；
- workspace root；
- execution environment；
- state；
- PID 或环境进程标识；
- initialize duration；
- advertised capabilities 摘要；
- open document count；
- pending request count；
- restart count；
- last error；
- stderr tail 是否可用。

日志事件建议：

```text
lsp.server.starting
lsp.server.ready
lsp.server.start_failed
lsp.server.crashed
lsp.server.restarting
lsp.request.started
lsp.request.completed
lsp.request.timeout
lsp.document.opened
lsp.document.changed
lsp.document.closed
lsp.server.shutdown_failed
```

默认日志不包含请求正文和源文件内容。debug trace 可以记录 method、request ID、耗时和结果数量。

## 测试策略

### ESM import smoke

在仓库实际 Node 版本下验证：

```ts
import {
  createProtocolConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-languageserver-protocol/node";
```

这项测试专门防止 Node 24 与旧包 exports 不兼容。

### 假语言服务器

测试 fixture 启动一个最小 Node 子进程，使用同一协议库作为 server，返回固定结果。它必须能：

- initialize/initialized；
- 记录 didOpen/didChange/version；
- 返回 definition/references/hover/symbols；
- 推送 diagnostics；
- 延迟请求以测试 timeout/cancel；
- 主动退出以测试 crash recovery；
- 记录 shutdown/exit。

测试不应依赖开发机全局安装 `typescript-language-server`。

### Manager 契约测试

- 同 server + workspace 并发首次请求只启动一个进程；
- 两个 workspace 启动两个连接；
- 未修改文件不重复 didChange；
- 修改文件后 version 严格递增；
- LRU 淘汰发送 didClose；
- server restart 后重新 didOpen；
- unsupported capability 返回明确错误；
- diagnostics 旧 version 不覆盖新 version；
- Runtime close 完成 shutdown/exit；
- shutdown 卡住时会强制收束；
- abort 只取消请求，不结束共享 server；
- crash 后 pending 请求全部失败且没有 promise 泄漏。

### Path 和坐标测试

- Windows 盘符路径到 file URI；
- URI percent encoding 和中文路径；
- host/WSL 双向映射；
- 返回 workspace 外路径时 fail-closed；
- Tool 1-based 到 LSP 0-based；
- UTF-16 中 emoji 前后的 character；
- Location 和 LocationLink 都能规整。

### Tool 测试

- 每个 operation 的必需参数；
- context.lsp 缺失时返回 lsp_disabled；
- 正常空结果与服务器错误不同；
- 结果上限和截断提示；
- hover 的 MarkedString、MarkupContent 和数组格式；
- diagnostics severity、source 和 code；
- filePath 越过 cwd 被拒绝。

### 真实 TypeScript E2E

在单独、明确安装 server 的 E2E 环境运行：

```ts
export function greet(name: string): string {
  return `hello ${name}`;
}

const message = greet("Vykor");
```

验收：

- 调用处 definition 跳到 `greet` 声明；
- references 返回声明和真实调用，不返回字符串注释中的同名文本；
- hover 返回函数签名；
- document symbols 返回 `greet`；
- 故意制造类型错误后 diagnostics 返回 TS 错误；
- 多次请求复用同一个 server；
- Runtime 关闭后没有遗留进程。

WSL E2E 在路径映射实现后单独启用，验证 server 在 WSL 中启动、URI 使用 POSIX 路径、结果按契约呈现，以及环境释放前 server 已完成收束。

## 分阶段实施

### 阶段 0：依赖和协议 spike

1. 在 services 固定协议库版本。
2. 增加 Node 24 ESM import smoke。
3. 用假 server 完成 initialize、hover、shutdown 最小闭环。
4. 验证 `createProcess` 返回的流可直接交给 StreamMessageReader/Writer。

阶段出口：真实 JSON-RPC 往返成立，旧正则实现尚未切换。

### 阶段 1：单语言真实 LSP

1. 增加 core LspHost 和 DTO。
2. 实现 connection、manager、documents 和 errors。
3. 接入 Runtime lifecycle 和 ToolContext。
4. Tool 切换为 context.lsp。
5. 支持 TypeScript 的 symbols、definition、references、hover。
6. 删除 `LspClient` 内 regex/rg 冒充路径。

阶段出口：本仓库 TypeScript 真实 E2E 通过。

### 阶段 2：diagnostics 和稳定性

1. publish/pull diagnostics。
2. timeout、AbortSignal bridge、crash recovery 和 cooldown。
3. LRU didClose。
4. capabilities 和动态注册。
5. runtime snapshot 与结构化日志。

阶段出口：失败不再表现为空结果，长时间运行无进程和 listener 泄漏。

### 阶段 3：执行环境路径闭环

1. `ExecutionEnvironment.paths` 暴露双向 path mapper。
2. LSP cwd、URI 和返回路径全部走 mapper。
3. 增加 WSL server 可用性探测和安装指引。
4. WSL E2E。

阶段出口：WSL 模式与 Native 模式返回一致的语义结果，并使用各自环境的路径表示。

### 阶段 4：多语言和高级只读能力

1. Python、Go、Rust 等配置模板。
2. completion、implementation、type definition、signature help、call hierarchy。
3. rename/code action 只读预览。
4. 按服务器补充 initializationOptions 和 workspace/configuration adapter。

每增加一个 server 模板，都要有独立安装说明、root detection fixture 和至少一个真实 E2E；不能只因为扩展名映射存在就宣称支持。

## 完成定义

只有同时满足以下条件，README 才能把 `Lsp` 描述为真实 LSP 集成：

1. Tool 不再调用正则或 ripgrep 伪造语义结果。
2. 至少一个真实语言服务器的 E2E 覆盖 definition、references、hover、symbols 和 diagnostics。
3. 连接在同一 Runtime 内复用，并随 Runtime 可靠关闭。
4. didOpen/didChange/version 有测试证明。
5. server capability、timeout、crash 和未安装都有明确错误。
6. Node 24 ESM import 测试通过。
7. Native 模式路径和坐标正确。
8. 若 README 宣称支持 WSL LSP，则 Windows/WSL 双向路径映射和 E2E 已通过；否则必须明确标注 WSL LSP 尚未支持。
9. `Lsp` 保持只读，server applyEdit 和 command 不会绕过权限。
10. 文档、Settings schema、Tool schema、契约测试索引和 README 与实现同步。

在这些条件完成前，项目状态应表述为“LSP 真实客户端实施中”，不能用 `connect()` 布尔值或文本搜索测试作为完成证明。

## 外部参考

- [Microsoft vscode-languageserver-node](https://github.com/microsoft/vscode-languageserver-node)
- [vscode-languageserver-protocol npm](https://www.npmjs.com/package/vscode-languageserver-protocol)
- [vscode-jsonrpc README](https://github.com/microsoft/vscode-languageserver-node/blob/main/jsonrpc/README.md)
- [Language Server Protocol specification](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/)
- [Node 24 ESM compatibility report for older vscode-jsonrpc](https://github.com/microsoft/vscode-languageserver-node/issues/1740)
