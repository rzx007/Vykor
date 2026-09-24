# Clean-slate Stage 8A：Client 与兼容治理清理实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 原子删除 `VykorClient` 的 118 个顶层转发方法和 A/B/C 兼容发行系统，同时建立只防止旧入口复活的负向清单。

**架构：** 当前领域 Resource 是唯一 Client 入口。旧方法名称从 removal ledger 提取到无发行语义的 forbidden-surface 清单；公共 API contract 只描述当前导出，架构检查对旧名执行绝对零容忍。

**技术栈：** TypeScript、Node.js AST、Vitest、Node test runner、GitHub Actions

---

## 文件结构

- 创建：`docs/compatibility-surface-audit.md`——逐项记录定义、调用者、当前替代入口和删除/保留理由的实施审计。
- 创建：`scripts/forbidden-compatibility-surfaces.json`——测试专用旧名清单，包含 Client 方法、类型、路由、CLI、配置和 schema 分类。
- 创建：`scripts/forbidden-compatibility-surfaces.schema.json`——清单 JSON Schema。
- 创建：`scripts/forbidden-compatibility-surfaces.mjs`——读取、校验并扫描生产代码和当前文档。
- 创建：`scripts/forbidden-compatibility-surfaces.test.mjs`——清单完整性、允许目录与复活检测测试。
- 创建：`scripts/release-safety.mjs`、`scripts/release-safety.test.mjs`——从旧 release helper 保留通用发布安全检查。
- 修改：`packages/client/src/transport/http-client.ts`——只保留构造、Resource 属性以及经审计仍有职责的 transport 入口。
- 修改：`packages/client/src/__test__/public-api.test.ts`、`tests/client-public-api/consumer.ts`——断言当前 API，并用 `@ts-expect-error` 证明旧方法不存在。
- 修改：`scripts/client-public-api-contract.json`、`scripts/client-public-api-contract.schema.json`——删除 compatibility 与发行元数据。
- 修改：`scripts/architecture-boundaries.mjs`、`scripts/architecture-boundaries.test.mjs`、`scripts/architecture-baseline.json`——由递减基线改为绝对禁止。
- 修改：`package.json`、`.github/workflows/tag-release.yml`——接入新门禁和通用 release safety。
- 删除：`scripts/client-compat-*`、`scripts/client-legacy-calls*`、`scripts/client-compat-removal-ledger*`、`docs/client-public-api-migration.md`。

### 任务 1：冻结永久 forbidden surface

- [ ] **步骤 1：从现有 ledger 机械生成第一版 Client 旧名数组**

运行：

```powershell
node -e "const fs=require('node:fs');const x=require('./scripts/client-compat-removal-ledger.json');console.log(JSON.stringify(x.baseline.methods.map(v=>v.name).sort(),null,2))"
```

预期：输出 118 个唯一方法名；在编辑前保存输出用于逐项复制，不保留 commit、release evidence 或 replacement。

- [ ] **步骤 2：完成全仓语义审计并填满其他分类**

运行以下扫描，并把每个命中写入 `docs/compatibility-surface-audit.md`，列为 `符号/字符串 | 定义文件 | 生产调用者 | 当前替代入口 | 删除或保留 | 理由`：

```powershell
rg -n -i '(deprecated|legacy|compatibility|migration|fallback|alias|redirect)' packages apps scripts .github package.json docs/*.md
rg -n '\.(getSession|createSession|listSessions|archiveSession|createRun|createGoal|replyPermission)\b' packages apps --glob '!**/*.test.ts'
rg -n '(\.get\(|\.post\(|\.put\(|\.patch\(|\.delete\()' packages/server/src/http/routes
rg -n '\.option\(|\.command\(' apps/cli/src
```

保留项必须落入设计矩阵的外部互操作、平台适配或可靠性类别；删除项必须进入 forbidden 清单相应数组。`packages/api/src/models/api.json` 中第三方 Provider 的 deprecated model/compatibility 文案整体标为“外部目录数据，保留”，不得逐项加入 forbidden 清单。审计结束时，每个扫描命中都有一行结论，且所有删除项都能在后续某个任务找到处理步骤。

