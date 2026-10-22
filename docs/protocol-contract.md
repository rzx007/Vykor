# Protocol Contract

> 状态：当前客户端与 daemon 协议的权威契约。最后核对：2026-10-22。

## 数据所有权与通信边界

Protocol 只负责 HTTP/SSE 通信格式、公开 DTO、请求解码、序列化、错误和协议版本。相同的规范数据可以被明确再导出；能力宿主、存储命令、配置默认值和执行策略不从 Protocol 暴露。本次内部迁移保持版本 5、字段、错误 code/field 和持久格式不变。

| 规范来源 | 正式入口与职责 |
| --- | --- |
| `@vykor/json-data/json` | `JsonValue`、JSON 对象检查、确定性序列化和显式有界复制；没有包根入口 |
| `@vykor/plugin-contracts` | `/manifest`、`/presentation`、`/validation`、`/limits`、`/runtime`、`/runtime-data`；不触达安装器或进程 |
| `@vykor/domain-contracts` | `/sessions`、`/inputs`、`/goals`、`/attachments`、`/schedules`、`/channels`、`/notes`、`/memory`、`/approvals`、`/plugin-apps`、`/workspace-changes`、`/usage`、`/maintenance`；按业务引用，无根汇总入口 |
| 细分领域数据 | `/sessions/records`、`/sessions/model-metadata`、`/sessions/runtime-config`、`/approvals/auto-review`、`/plugin-apps/history` |
| `@vykor/agent-contracts/permissions` | 执行权限模式和审查 Input/Evidence/Result/Outcome；持久审查记录归领域包 |
| `@vykor/jobs/contracts`、`@vykor/terminal/contracts` | 能力参数、状态、结果和事件；活体控制接口留在实现入口 |

Server HTTP 先解码，再显式选取字段形成应用输入；应用服务验证 owner、版本、状态和授权后构造 Services 命令或 Node 绑定，最后由 HTTP 将应用查询结果转换为公开响应。领域校验不导入 `ProtocolValidationError`，错误 code/field 的通信转换留在 Protocol 或 HTTP。

插件 HTTP 入口按 `ProtocolValidationError` 或 plugin-contracts `/runtime-data` 中明确列出的校验错误码返回 400，不按错误文案前缀分类。插件 parser 将校验结果转换为通信错误；Node 的参数、策略和 Native 游标错误携带结构化 code，跨 Runtime bundle 也能识别。未知运行失败仍返回 409；应用错误与请求未接纳的专用响应保持原处理。畸形 JSON、非对象动作请求此前误报 409，现修正为 400，通用响应体仍为 `{ error: "应用请求无效或已失效" }`。

Client 只直接依赖 Protocol。`readSessionRuntimeConfig`、`patchSessionRuntimeMetadata`、模式归一化和 `getPluginAppToolPolicy` 的既有 Client 公开名字由本地辅助实现保留，用于显示已有数据与构造请求；它们不能生成宿主授权。真实模式归一化在 host-config，有效权限计算在 permissions，插件有效策略在 Node。

Client 的源码导出名有一项迁移：旧 `PLUGIN_APP_LIMITS` 聚合对象已移除，调用方按用途选择 `PLUGIN_APP_DATA_LIMITS`、`PLUGIN_APP_INPUT_LIMITS`、`PLUGIN_APP_RESOURCE_LIMITS` 三个公开硬上限常量。公共方法、请求形状与线格式保持原行为，不能把这次调整描述为所有源码导出名均未变化。

通用 JSON 算法只有一个规范来源。canonical 保留对象/数组 `depth >= 20` 拒绝边界；插件复制显式使用 `depth >= 32`；MCP 结果保留自身 `depth > 32` 和复杂度规则，不共用一个默认阈值。

## 当前版本

当前精确协议版本是 `5`（模型网络重试引入输出失效标记与重试 metadata，故从 4 提升到 5）。客户端先读取：

```http
GET /capabilities
```

响应固定包含：

```json
{
  "serverVersion": "0.1.0",
  "protocol": { "version": 5 },
  "features": {
    "steer": 1,
    "runAttempts": 1,
    "toolAttempts": 1,
    "jobs": 2,
    "schedules": 1,
    "workflow": 2,
    "durableChannels": 1,
    "backup": 1,
    "retention": 1
  }
}
```

`serverVersion` 是发布版本；`protocol.version` 决定基本请求和响应能不能互通；`features` 表示某项可选能力的版本。

## 版本匹配

客户端和服务端的协议版本必须完全相等：

```text
client = 2, server = 2 -> 可以连接
client = 1, server = 2 -> 拒绝
client = 3, server = 2 -> 拒绝
```

不接受版本范围，也不在一个服务端里同时维护 v1/v2 两套 route。需要破坏性修改基本形状时提升 `protocol.version`，同时更新 client 和所有产品入口。

Feature 用于同一基本协议下的能力选择。例如客户端使用 Workflow v2 前应检查 `features.workflow >= 2`；不支持时隐藏入口或明确报错，不能用另一个旧请求形状试探。

## 请求解码

会话授权管理是同一基础协议下的附加能力，`features.permissionApprovals = 1`。`GET /permissions/approvals` 返回当前可复用的会话工具授权；`POST /permissions/:requestId/revoke` 撤销所选当前授权，返回持久撤销记录。撤销保留原批准记录，后续调用重新询问；单次批准不能通过此入口撤销为另一种决定。

