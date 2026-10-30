# Vykor Client SDK

> 状态：当前客户端 SDK 的独立安装、使用和发布入口。

`@rzx/client` 让网页、IDE、Node 脚本和其他应用通过 HTTP 调用同一个 Vykor daemon。任务在 daemon 所在机器执行，会话、运行和权限记录由 daemon 保存；客户端保存连接和展示状态。直接在程序进程内运行 Agent 的方式见 [Agent SDK](./agent-sdk.md)。

## 安装与连接

```bash
npm install @rzx/client
```

发布包提供 ESM JavaScript 和类型声明，运行时无其他 npm 依赖。Node.js 要求 >= 20.3；浏览器需支持 fetch、ReadableStream 和 AbortController。工作区开发仍使用 Protocol 源码，发布时把需要的实现和声明合并进 SDK。

```js
import { VykorClient } from "@rzx/client";

const client = new VykorClient({
  baseUrl: "http://127.0.0.1:8787",
  token: process.env.VYKOR_TOKEN,
});
console.log(await client.protocol.capabilities());
console.log(await client.sessions.list());
```

服务可由 `vk serve --host 127.0.0.1 --port 8787 --register` 启动。它需要事先配置好模型提供商；SDK 不安装模型或替调用者配置凭据。通常由调用方提供已有 daemon 的地址和 token。仅在需要由 Node 程序管理本机 daemon 时，才使用下一节的 `/service` 入口。

浏览器使用同一个主入口，由应用提供地址与 token。服务端需通过 `--allow-origin` 配置网页的准确来源。远程连接直接传远端地址；`cwd` 指向服务端机器的工作目录。构造参数也允许自定义 `fetch`，例如接入应用自己的传输处理。

## 本机后台服务

Node 专用功能从 `@rzx/client/service` 导入；浏览器主入口不加载进程或文件管理代码。

先把 CLI 安装到调用方项目：

```bash
npm install @rzx/ohs
```

```js
import { VykorClient } from "@rzx/client";
import { Service } from "@rzx/client/service";

const endpoint = await Service.ensure();
const client = new VykorClient(Service.clientOptions(endpoint));
console.log(await client.sessions.list());
```

| 方法 | 行为 |
| --- | --- |
| `Service.discover(options?)` | 返回健康、协议兼容且鉴权通过的本机实例；不存在或不可用时返回 `undefined`，不启动进程 |
| `Service.ensure(options?)` | 复用已有实例，或启动 CLI 并等待登记与健康检查完成 |
| `Service.clientOptions(endpoint)` | 返回可直接传给 `new VykorClient()` 的地址和 token |
| `Service.stop(endpoint, options?)` | 核对登记身份和鉴权后停止该进程；实例已替换时返回 `false` |

登记路径依次使用 `VYKOR_DATA_DIR/daemon/registry.json`、`VYKOR_CONFIG_DIR/data/daemon/registry.json`、`~/.vykor/data/daemon/registry.json`。`file` 可显式指定登记文件。Endpoint 含 token，应按凭据保管。

`ensure` 的默认命令从 `cwd`（默认 `process.cwd()`）定位已安装的 `@rzx/ohs`，用当前 Node 运行 CLI 的 `serve --register --host 127.0.0.1 --port 0`。它不依赖调用者的 `process.argv[1]`，不修改系统自启动设置，也不会结束已有但不兼容的后台。

```js
const endpoint = await Service.ensure({
  cwd: "/path/to/application", // 在这里查找 @rzx/ohs
  version: version => version.startsWith("1."), // 可选 CLI 版本限制
  timeoutMs: 15_000,
  env: { VYKOR_DATA_DIR: "/path/to/isolated-vykor-data" },
});
```

未指定 `version` 时仍强制检查通信协议。SDK npm 版本、CLI 应用版本和通信协议版本是不同的值；通信协议必须完全一致，当前代码导出 `CURRENT_PROTOCOL_VERSION`。

