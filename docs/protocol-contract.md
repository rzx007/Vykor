# Protocol Contract

> 状态：当前客户端与 daemon 协议的权威契约。最后核对：2026-09-26。

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
| Session snapshot/event 类型 | `packages/protocol/src/session.ts` |
| 严格序列化检查 | `packages/protocol/src/serialization.ts` |
| HTTP client 与重连 | `packages/client/src/transport/http-client.ts`、`packages/client/src/state/sync.ts` |
| 共享 reducer | `packages/client/src/state/reducer.ts` |
| 服务端 capabilities | `packages/server/src/http/routes/system.ts` |
| HTTP 契约测试 | `packages/server/src/http/__test__/http.test.ts` |