已清理工作目录的绑定维护使用附加能力 `features.gitWorktreeBindings = 1`。`POST /sessions/:sessionId/worktree-cleared` 仅接收原绑定 `{id, path, branch}`，要求会话已归档、绑定匹配且目录确实不存在（`ENOENT`）。它只移除 `metadata.desktop.worktree`，保留 `settingsRoot` 和其余元数据，持久保存并发布会话更新；已无绑定时幂等。普通归档会话编辑仍被禁止。客户端检查返回的会话身份、归档状态和绑定已移除；目录已删但更新失败时保留待刷新记录，重试只更新绑定。

项目记忆管理使用附加能力 `features.memoryManagement = 1`。记忆记录增加可选 `revision`（持久内容与元数据的 SHA-256 指纹）；`PATCH /memory/:entryId` 必须携带 `cwd`、`content` 和 `expectedRevision`，`DELETE /memory/:entryId` 可携带查询参数 `expectedRevision`，`POST /memory/clear` 必须携带该项目所有当前条目的 `expectedEntries: [{id, revision}]`。修改前检查项目任务和版本，冲突保持原内容；后台未提供此能力时，客户端不发起编辑或清空请求。

设置编辑可提交 `expectedPermission` 或 `expectedSandbox`，分别表示打开编辑器时读取的原值。服务在已有配置文件锁内比较原值，冲突时不保存；比较字段不写入配置。客户端遇到变化应重新读取再编辑。

HTTP route 必须通过 `@vykor/protocol` 的 request decoder 读取 JSON。规则是：

- body 必须是 JSON object；
- 必填字段缺失、类型不对或枚举值无效时返回 `invalid_request`；
- 不能把数字、字符串或旧字段名悄悄改成当前类型；
- 业务冲突与格式错误分开，例如相同 Input ID 带不同正文属于冲突；
- 未经 decoder 验证的 `unknown` 不能直接交给 Application。

## 错误形状

协议错误统一为：

```ts
interface ProtocolError {
  code: string;
  message: string;
  retryable?: boolean;
  details?: Record<string, unknown>;
  traceId?: string;
}
```

- `code` 给程序判断，`message` 给人阅读。
- `retryable` 只表示同一请求是否值得重试，不保证一定成功。
- `details` 放字段名或冲突信息，不放 secret。
- `traceId` 用来和服务端日志对应。

客户端不能靠匹配英文 message 决定业务分支。

## Snapshot 和 SSE

产品 attach 一个 Session 的正确顺序：

```text
GET /sessions/:id/state
  -> 得到一个原子 snapshot 和 cursor
GET /events/stream?cursor=<snapshot.cursor>
  -> 只接收快照之后的事件
```

snapshot 至少包含 Session、Inputs、Messages、Parts、Runs、Attempts、Tasks 和 Permissions。`attempts` 是必填数组，不接受缺失字段的旧快照。

客户端 reducer 按 `seq` 去重。断线后从最后成功应用的 cursor 重连；不能回到 0 后把所有事件再次拼进现有状态。

## Durable cursor 和 live cursor

durable event 写在数据库里，可以 replay。文本 delta 为了及时显示直接走 live SSE，不逐块写事件表；它仍有 cursor，用来防止当前连接重放时重复追加。

两者共用递增序号：

- durable cursor 进入 `eventsBySeq`；
- live delta 只推进 `transientCursor`；
- 重启可能留下未使用的序号空洞；
- 已经发给客户端的序号永不复用。

## Event 格式

每条 Session event 都包含：

```text
id, seq, type, schemaVersion, optional sessionId, payload, createdAt
```

当前 `schemaVersion = 1`。服务端 registry 在写入前检查事件名、scope 和 payload；客户端在应用前再次检查版本。

未知事件名、错误 scope、坏 payload 或未知 `schemaVersion` 必须报错，并且不能推进 cursor。当前实现不提供读取时升级函数。

## Breaking change 清单

下列变化必须被当成破坏性变化：

- 删除或改名必填请求字段；
- 改变字段类型或枚举含义；
- snapshot 删除集合或把必填集合改成可选；
- 改变错误 code 的业务含义；
- 改变 cursor 去重规则；
- 改变既有 event payload 的当前格式；
- 改变认证方式或 route 语义。

如果变化只新增一项独立能力，可以增加 feature 版本；如果影响所有连接的基本解码，就提升 protocol 版本。

## 代码和验证

| 内容 | 位置 |
|---|---|
| capabilities 解析与精确匹配 | `packages/protocol/src/capabilities.ts` |
| 请求 decoder 与 ProtocolError | `packages/protocol/src/requests.ts` |
| 领域记录 / snapshot 和通信组合 | `packages/domain-contracts/src/` / `packages/protocol/src/session.ts` |
| 通用 JSON / 插件数据 | `packages/json-data/src/json.ts` / `packages/plugin-contracts/src/` |
| HTTP 输入与响应转换 | `packages/server/src/http/mappers/` |
| 严格序列化检查 | `packages/protocol/src/serialization.ts` |
| HTTP client 与重连 | `packages/client/src/transport/http-client.ts`、`packages/client/src/state/sync.ts` |
| 共享 reducer | `packages/client/src/state/reducer.ts` |
| 服务端 capabilities | `packages/server/src/http/routes/system.ts` |
| HTTP 契约测试 | `tests/server-client/http.test.ts` |