需要指定可执行程序时，传完整命令数组：

```js
const endpoint = await Service.ensure({
  command: [process.execPath, "/installed/vykor/dist/index.js", "serve", "--register", "--host", "127.0.0.1", "--port", "0"],
});
```

命令直接执行，不做 shell 展开；Windows 上使用 Node 和 CLI 文件路径，避免依赖 `.cmd` 包装。自定义 `file` 时，自定义命令必须把实例写到该文件；默认 CLI 可通过 `env.VYKOR_DATA_DIR` 选择对应位置。

同一 Node 进程内，对同一文件的并发 `ensure` 共享一次启动；启动命令、环境和启动取消信号采用首个发起者的设置。后来加入的调用者可以用自己的 signal 结束等待，不影响原发起者。`timeoutMs` 默认启动等待 10 秒、单次探测 1 秒、停止等待 5 秒。启动超时、取消或子进程退出会清理本次启动的子进程；失败时不会替换活着的登记实例。

不同进程或 SDK 副本通过登记文件旁的 `.sdk-start.lock` 目录排队，拿到锁后重新探测服务，避免重复拉起后台。锁每 5 秒续期，异常退出后的残留锁在 10 秒后可收回；需要跨越这一恢复窗口时可设置更长的 `timeoutMs`。

只有明确要停止共用后台时才调用 `await Service.stop(endpoint)`。结束一次脚本通常只需断开订阅，其他客户端仍可继续工作。操作系统服务管理器可能按自己的配置重新启动 daemon，本入口不修改该配置。

## 提交任务与读取结果

下面的 Node 示例连接已有 daemon，使用其已配置的模型，在后台观察权限请求并拒绝它们，然后等待指定 Run 的终态。运行前提供 `VYKOR_BASE_URL`、`VYKOR_TOKEN`、`VYKOR_MODEL` 和 daemon 机器上的 `VYKOR_DAEMON_CWD`。`admitPrompt` 只返回输入接纳结果；完成状态和消息由同步流程取得。

```js
import {
  VykorClient, createPromptRequestId, syncEvents,
  selectFirstPendingPermission, waitForRun,
} from "@rzx/client";

const { VYKOR_BASE_URL, VYKOR_TOKEN, VYKOR_MODEL, VYKOR_DAEMON_CWD } = process.env;
if (!VYKOR_BASE_URL || !VYKOR_TOKEN || !VYKOR_MODEL || !VYKOR_DAEMON_CWD) {
  throw new Error("请提供已有 daemon 的地址、token、模型和工作目录");
}
const client = new VykorClient({ baseUrl: VYKOR_BASE_URL, token: VYKOR_TOKEN });
const session = await client.sessions.create({
  cwd: VYKOR_DAEMON_CWD,
  model: VYKOR_MODEL,
  metadata: { runtime: { model: VYKOR_MODEL } },
});
const admitted = await client.sessions.admitPrompt(session.id, {
  id: createPromptRequestId(),
  items: [{ type: "text", text: "请简短介绍你的能力，不调用工具。" }],
});
const runId = admitted.run?.id;
if (!runId) throw new Error("这次输入没有创建可等待的 Run，请检查准入结果");

const approvalController = new AbortController();
const approvalTask = (async () => {
  for await (const update of syncEvents(client, {
    sessionId: session.id,
    signal: approvalController.signal,
  })) {
    const permission = selectFirstPendingPermission(update.state, session.id);
    if (permission) await client.permissions.reply(permission.id, { status: "denied" });
  }
})().catch(error => {
  console.error("权限观察失败:", error);
});

try {
  const { run, messages } = await waitForRun(client, {
    sessionId: session.id,
    runId,
    signal: AbortSignal.timeout(120_000),
  });
  console.log("Run 终态:", run.status);
  if (run.status === "completed") {
    const text = messages
      .filter(({ message }) => message.role === "assistant")
      .flatMap(({ parts }) => parts.filter(part => part.type === "text").map(part => part.text ?? ""))
      .join("\n");
    console.log(text);
  }
} finally {
  approvalController.abort();
  await approvalTask;
}
```

