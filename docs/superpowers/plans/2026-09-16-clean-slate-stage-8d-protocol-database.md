# Clean-slate Stage 8D：协议与数据库硬切实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将 Client/Server 协议提升为精确版本握手，并把 21 份历史 migration 压缩为一份只服务空数据库的当前基线。

**架构：** Client transport 在首次业务 HTTP/SSE 请求前调用 `/capabilities` 并缓存成功结果，后续请求携带协议 header；Server 全局 middleware 在 handler 前做精确版本校验。数据库启动只对空库执行单一 Drizzle baseline，不识别或迁移旧库。

**技术栈：** TypeScript、Hono、Fetch/SSE、Drizzle ORM、better-sqlite3、Vitest

---

## 文件结构

- 修改：`packages/protocol/src/capabilities.ts` 与测试，提升协议版本并固定 header 常量。
- 修改：`packages/client/src/transport/http-transport.ts`、`sse-transport.ts` 与测试，实现共享握手状态。
- 创建：`packages/server/src/http/protocol-middleware.ts` 与测试。
- 修改：`packages/server/src/http/server.ts`、`routes/system.ts`，全局注册 middleware。
- 创建：`packages/services/src/session-runtime/migrations/0000_current_schema.sql`。
- 重建：`packages/services/src/session-runtime/migrations/meta/_journal.json`。
- 删除：原 `0000_session_runtime.sql` 至 `0020_session_goal_plugin.sql`。
- 修改：`packages/services/src/database/migrations.ts` 与数据库测试。
- 修改：`packages/core/src/config/settings.ts`、`packages/protocol/src/runtime-config.ts` 及测试，保持当前配置严格解析。

### 任务 1：定义协议硬切契约

- [ ] **步骤 1：写 protocol 单元测试**

把 `CURRENT_PROTOCOL_VERSION` 从 3 提升为 4；新增：

```ts
export const PROTOCOL_VERSION_HEADER = "x-vykor-protocol-version";
```

测试 `checkProtocolCompatibility` 对 3、5 返回 incompatible，对 4 返回 compatible。

- [ ] **步骤 2：实现并验证 protocol 包**

运行：`pnpm --filter @vykor/protocol test && pnpm --filter @vykor/protocol check-types`

预期：PASS。

### 任务 2：Client 首次请求强制握手

- [ ] **步骤 1：写 HTTP 并发握手测试**

两个并发业务请求只触发一次 `/capabilities`；握手成功后两次业务请求均携带 header `4`；`/health`、`/capabilities` 不触发递归握手；旧 server 返回协议 3 时，业务 endpoint 调用次数为 0。

- [ ] **步骤 2：写 SSE 握手测试**

打开 `/events/stream` 和 terminal stream 前完成同一共享握手；失败时不建立 SSE fetch。HTTP 与 SSE 必须共用 `HttpTransport` 上的单个 promise/cache。

- [ ] **步骤 3：实现握手状态**

`HttpTransport` 增加私有 `protocolHandshake?: Promise<ServerCapabilities>` 和：

```ts
ensureProtocol(signal?: AbortSignal): Promise<ServerCapabilities>;
isHandshakeExempt(pathname: string): boolean;
```

握手通过 raw fetch 请求 `/capabilities`，解析并精确比对版本；失败 promise 从 cache 清除以允许显式重试。所有业务 `request`/`requestResponse` 和 `SseTransport` 入口先 await 它，再加 header。

- [ ] **步骤 4：验证 Client**

运行：`pnpm --filter @vykor/client exec vitest run src/transport/__test__/http-client.test.ts src/transport/__test__/sse-transport.test.ts`

预期：PASS。

### 任务 3：Server 在 handler 前拒绝不匹配协议

- [ ] **步骤 1：写无副作用 middleware 测试**

为测试 route 设置 handler spy。缺失、3、5、非数字 header 均返回协议错误且 spy 为 0；header 4 返回 200 且 spy 为 1；`/health`、`/capabilities` 无 header 仍可访问。

- [ ] **步骤 2：实现全局 middleware**

middleware 在 auth/route handler 之前运行。错误响应使用统一 JSON：

```json
{
  "error": "protocol_version_mismatch",
  "expected": 4,
  "received": 3
}
```

缺失时 `received` 为 `null`；不做降级、重定向或 capability 模拟。

- [ ] **步骤 3：删除 route 层重复版本兼容分支**

保留请求 body 的当前 schema validation；只删除已被全局 middleware 取代的版本判断。

