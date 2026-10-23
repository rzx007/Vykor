# Vykor Client SDK

> 状态：当前客户端 SDK 的独立安装、使用和发布入口。

`@vykor/client` 让网页、IDE、Node 脚本和其他应用通过 HTTP 调用同一个 Vykor daemon。任务在 daemon 所在机器执行，会话、运行和权限记录由 daemon 保存；客户端保存连接和展示状态。直接在程序进程内运行 Agent 的方式见 [Agent SDK](./agent-sdk.md)。

## 安装与连接

```bash
npm install @vykor/client
```

发布包提供 ESM JavaScript 和类型声明，运行时无其他 npm 依赖。Node.js 要求 >= 20.3；浏览器需支持 fetch、ReadableStream 和 AbortController。工作区开发仍使用 Protocol 源码，发布时把需要的实现和声明合并进 SDK。

```js
import { VykorClient } from "@vykor/client";

const client = new VykorClient({
  baseUrl: "http://127.0.0.1:8787",
  token: process.env.VYKOR_TOKEN,
});
console.log(await client.protocol.capabilities());
console.log(await client.sessions.list());
```

服务可由 `vk serve --host 127.0.0.1 --port 8787 --register` 启动。它需要事先配置好模型提供商；SDK 不安装模型或替调用者配置凭据。Node 可从本机登记文件取得生成的 token，见下一节。

浏览器使用同一个主入口，由应用提供地址与 token。服务端需通过 `--allow-origin` 配置网页的准确来源。远程连接直接传远端地址；`cwd` 指向服务端机器的工作目录。构造参数也允许自定义 `fetch`，例如接入应用自己的传输处理。

## 本机后台服务

Node 专用功能从 `@vykor/client/service` 导入；浏览器主入口不加载进程或文件管理代码。

先把 CLI 安装到调用方项目：

```bash
npm install @rzx/ohs
```

```js
import { VykorClient } from "@vykor/client";
import { Service } from "@vykor/client/service";

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

下面的 Node 示例使用已配置的模型，拒绝示例运行中出现的工具权限请求，并读取本次运行结束后的文本。`admitPrompt` 返回任务已接收的信息，实际结果通过会话同步取得。

```js
import {
  VykorClient, syncEvents, selectFirstPendingPermission,
  selectVisibleSessionMessagesWithParts,
} from "@vykor/client";
import { Service } from "@vykor/client/service";

const model = process.env.VYKOR_MODEL;
if (!model) throw new Error("请设置 daemon 已配置可用的 VYKOR_MODEL");
const endpoint = await Service.ensure();
const client = new VykorClient(Service.clientOptions(endpoint));
const session = await client.sessions.create({ cwd: process.cwd(), model });
const admitted = await client.sessions.admitPrompt(session.id, {
  id: crypto.randomUUID(),
  items: [{ type: "text", text: "请简短介绍你的能力，不调用工具。" }],
});
const runId = admitted.run?.id;
if (!runId) throw new Error("这次输入没有创建可等待的 Run，请检查准入结果");