- [ ] **步骤 3：先写扫描器失败测试**

在 `scripts/forbidden-compatibility-surfaces.test.mjs` 创建临时目录，写入 `src/demo.ts`：

```js
await client.getSession("s1");
```

断言 `scanForbiddenSurfaces()` 返回一条 `client-method/getSession`；再写入允许文件 `scripts/forbidden-compatibility-surfaces.json`，断言不扫描清单自身。

- [ ] **步骤 4：运行测试确认扫描器尚不存在**

运行：`node --test scripts/forbidden-compatibility-surfaces.test.mjs`

预期：FAIL，模块 `forbidden-compatibility-surfaces.mjs` 不存在。

- [ ] **步骤 5：实现清单和扫描器**

清单固定使用以下顶层结构：

```json
{
  "$schema": "./forbidden-compatibility-surfaces.schema.json",
  "version": 1,
  "clientMethods": ["addMemory", "admitPrompt"],
  "runtimeExports": [],
  "httpRoutes": [],
  "cliCommands": [],
  "cliOptions": ["--bare"],
  "environmentVariables": [],
  "configFields": [],
  "enumValues": [],
  "schemaNames": []
}
```

各分类填入步骤 2 审计确认的真实旧名；没有删除项时使用空数组。`clientMethods` 必须复制完整 118 项。扫描器导出 `readForbiddenSurfaces(path)` 和 `scanForbiddenSurfaces({ cwd, allow })`；默认允许清单文件、扫描器测试 fixture 和历史 `docs/superpowers/{plans,specs}`，其余 `packages/`、`apps/`、`scripts/`、`tests/`、当前 `docs/*.md` 都扫描。

- [ ] **步骤 6：验证 118 项和 fixture 行为**

运行：`node --test scripts/forbidden-compatibility-surfaces.test.mjs`

预期：PASS；测试明确断言 `new Set(clientMethods).size === 118`。

- [ ] **步骤 7：提交清单骨架**

```powershell
git add docs/compatibility-surface-audit.md scripts/forbidden-compatibility-surfaces.json scripts/forbidden-compatibility-surfaces.schema.json scripts/forbidden-compatibility-surfaces.mjs scripts/forbidden-compatibility-surfaces.test.mjs
git commit -m "test: freeze removed compatibility surfaces"
```

### 任务 2：原子删除 Client facade 与旧 contract 语义

- [ ] **步骤 1：把当前 Resource 正向表面写入测试**

在 `packages/client/src/__test__/public-api.test.ts` 断言 `VykorClient` 实例只直接暴露：

```ts
[
  "attachments", "auth", "channels", "development", "events", "jobs",
  "permissions", "plugins", "projects", "protocol", "providers", "schedules",
  "sessions", "system", "terminals",
]
```

`transport`、`sse`、`baseUrl`、`token`、`fetchImpl` 逐个通过 `rg` 审核；若只被旧 facade 或测试使用，同批删除并加入 `runtimeExports`，若 Resource/SSE 当前仍需要则改为 `private` 或保留最窄只读入口。

- [ ] **步骤 2：增加编译期负向 fixture**

在 `tests/client-public-api/consumer.ts` 对清单中的每个方法生成显式检查，例如：

```ts
// @ts-expect-error removed flat compatibility API
client.getSession("session-1");
await client.sessions.get("session-1");
```

118 个旧名都必须出现一次；每个 replacement 至少由 contract 的当前 Resource 测试覆盖。

- [ ] **步骤 3：运行测试确认旧方法仍导致负向断言失败**

运行：`pnpm exec tsc -p tests/client-public-api/tsconfig.json`

预期：FAIL，至少出现 “Unused '@ts-expect-error' directive”。

- [ ] **步骤 4：删除 `http-client.ts` 的 118 个转发方法与无用 imports**

保留构造函数和当前 Resource 初始化；不得把方法搬到另一个 facade。删除后运行：

```powershell
rg -n '@deprecated Use client\.' packages/client/src/transport/http-client.ts
```