- [ ] **步骤 4：验证 Server**

运行：

```powershell
pnpm --filter @vykor/server exec vitest run src/http/protocol-middleware.test.ts src/http/routes/protocol-validation.test.ts src/http/__test__/http.test.ts
pnpm --filter @vykor/server check-types
```

预期：PASS。

### 任务 4：压缩数据库基线

- [ ] **步骤 1：冻结压缩前 schema inventory**

在测试中对现有 migrations 生成临时数据库，查询 `sqlite_master` 的 table/index/trigger SQL、`PRAGMA foreign_key_list(<table>)` 和关键 `PRAGMA table_info(<table>)`，规范化后写成测试内 expected inventory；忽略 Drizzle journal 自身时间戳。

- [ ] **步骤 2：生成当前单一 migration**

运行：`pnpm --filter @vykor/services db:generate`

把生成 SQL 命名为 `0000_current_schema.sql`，确认包含当前所有表、索引、外键和 `application_storage_format` 当前 generation。重建 `_journal.json` 为单条 `idx: 0` 记录。

- [ ] **步骤 3：删除历史 migration 和旧库识别**

删除 21 个旧 SQL。`applySessionMigrations` 只在 `sqlite_master` 无业务表时运行；删除 `assertCurrentStorageFormatOrEmpty`、`assertCurrentStorageFormat` 和“移动或删除旧库”的兼容错误分支。非空库不属于支持路径，测试不得把旧库传给新启动代码。

- [ ] **步骤 4：验证结构等价和幂等**

第一次打开空库后 inventory 与冻结结构一致；关闭后二次打开表/index/foreign key 不变；当前 `schema.ts` 与 migration 经 `db:check` 一致。

- [ ] **步骤 5：验证打包路径包含基线**

运行 CLI build 和 Desktop build 后，在产物中定位 `0000_current_schema.sql` 与 `_journal.json`，断言不包含 `0001_` 至 `0020_`。

- [ ] **步骤 6：执行数据库与协议阶段验证**

运行：

```powershell
pnpm --filter @vykor/services db:check
pnpm --filter @vykor/services test
pnpm --filter @vykor/client test
pnpm --filter @vykor/server test
pnpm --filter @vykor/cli build
pnpm --filter @vykor/desktop build
pnpm check-types
```

预期：全部 PASS。

### 任务 5：锁定当前配置和 HTTP 路由

- [ ] **步骤 1：为审计清单中的旧配置写负向测试**

在 `packages/core/src/config/settings.test.ts` 和 `packages/protocol/src/runtime-config.test.ts` 中逐项传入 forbidden 清单的 `configFields`、`enumValues` 与旧嵌套结构。断言解析在 daemon、数据库或子进程启动前抛出 `SettingsFileError` 或当前 `ProtocolDataError`；不得静默删除字段、改名或补默认值。

- [ ] **步骤 2：删除旧配置转换分支**

删除审计中判定为兼容的 rename/coerce/alias 分支。保留当前字段缺失时的当前默认值，也保留 CLI `config set` 对当前字段的字符串转型；这些不是读取旧 schema。

- [ ] **步骤 3：为旧 HTTP 路由写 404 测试**

对 forbidden 清单 `httpRoutes` 的每个 method/path 发请求，断言标准 404，且 route handler、数据库写入和进程启动 spy 都为 0。当前 route 的非法 body 应继续返回其当前 4xx validation response，不与“路由不存在”混淆。

- [ ] **步骤 4：验证配置和 routes**

运行：

```powershell
pnpm --filter @vykor/core exec vitest run src/config/settings.test.ts
pnpm --filter @vykor/protocol exec vitest run src/runtime-config.test.ts
pnpm --filter @vykor/server exec vitest run src/http/routes/__test__/routes.test.ts src/http/routes/protocol-validation.test.ts
```

预期：全部 PASS；旧路由均为 404，旧配置均在副作用前失败。

- [ ] **步骤 5：执行 8D 完整验证并提交**

```powershell
pnpm --filter @vykor/core test
pnpm --filter @vykor/protocol test
pnpm --filter @vykor/client test
pnpm --filter @vykor/server test
pnpm --filter @vykor/services test
pnpm check-types
git diff --check
git add packages/core packages/protocol packages/client packages/server packages/services apps/cli apps/desktop scripts/forbidden-compatibility-surfaces.json
git commit -m "refactor: hard cut protocol and database baseline"
```