`waitForRun` 和并行的权限观察都使用同一套同步规则：先取完整快照，再接收 SSE（服务端持续推送的事件）；断线后重新读取快照并继续。即使等待开始前 Run 已结束，也能返回已保存的终态。失败或中断时，它返回真实的 `run.status` 和该 Run 的消息，不自动抛出任务错误，也不自动批准权限。实际产品应将权限请求交给已有审批界面，由用户决定批准或拒绝；示例仅为演示，统一拒绝。

需要重试同一笔提交时，重用相同 `id` 和内容；新任务使用新 `id`。提交结果可能表示开始、排队或对正在运行的任务补充输入，调用方应检查返回的 `input`、`run` 和 `queue_state`。已有会话存在并发工作时，用服务端返回的运行 ID 区分每次任务。

## 会话工作区文件（只读）

`client.files` 按会话访问 daemon 所在机器的实际工作目录，包括子会话自己的目录和独立代码工作树（worktree）。调用方提供会话 ID 和相对路径，不提交宿主目录、执行环境或权限配置。路径用 `/` 分隔，`.` 表示根目录；返回路径同样相对于会话工作区。

先检查 `capabilities.features.sessionFiles >= 1`。旧 daemon 未声明此能力时应提示升级；本次增加能力标记，不改变通信协议版本。

```ts
const capabilities = await client.protocol.capabilities();
if ((capabilities.features.sessionFiles ?? 0) < 1) {
  throw new Error("daemon 尚未提供会话文件接口，请升级 daemon");
}
const signal = AbortSignal.timeout(10_000);
const directory = await client.files.list(sessionId, { path: ".", limit: 100, signal });
const info = await client.files.stat(sessionId, "README.md", { signal });
const text = await client.files.readText(sessionId, "README.md", { maxBytes: 64 * 1024, signal });
const files = await client.files.find(sessionId, { path: "src", pattern: "**/*.ts", limit: 100, signal });
const search = await client.files.search(sessionId, {
  path: "src", query: "TODO", include: "**/*.ts", caseSensitive: false, limit: 100, signal,
});
console.log(directory.entries, info.kind, info.sizeBytes, info.modifiedAt);
console.log(text.content, text.truncated, files.files, search.matches);
```

`sessionId` 来自已有会话或 `sessions.create()` 的结果。五个方法均不启动 Agent、不调用模型、不改变文件和会话事件。取消只结束本次文件操作，不中断 Run。

| 方法 | 结果与上限 |
| --- | --- |
| `list` | 当前一级目录的 `entries`，包含名称、相对路径、类型、可用的大小和修改时间；默认 200 项，最多 1000 项 |
| `stat` | 单个路径的信息；`sizeBytes` 是字节数，`modifiedAt` 是 Unix 毫秒时间，链接类型保留为 `symlink` |
| `readText` | UTF-8 `content`、`encoding` 和 `truncated`；默认读取 256 KiB，`maxBytes` 最多 1 MiB；不会返回切断的 UTF-8 字符 |
| `find` | glob 匹配的 `files: string[]`；默认 100 项，最多 1000 项 |
| `search` | 单行字面文本匹配，返回 `matches: { path, line, text }[]`，行号从 1 开始；默认忽略大小写，默认 100 条、最多 200 条 |

`pattern` 和 `include` 相对于搜索起点 `path`，结果中的路径相对于会话根目录。搜索不解释用户正则，不支持跨行 query。递归查找默认跳过 `.git`、`node_modules`、`dist` 等生成或依赖目录，不递归进入目录链接；被权限禁止的项不进入目录与搜索结果。没有文件监听、创建、保存、移动或删除入口。

