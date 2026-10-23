# @rzx/client

连接 Vykor daemon（`vk serve`）的共享客户端 SDK。面向 TUI / Web / Desktop / IDE：typed HTTP API、SSE 事件流、事件 reducer、snapshot + live 同步。

客户端只负责展示与控制，不拥有 agent runtime。

## 独立安装

```bash
npm install @rzx/client
```

发布包包含 ESM JavaScript 和完整类型声明，不要求安装本仓库或其他 `@vykor/*` 包。浏览器入口使用标准 fetch；Node.js 要求 >= 20.3。

连接已启动的 daemon 时提供地址和 token。需要由程序启动本机 daemon 时，在调用方项目另装 CLI：

```bash
npm install @rzx/ohs
```

```ts
import { VykorClient } from "@rzx/client";
import { Service } from "@rzx/client/service";

const endpoint = await Service.ensure();
const client = new VykorClient(Service.clientOptions(endpoint));
console.log(await client.sessions.list());
```

`Service.discover()` 只查找，`Service.ensure()` 在缺少服务时启动，`Service.stop(endpoint)` 只停止传入的同一个登记实例。进程控制仅从 `/service` 子入口导入。退出脚本通常只需结束订阅，后台可以继续供其他客户端使用。

完整的任务提交、结果读取、权限、取消、远程连接与发布步骤见 [Client SDK 使用指南](../../docs/client-sdk.md)。SDK npm 版本独立管理；首次发布前可先在仓库运行 `pnpm --filter @rzx/client test:pack`，验证真实 tarball 的独立安装。

```text
TUI / Web / Desktop
        |
        | @rzx/client
        | HTTP actions + SSE events
        v
vk serve / daemon
```

## 职责

| 模块 | 作用 |
|------|------|
| `transport/http-client.ts` | `VykorClient`：只组装当前领域 Resource |
| `reducer.ts` | `applySessionSnapshot` / `applyEvent`：快照水合后归并实时事件 |
| `selectors.ts` | `selectSessionMessagesWithParts` / `selectFirstPendingPermission` 等纯函数读视图 |
| `sync.ts` | `syncEvents`：会话先读取原子 snapshot，再从 snapshot cursor 接 SSE live |
| `types.ts` | 请求/响应与客户端聚合状态类型 |

### 状态所有权矩阵

| 状态类别 | 包含内容 | 唯一所有者 | 规则 |
|---|---|---|---|
| **Durable Remote State** | Session, Input, Message, Part, Run, Task, Permission, Event cursor | `@rzx/client/state` (`reducer`, `snapshot`, `sync`) | 平台层不得自行实现第二套 Message/Run/Task 对账 |
| **Connection State** | daemon registry, client instance, connected/reconnecting/error, abort/generation fencing, retry timers | 平台 connection controller / service | 纯平台生命周期持有，不混入 durable 对账 |
| **Operation State** | create/update/archive, prompt admission, upload, job 操作, optimistic tokens | 各平台 feature store / hook | 失败只回退局部 operation，不重置全局 durable 状态 |
| **Draft State** | composer text, attachments, plugin selection, edit state | 各平台 composer feature | 纯本地瞬态，不跨 session 混淆 |
| **View State** | selected session/project, panels, scroll, filters | UI store | 纯界面派生展示状态 |
| **Platform State** | window, tray, updater, filesystem, terminal, IPC | Desktop main / preload | 不得泄漏到共享 Client 或 Web 前端 |

约束：

- UI 不直接读 daemon 内部 store 文件
- 可恢复状态来自 HTTP snapshot + SSE live
- 多端 attach 同一 daemon 时，用同一套 reducer 收敛状态
- 公共 Session/Run/Event/Job/Terminal 类型来自浏览器安全的 `@vykor/protocol`
- client 生产代码不依赖 `@vykor/services`、`@vykor/jobs`、`@vykor/terminal`、SQLite、Drizzle 或 Node builtin
- Session Snapshot、Event、Job 和 Terminal 响应会在进入客户端状态前检查字段
- `/doctor` 等本机信息由宿主提供；浏览器可以不提供

## 使用

```ts
import {
  VykorClient,
  syncEvents,
} from "@rzx/client";

const client = new VykorClient({
  baseUrl: "http://127.0.0.1:12345",
  token: registry.token,
});

await client.protocol.health();
const session = await client.sessions.create({ cwd: process.cwd(), model: "gpt-5" });
await client.sessions.admitPrompt(session.id, {
  id: "prompt-1",
  items: [{ type: "text", text: "hello" }],
});

for await (const update of syncEvents(client, { sessionId: session.id })) {
  // update.source: "snapshot" | "live"
  // update.state: VykorClientState
  console.log(update.event?.type ?? "snapshot", update.state.lastSeq);
}
```