for await (const update of syncEvents(client, {
  sessionId: session.id,
  signal: AbortSignal.timeout(120_000),
})) {
  const bucket = update.state.buckets[session.id];
  const permission = selectFirstPendingPermission(bucket);
  if (permission) await client.permissions.reply(permission.id, { status: "denied" });
  const run = bucket?.runs[runId];
  if (!run || run.status === "pending" || run.status === "running") continue;
  if (run.status !== "completed") throw new Error(run.error ?? run.status);
  const text = selectVisibleSessionMessagesWithParts(bucket)
    .filter(({ message }) => message.role === "assistant" && message.runId === runId)
    .flatMap(({ parts }) => parts.filter(part => part.type === "text").map(part => part.text ?? ""))
    .join("\n");
  console.log(text);
  break;
}
```

同步先取完整快照，再接收 SSE（服务端持续推送的事件）。即使订阅开始前任务已结束，也能从快照读到结果；断线后自动重连并重新核对状态。界面应使用共享同步和选择函数，避免把重试前已被替换的文本永久拼到结果里。

需要重试同一笔提交时，重用相同 `id` 和内容；新任务使用新 `id`。提交结果可能表示开始、排队或对正在运行的任务补充输入，调用方应检查返回的 `input`、`run` 和 `queue_state`。已有会话存在并发工作时，用服务端返回的运行 ID 区分每次任务。

## 权限、取消与错误

真实应用可以把 `selectFirstPendingPermission(bucket)` 的请求显示给用户，再提交：

```js
await client.permissions.reply(requestId, { status: "approved", decision: "once" });
// 或 status: "denied"
```

中断后台任务使用 `client.sessions.interrupt(sessionId, { expectedRunId: runId })`。给 HTTP 请求或 `syncEvents` 传 `AbortSignal` 只取消本地请求或订阅；后台任务可继续执行。

非成功 HTTP 响应抛出 `VykorApiError`，携带 `status` 和 `body`。协议不匹配抛出 `IncompatibleProtocolError`，调用方应升级对应客户端或服务端。`syncEvents` 对一般断流自动重连；取消与不支持的事件格式会结束同步。完整状态规则见 [Client Sync Flow](./client-sync-flow.md)。

## 构建与验证

仓库中运行：

```bash
pnpm --filter @vykor/client build
pnpm --filter @vykor/client check-types
pnpm --filter @vykor/client test
pnpm --filter @vykor/client test:pack
```

`test:pack` 会打包、在临时项目实际安装 tarball，验证 Node 调用、Node 服务入口、两种 TypeScript 模块解析方式和浏览器构建。它使用独立测试子进程，不操作用户已有 daemon。`pnpm pack` 的 prepack 自动构建，发布目录为 `packages/client/dist/`。

## 发布

SDK 独立管理 npm 版本，不改 Desktop/CLI 的 tag 发版。先预演：

```bash
pnpm release:client:dry -- 0.1.0
```

正式发布可手动运行 `pnpm release:client -- 0.1.0`，或触发 GitHub Actions 的 **Client SDK Release**，填写明确的 `x.y.z`。脚本临时设置候选版本，先构建并验证该版本安装包，再发布；无论成功失败都恢复本地 manifest。验证失败不上传，预演带 `--dry-run` 不上传。

工作流先在 Windows/Linux、Node 20/24 验证，再通过 npm Trusted Publishing 发布。首次使用前，需要在 npm 的 `@vykor/client` 包设置中配置对应仓库与工作流文件 `client-sdk-release.yml`；首次包创建可用已登录账号运行本地发布。仓库内不会自动创建 npm 授权。已发布的版本不可覆盖，修复时使用新版本。

首次也通过 GitHub Actions 发布时，先确保 npm `vykor` 组织已经创建，仓库的 `NPM_TOKEN` secret 属于账号 `rzx100`，并具有该作用域的读写权限及 Bypass 2FA。先设置 `bootstrap_token=true`、`publish=false` 运行一次，检查 token 身份和所有 SDK 检查；通过后以 `publish=true` 发出首版，实际上传时由 npm 验证发布权限。token 不需要额外的组织管理权限，工作流不会打印 token。

包创建后，可用 `npm trust github @vykor/client --repository rzx007/Vykor --file client-sdk-release.yml --allow-publish --yes` 配置工作流信任，按 npm 要求完成二次验证；使用 `npm trust list @vykor/client` 回读。之后保持 `bootstrap_token=false`，发布使用 GitHub 临时凭据，不向该步骤提供 `NPM_TOKEN`。发布后工作流会回读公开版本和摘要；同一版本已存在时停止，避免重复上传。

## 维护入口

- [客户端包](../packages/client/README.md)：目录与 API 分类。
- [本机服务管理](../packages/client/src/service/README.md)：登记、进程和状态归属。
- [构建与安装包验证](../packages/client/scripts/README.md)：独立发布边界。
- [产品接入](./product-surface-integration.md)：各产品共用会话与执行记录的规则。