目录与搜索最多检查 4000 个目录项。内容搜索每文件最多读取 256 KiB，总读取最多 8 MiB；二进制文件和非法 UTF-8 也计入读取预算。内容匹配的单条文本最多 4096 字符。文件请求最长执行 10 秒；查找和搜索在执行中达到时间、读取量或结果预算时返回 `truncated: true`，表示结果可能不完整。直接读取二进制或非法 UTF-8 返回 `file_not_text`。

每个候选路径都执行工作区边界、真实路径和读取权限检查。明确的 `denyRead`、路径规则、会话工具上限和拒绝配置仍然生效；需要确认的结果直接拒绝，不创建审批或自动批准。WSL 路径在实际 WSL 环境验证，不能可靠映射的权限规则返回不支持，不回退到宿主文件系统。CLI advanced 与其 Agent 一样使用本机文件环境。

HTTP 错误仍由 `VykorApiError` 携带 `status` 与原始 `body`，文件错误响应包含 `code` 和 `message`：

| code | HTTP 状态与含义 |
| --- | --- |
| `file_invalid_request` | 400，非法路径、查询或超出参数上限 |
| `file_forbidden` | 403，路径或会话读取策略拒绝 |
| `file_not_found` | 404，会话或路径不存在 |
| `file_not_text` | 415，目标不是支持的 UTF-8 文本 |
| `file_not_supported` | 501，daemon 未配置文件服务或不能可靠验证环境规则 |
| `file_not_ready` | 503，服务尚未就绪、配置缺失或工作区正在维护 |
| `file_timeout` / `file_cancelled` | 408，直接操作超时或已取消 |
| `file_operation_failed` | 500，其它读取失败；响应不包含宿主绝对路径 |

## 结构化交付

提交新排队任务时可指定 `outputSchema`；Client 检查服务端 `features.structuredDelivery >= 1` 后才发送。它要求模型用 `SubmitResult` 提交 `status`、`summary` 和符合 Schema 的 `data`；没有有效交付会明确失败。

```ts
const admitted = await client.sessions.admitPrompt(session.id, {
  id: crypto.randomUUID(),
  items: [{ type: "text", text: "生成报告并返回路径。" }],
  outputSchema: {
    type: "object", properties: { path: { type: "string" } },
    required: ["path"], additionalProperties: false,
  },
});
if (!admitted.run) throw new Error("输入未创建 Run");
const { run } = await waitForRun(client, {
  sessionId: session.id,
  runId: admitted.run.id,
});
console.log(run.metadata.delivery);
```

回执的 `validation: schema_valid` 表示格式有效；HTTP 不传业务核验函数，因此 `verification` 为 `not_requested`。可信 SDK 宿主可配置核验器读取真实产物，通过后才标为 `passed`。Run 的 `completed` 和交付的 `done/partial/blocked/waiting` 分开：本轮正常结束也可能仍需补充资料。支持的 Schema 子集见 [Kernel 交付](../packages/agent-runtime/src/kernel/delivery/README.md)，它不等同于完整 JSON Schema。

## 权限、取消与错误

真实应用可以并行消费 `syncEvents`，用 `selectFirstPendingPermission(update.state, sessionId)` 取请求并显示给用户，再提交：

```js
await client.permissions.reply(requestId, { status: "approved", decision: "once" });
// 或 status: "denied"
```

中断后台任务使用 `client.sessions.interrupt(sessionId, { expectedRunId: runId })`。给 HTTP 请求、`syncEvents` 或 `waitForRun` 传 `AbortSignal` 只取消本地请求或等待；后台任务可继续执行。

非成功 HTTP 响应抛出 `VykorApiError`，携带 `status` 和 `body`。协议不匹配抛出 `IncompatibleProtocolError`，调用方应升级对应客户端或服务端。`syncEvents` 对一般断流自动重连；取消与不支持的事件格式会结束同步。完整状态规则见 [Client Sync Flow](./client-sync-flow.md)。