当前主要消费者：

- `apps/frontend` 的 `useServerSync`（TUI）
- `apps/cli` 的 `print-session.ts`（用户 headless print）

## API 架构与 Resource 体系

`VykorClient` 采用按领域划分的命名资源体系：

| Resource / 命名空间 | 职责范围 |
|---|---|
| `client.protocol` | 协议握手、版本兼容性检查、服务健康探测与能力查询 (`ProtocolClient`) |
| `client.system` | 系统配置、命令列表、MCP 状态、Dream、记忆管理 (`SystemResource`) |
| `client.providers` | 模型提供商、Catalog 连接与模型列表 (`ProviderResource`) |
| `client.auth` | 第三方身份认证与登录/注销 (`AuthResource`) |
| `client.projects` | 项目目录绑定、别名与元数据管理 (`ProjectResource`) |
| `client.plugins` | 插件发现、本地/归档/Git 安装、启用/禁用与重载 (`PluginResource`) |
| `client.development` | 技能（Skills）、Agent Persona 与 Hook 管理 (`DevelopmentResource`) |
| `client.sessions` | 会话生命周期、Prompt 准入排队、快照与 Goal 管理 (`SessionResource`) |
| `client.attachments` | 附件上传、获取、删除与存储维护 (`AttachmentResource`) |
| `client.permissions` | 权限请求查询与决策回复 (`PermissionResource`) |
| `client.schedules` | 定时任务与调度执行记录 (`ScheduleResource`) |
| `client.jobs` | 后台作业管理、流式通信与取消 (`JobResource`) |
| `client.terminals` | 持久化 PTY 终端会话与事件流 (`TerminalResource`) |
| `client.channels` | 消息通道送达与投递确认 (`ChannelResource`) |
| `client.events` | 会话与系统 SSE 事件流订阅 (`EventResource`) |

公共表面分为两类：

- **长期入口：** `protocol` 和各命名 Resource，是业务调用的默认选择。
- **高级入口：** Resource class 与 state/sync 工具。底层 transport 由 Client 内部持有，不作为实例 API 暴露。

Client 在首次业务请求前读取 `/capabilities`，要求服务端使用相同的 `CURRENT_PROTOCOL_VERSION`（当前为 5）；握手成功后，业务请求都携带 `x-vykor-protocol-version`。`/health` 和 `/capabilities` 是仅有的握手例外。SDK npm 版本与 CLI 版本不要求相同，协议版本必须相同。

## 相关文档

- [docs/client-sync-flow.md](../../docs/client-sync-flow.md)
- [docs/daemon-application-architecture.md](../../docs/daemon-application-architecture.md)

## 测试

```bash
pnpm --filter @rzx/client test
pnpm --filter @rzx/client check-types
pnpm test:client-browser
```

## 目录与维护

| 目录 | 用途 |
| --- | --- |
| [src/](./src/README.md) | 通过 HTTP 与事件流访问 daemon，并维护客户端展示所需的会话状态。 |
| [src/commands/](./src/commands/README.md) | 将会话、设置、诊断等界面操作组织成可复用命令。 |
| [src/configuration/](./src/configuration/README.md) | 处理客户端提交运行配置时使用的公共规则。 |
| [src/protocol/](./src/protocol/README.md) | 在传输层之上统一处理协议请求和公共数据格式。 |
| [src/resources/](./src/resources/README.md) | 按业务职责组织访问 daemon 的资源接口。 |
| [src/service/](./src/service/README.md) | Node 专用的本机后台服务查找、启动和停止。 |
| [src/state/](./src/state/README.md) | 把服务端快照与持续事件合并成可展示、可查询的会话状态。 |
| [src/transport/](./src/transport/README.md) | 实现 HTTP 请求、协议握手和 SSE 事件连接。 |
| [src/types/](./src/types/README.md) | 集中定义附件、扩展能力和状态同步使用的客户端类型。 |
| [scripts/](./scripts/README.md) | 构建、独立安装验证和 SDK 发布。 |

入口与流程：创建传输层和协议客户端，再构造资源接口；命令调用这些接口，状态模块结合快照和事件更新本地视图。

状态归属：远端业务数据由 daemon 保存；连接、订阅和展示状态保存在客户端对象中。

新增实现优先放入职责对应的分类；测试放在被测目录的 `__test__/`。迁移时同步公开导出目标、调用方导入、文档和旧引用清单。

```powershell
pnpm --filter @rzx/client test
pnpm --filter @rzx/client check-types
```