预期：无输出。

- [ ] **步骤 5：简化公共 contract**

把 contract entry 收敛为 `{ name, kind }`，schema 只允许当前 `runtime-export`、`type-export` 和 `client-resource`。删除 `classification`、`replacement`、`deprecatedSince`、`deprecatedCarrierRelease`、`retentionCarrierRelease`、`removeIn`、`carrier` 与 compatibility summary。

- [ ] **步骤 6：验证 Client 原子批次**

运行：

```powershell
pnpm --filter @vykor/client check-types
pnpm --filter @vykor/client test
pnpm exec tsc -p tests/client-public-api/tsconfig.json
node scripts/forbidden-compatibility-surfaces.mjs
```

预期：全部 PASS，生产代码中的 118 个方法引用为 0。

### 任务 3：删除兼容发行系统并保留通用发布安全

- [ ] **步骤 1：为通用 release safety 写失败测试**

`scripts/release-safety.test.mjs` 必须覆盖：固定完整 SHA、同名 tag 指向不同 commit 时失败、构建未完成前不得创建 tag、npm 已存在同版本时幂等跳过、`npm view` 校验失败时不得创建 GitHub Release、Release 重跑更新 notes/artifacts。

- [ ] **步骤 2：运行测试确认新 helper 尚不存在**

运行：`node --test scripts/release-safety.test.mjs`

预期：FAIL，找不到 `release-safety.mjs`。

- [ ] **步骤 3：从旧 helper 提取通用逻辑**

`release-safety.mjs` 只导出：

```js
export function assertReleaseCommit({ requestedSha, checkedOutSha }) {}
export function assertTagAvailable({ tag, targetSha, existingSha }) {}
export function decideNpmPublish({ expectedVersion, publishedVersion }) {}
export function assertArtifacts(expectedNames, actualNames) {}
export function renderStableReleaseNotes({ version, commit, artifacts }) {}
```

函数不得读取 compatibility phase、ledger、A/B/C evidence 或 breaking authorization。

- [ ] **步骤 4：改造 `tag-release.yml`**

删除 `phase` 输入、`validate-phase`、removal gate、compat notes/evidence。保留顺序：checkout 固定 SHA → preflight → tests → Windows/Linux Desktop build → artifact 校验 → tag → npm 发布/在线校验 → GitHub Release → notes/artifact 回读验证 → 失败通知。

- [ ] **步骤 5：删除旧治理文件和根脚本引用**

删除所有 `scripts/client-compat-*`、`scripts/client-legacy-calls*` 和 ledger/schema；`package.json` 攓为：

```json
{
  "check:client-api": "tsc -p tests/client-public-api/tsconfig.json && node --test scripts/forbidden-compatibility-surfaces.test.mjs scripts/architecture-boundaries.test.mjs && pnpm --filter @vykor/client exec vitest run src/__test__/public-api.test.ts",
  "check:architecture": "pnpm check:client-api && node scripts/architecture-boundaries.mjs",
  "test:scripts": "node --test scripts/prepare-tag-release.test.mjs scripts/npm-release.test.mjs scripts/release-safety.test.mjs scripts/forbidden-compatibility-surfaces.test.mjs"
}
```

保留 `release:cli` 与 `release:cli:dry`。

- [ ] **步骤 6：更新架构门禁与删除迁移文档**

`architecture-boundaries.mjs` 直接合并 `scanForbiddenSurfaces()` 错误，移除历史数量比较；`architecture-baseline.json` 删除所有 `clientLegacy*` 字段。删除 `docs/client-public-api-migration.md`，并把旧 Stage 8 总计划标注为“被 clean-slate 设计取代”。

- [ ] **步骤 7：验证并提交 8A**

运行：

```powershell
pnpm check:client-api
pnpm check:architecture
pnpm test:scripts
pnpm check-types
git diff --check
```

预期：全部 PASS。

```powershell
git add packages/client tests/client-public-api scripts package.json .github/workflows/tag-release.yml docs
git commit -m "refactor: remove client compatibility facade"
```