## 构建与验证

仓库中运行：

```bash
pnpm --filter @rzx/client build
pnpm --filter @rzx/client check-types
pnpm --filter @rzx/client test
pnpm --filter @rzx/client test:pack
```

`test:pack` 会打包、在临时项目实际安装 tarball，验证 Node 调用、Node 服务入口、两种 TypeScript 模块解析方式和浏览器构建。它使用独立测试子进程，不操作用户已有 daemon。`pnpm pack` 的 prepack 自动构建，产物写入客户端包内的 `dist/`，该目录由构建生成，不进入版本库。

## 发布

SDK 独立管理 npm 版本，不改 Desktop/CLI 的 tag 发版。先预演：

```bash
pnpm release:client:dry -- 0.1.0
```

正式发布可手动运行 `pnpm release:client -- 0.1.0`，或触发 GitHub Actions 的 **Client SDK Release**，填写明确的 `x.y.z`。脚本临时设置候选版本，先构建并验证该版本安装包，再发布；无论成功失败都恢复本地 manifest。验证失败不上传，预演带 `--dry-run` 不上传。

工作流先在 Windows/Linux、Node 20/24 验证，再发布。默认使用 SDK 专属 token，也支持 npm Trusted Publishing（由 GitHub 临时证明工作流身份，不保存长期发布 token）。首次包创建必须使用有发布权限的 token 或本机登录；包存在后才能配置工作流信任。已发布的版本不可覆盖，修复时使用新版本。

首次也通过 GitHub Actions 发布时，使用现有 npm `rzx` 组织，仓库的 `CLIENT_SDK_NPM_TOKEN` secret 属于账号 `rzx100`，并具有 `@rzx` 作用域的读写权限及 Bypass 2FA。SDK 单独使用这个 secret，不复用仓库遗留的 `NPM_TOKEN`；CLI `@rzx/ohs` 已使用 `tag-release.yml` 的工作流信任，无需长期 token。先保持 `bootstrap_token=true`、设置 `publish=false` 运行一次，检查 token 身份和所有 SDK 检查；通过后以 `publish=true` 发出首版，实际上传时由 npm 验证发布权限。token 不需要额外的组织管理权限，工作流不会打印 token。只检查 SDK 代码、暂不检查凭据时，同时设置 `bootstrap_token=false`、`publish=false`。

准备下一次实际发布时，可用 `npm trust github @rzx/client --repository rzx007/Vykor --file client-sdk-release.yml --allow-publish --yes` 配置工作流信任，按 npm 要求完成二次验证；使用 `npm trust list @rzx/client` 回读。新信任配置必须在两天内成功发布一次，否则会过期，因此不要在没有待发版本时提前配置。配置后将 `bootstrap_token=false`，立即通过工作流发布这个新版本；该步骤不再接收长期 token。验证成功后可撤销 SDK 专属 token，并把工作流的 `bootstrap_token` 默认值改为 `false`。发布后工作流会回读公开版本和摘要；同一版本已存在时停止，避免重复上传。具体规则见 [npm Trusted Publishing 文档](https://docs.npmjs.com/trusted-publishers/)。

## 维护入口

- [客户端包](../packages/client/README.md)：目录与 API 分类。
- [本机服务管理](../packages/client/src/service/README.md)：登记、进程和状态归属。
- [构建与安装包验证](../packages/client/scripts/README.md)：独立发布边界。
- [产品接入](./product-surface-integration.md)：各产品共用会话与执行记录的规则。


## Jobs 协议 7

`client.jobs.list` 返回 `{jobs,errors}`；read/wait/send/cancel 的首参数为快照中的完整 target。Agent target 含 kind、jobId、runId，其他类型含 kind、jobId。send 可返回新轮接纳 receipt。具体请求见 [Jobs 协议](./jobs-protocol.md)，旧版连接会被明确拒绝。
