# 数据库 schema 自动迁移设计

> 状态：设计稿（v3，已过两轮文档审核）。实现计划见 `../plans/2026-09-20-database-schema-auto-migration.md`（待写）。

## 1. 背景与问题

### 1.1 触发问题

接入飞书后，在飞书里给机器人发消息完全没有回复，而渠道配置（appId / appSecret / enabled / allowFrom）都正确。

### 1.2 根因（已取证）

入站链路全程正常，断点在「写待发回复」：

- 本机库 `external_conversation` 有记录、对应 `session_run.status = completed`，但 `channel_delivery` 行数为 0。
- `channel_delivery` 缺列 `platform_meta_json`；`ChannelRepository.createDelivery`
  （`packages/services/src/channels/channel-repository.ts:112-153`，INSERT 在 128-151）的 SQL 明确包含该列 → 直接抛错。
- 该错误在 `DurableChannelBridge.run()` 被 catch 成一条 warning
  （`packages/channels/src/core/durable-bridge.ts:91-97`，`handle(message)` 在 try 内），所以外部表现为「静默无回复」。

### 1.3 为什么会缺列

- 迁移入口 `applySessionMigrations`（`packages/services/src/database/migrations.ts:9-13`）只要有表就 `return`，
  `drizzle.migrate()` 永不执行；drizzle 只被用来「建空库」。
- 迁移链在 clean-slate 阶段被压成单一基线 `0000_current_schema.sql`（纯 CREATE，无 ALTER）。
- 提交 `1c39a07f` 重新基线化并新增 `platform_meta_json`，但对已存在的库没有任何升级路径。
- 库中 `application_storage_format.version = 2`（代码期望 3），但没有任何运行时代码读这个标记，
  文档声称的「版本不符则启动失败」并未实现 → 旧库被静默使用。

### 1.4 影响

任何在 2026-09-18 重新基线化之前创建、且未删库重建的数据库，都会以旧 schema 运行；
凡触碰新列的代码路径都会在运行时静默失败。飞书回复只是第一个命中者。

## 2. 目标与非目标

### 2.1 目标

- schema 发生变更时，启动自动迁移到最新，无需删库。
- 对「基线前创建、但表结构仍属当前基线世代」的旧库做一次性接管对账，补齐到基线，再走正常增量迁移。
  （更老的 clean-slate 之前世代若缺整表，不在接管范围，见 §5 / §8。）
- 建立可长期使用的增量迁移链（`drizzle-kit generate` 产出 `0001+`）。
- 移除已失去意义的 `application_storage_format` 标记，迁移状态完全交给 drizzle 的 `__drizzle_migrations`。
- 接管时清理基线中已不存在的废弃表（如 `cron_job` / `cron_run`）。

### 2.2 非目标

- 不做读取时猜测 / 字段别名 / 降级式兼容。
- 不自动处理不可加性变更（改名、改类型、数据变换）；这类必须由显式迁移文件承担。
- 不恢复 clean-slate 已删除的旧业务数据语义（只补 schema 结构）。
- **不比对 / 不重建 FK 与 CHECK 约束**：SQLite 无法 `ALTER ADD CONSTRAINT`，只能重建表；
  基线表的 FK / CHECK 由原 drizzle 链创建、通常一致，变更它们必须走显式迁移（见 §8）。
- 不处理 view / trigger（基线不含）。

### 2.3 与既有设计的关系

`2026-09-18-channel-durable-delivery-platform-context-design.md:47` 曾把
「通用增量数据库迁移机制」列为非目标，沿用 clean-slate 基线约定。
本设计**取代**该非目标：`0000` 继续作为新库起点，但在此之上新增自动迁移与旧库接管。

## 3. 现状机制（as-is）

- 唯一入口：`SessionStore` → `SessionDatabase.open`（`session-database.ts:21-36`）→ `applySessionMigrations`。
- drizzle SQLite 迁移器是**水位线模型**（`drizzle-orm/sqlite-core/dialect.js:653-670`）：
  取 `__drizzle_migrations` 最大 `created_at`，凡 `journal.when` 更大者执行，**不比对 hash**。
- `readMigrationFiles`（`drizzle-orm/migrator`）返回 `{ sql, bps, folderMillis, hash }[]`；
  `hash = sha256(文件全文)`，`folderMillis = journalEntry.when`。
- 迁移目录：`packages/services/src/session-runtime/migrations/`
  （`0000_current_schema.sql` + `meta/0000_snapshot.json` + `meta/_journal.json`）。
- 打包：`apps/cli/build.ts:102`、`apps/desktop/electron.vite.config.ts` 都是整目录 `cpSync`。

### 3.1 强制「单基线」的门禁（全部需改）

- `scripts/verify-clean-slate.mjs`（**生产脚本本身**）：
  `:158` 断言恰好 1 个 sql 且为 `0000_current_schema.sql`；
  `:166` journal 恰好 1 条且 tag 固定；
  `:235` / `:239` 打包目录「must contain one baseline / one journal entry」。
- `scripts/verify-clean-slate.test.mjs`：构造 `0001_old.sql` 并断言被标记。
- `packages/services/scripts/check-bundled-baseline.ts`：
  `:28-33` 断言 1 个 sql、逐字节比对 `0000`、journal 1 条；
  `:40-46` 双次打开断言 `__drizzle_migrations` 1 行、表数 32、version 3。
- `packages/services/src/database/session-database.test.ts`：
  `inventory()`（`:24`）读 `application_storage_format`；`:66-80` 单基线断言。
- `packages/services/src/session-runtime/__test__/store.test.ts:141-149`：断言 `version = 3`。
- `apps/desktop/scripts/verify-migration-artifact.mjs:7-11`：硬编码 3 个路径。
- `apps/desktop/scripts/verify-migration-artifact.test.mjs:9-13,28-34`：
  硬编码 3 个路径 + 断言 `0001_legacy.sql` 被拒。

## 4. 目标机制（to-be）

```text
SessionDatabase.open
  -> applySessionMigrations（替换现有「非空即返回」）
       1. folder = resolveMigrationsFolder()
       2. migrations = readMigrationFiles(folder)；baseline = migrations[0]
       3. adoptLegacyDatabase(db, { baseline, folder })
            条件：库非空 且（__drizzle_migrations 不存在 或 不含 baseline.hash）
            动作：按 0000_snapshot.json 对账 → 只写入 baseline 一行
       4. migrate()：无条件执行 → 应用 0001+ 并写入其行
```

- 每次打开都 `migrate()`。
- `resolveMigrationsFolder()` 保留现有回退：源码/Desktop 用 `../session-runtime/migrations`，
  CLI 打包后回退到 `./migrations`。
- 接管幂等：baseline.hash 已在表中即跳过。
- **对账目标是基线快照 `0000_snapshot.json`**（不是最新快照），从而让 `migrate()` 正常执行 `0001+`，
  不跳过未来迁移的数据 / DDL 逻辑。
- 接管时**先清空 `__drizzle_migrations` 中旧链遗留的所有行**，再写入 baseline 一行；
  之后 `migrate()` 写入 `0001+` 各行。因此采用后 `__drizzle_migrations` 行数 == 迁移数。
  （真实旧库已有旧基线行，若不清空会残留为第 3 行；drizzle 虽只用 `MAX(created_at)` 容忍，
  但会破坏本不变量与测试断言。）

## 5. 旧库接管算法（基于 `meta/0000_snapshot.json`）

**快照结构**

- `snapshot.tables[name] = { name, columns, indexes, foreignKeys, compositePrimaryKeys, uniqueConstraints, checkConstraints }`
- `columns[key] = { name, type, primaryKey, notNull, autoincrement, default? }`
- `indexes[key] = { name, columns: string[], isUnique, where? }`

**类型 / 默认值映射（确定性）**

- `type`：直接使用快照的小写值（`text` / `integer` / `numeric` / `blob`）。
- `default`：原样内联为 `DEFAULT <expr>`。快照里字符串是 SQL 字面量（如 `"''"`），数字直接是数字（如 `0` / `1`）。

**对每张快照表**

- 缺列 → `ALTER TABLE ADD COLUMN "name" <type> [DEFAULT <expr>]`。
  - `notNull && default === undefined` 且表非空 → `LegacyAdoptionError`（空表可加，SQLite 允许）。
  - 该列是 `primaryKey` → `LegacyAdoptionError`（SQLite 不允许 ADD COLUMN 加 PK）。
    unique 不在此报错：由随后「缺索引 → `CREATE UNIQUE INDEX`」补齐。
- 缺索引 → `CREATE [UNIQUE] INDEX IF NOT EXISTS "name" ON "table" ("c1",...)`，
  **`where` 存在时追加 `WHERE <where>`**（保留部分唯一索引谓词，否则会误建为全表唯一）。
- 索引同名但定义（columns / isUnique / where）与快照不一致 → `LegacyAdoptionError`。
- 列已存在但归一化后的 `type` / `notNull` 不一致 → `LegacyAdoptionError`
  （比较前把 type 转小写、notNull 转布尔）。
- 缺整表 → `LegacyAdoptionError` 点名（基线前旧库不应缺整表；显式失败优于猜测）。

**多余表**（库里有、快照无，排除 `__drizzle_migrations` 与 `sqlite_%`）→ `DROP TABLE`。

- 事务外先 `PRAGMA foreign_keys = OFF`，事务结束后恢复原值
  （`defer_foreign_keys` 无法覆盖「先删父表」场景，故用 OFF）。

**收尾**

- 确保 `__drizzle_migrations` 存在（DDL 与 drizzle 一致：`id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric`）。
- **先 `DELETE FROM __drizzle_migrations`**（清掉旧链遗留行，真实旧库有 20 行），
  再插入**仅 baseline 一行**：`hash = sha256(0000_current_schema.sql 全文)`、`created_at = journal[0].when`。
- 单事务；失败回滚并抛错；恢复 `foreign_keys`。
- 前提假设：接管只用于「基线世代」旧库；不存在「已应用部分新链但缺 baseline」的状态。

## 6. 移除 `application_storage_format`

- `packages/services/src/session-runtime/schema.ts:597-600` 删除该表定义。
- **不改 `0000`**（已应用的基线不动）；
  `pnpm --filter @openharness/services db:generate` 生成 `0001_*.sql`（`DROP TABLE application_storage_format`）
  + `meta/0001_snapshot.json` + 更新 `_journal.json`。
- 运行时无任何代码读该表（已全仓确认）。
- 新库：`0000` 建表后由 `0001` 删除；旧库：接管到 `0000` 后由 `0001` 删除。
- **接管不删它**：它存在于基线快照 `0000_snapshot.json` 中，不属 §5 的「多余表」；
  若接管误删，`0001` 的 `DROP TABLE application_storage_format`（无 `IF EXISTS`）会失败并回滚启动。

## 7. 影响面

**核心**

- `packages/services/src/database/migrations.ts`：替换入口（**不替换则接管算法不可达**）。
- 新增 `packages/services/src/database/legacy-adoption.ts`：快照对账 + `LegacyAdoptionError`。
- `packages/services/src/session-runtime/schema.ts`：删 `applicationStorageFormat`。
- 新增 `0001_*.sql` / `meta/0001_snapshot.json`，更新 `meta/_journal.json`。

**门禁 / 测试 / 夹具**

- `scripts/verify-clean-slate.mjs`：`:158` / `:166` / `:235` / `:239`
  从「恰好 1 个」改为「baseline 存在 + journal 与 `.sql` 文件一一对应」。
- `scripts/verify-clean-slate.test.mjs`：`0001_old.sql` 不再算问题；改为断言「journal 与文件不匹配」才算问题。
- `packages/services/scripts/check-bundled-baseline.ts`：
  `:28-33` 改为「文件集含 `0000` + `0001`，每个 `.sql` 逐字节比对源目录，journal 长度 == 文件数」；
  `:40-46` 双次打开断言 `__drizzle_migrations` 行数 == 迁移数（新库 = 2）、表数 31，去掉 version 断言。
- `packages/services/src/database/session-database.test.ts`：`inventory()` 去掉 `format` 字段；
  单基线断言改为「文件数 == journal 数」；新增旧库接管用例。
- `packages/services/src/session-runtime/__test__/store.test.ts:141-149`：删除 version 断言，
  改为断言 `application_storage_format` 不存在。
- `packages/services/src/database/__fixtures__/current-schema-inventory.json`：
  按既有临时 dump test 方法重新生成（形状同 `inventory()` 但去掉 `format`）。
- `apps/desktop/scripts/verify-migration-artifact.mjs`：新增可选 `expectedPaths` 参数，默认保留现常量；
  **`verifyPlatformInventories(values, expectedPaths)` 显式透传**
  （现为 `values.map(validateMigrationInventory)`，会把数组下标当第二参）；
  **`writePackagedMigrationInventory`（`:86`）也要接收并透传 `expectedPaths`**，
  否则 `--write-inventory` 会用默认 3 路径常量去校验 2 迁移包；
  `main()` 的 `--verify-inventories` 与 `--write-inventory` 都从源目录
  `resolve(desktopRoot, "../../packages/services/src/session-runtime/migrations")`
  walk `*.sql` + `meta/*.json` 推导并排序。
- `apps/desktop/scripts/verify-migration-artifact.test.mjs`：更新多迁移场景；
  「extra / legacy 被拒」改为「与源目录不一致被拒」。

**文档**

- `docs/session-runtime-storage-architecture.md`：`:109-119` 与 `:162`。
- `docs/architecture-migration-status.md`：`:59`、`:60`、`:72`、`:82`。
- `docs/operations-and-recovery.md`：`:10`、`:16`、`:120`，以及直接陈述旧策略的 `:124-133`。
- `docs/durable-execution-data-model.md`：`:91-95`，以及 `:104`（「migrations 只建新库、不承担旧库升级」）。
- `docs/architecture-overview.md:148`（「从旧数据库猜测当前格式」→ 说明接管是快照驱动、非猜测）。
- `docs/development-data-reset.md:156`。
- `docs/channels-flow.md:204`。
- `packages/services/README.md:18`（「只有 `0000` / 一条 journal / 不自动转换旧库」）。
- `apps/desktop/docs/packaging.md:17`（发布清单「只有 `0000` + 当前 snapshot + 单条 journal」）。

**打包 / 发布**：拷贝逻辑不变；`tag-release.yml` 的 `verify-migration-artifact` 因动态化继续可用。

## 8. 边界与风险

- 接管只处理**可加性**变更；改名 / 改类型 / 数据变换必须写显式迁移文件。
- 缺整表、缺 PK 列、列 / 索引定义冲突 → 显式 `LegacyAdoptionError`（不静默）。
- FK / CHECK 不接管（见 §2.2）；变更它们须显式迁移。
- 多余索引不删（无害）；多余表删除。
- 反转 clean-slate 策略：需同步 **7 处门禁 / 测试 + 8 份文档**；遗漏任一会导致 CI 失败。
- drizzle 水位线只增不减：接管补写 baseline 行后，`0001+` 才会执行；顺序错误会重跑基线撞表。

## 9. 验收标准

- 新库：打开后应用全部迁移；`application_storage_format` 不存在；表数 31；
  `__drizzle_migrations` == 2 行；schema 与夹具一致。
- 旧库（模拟真实旧库：缺 `platform_meta_json`、含废弃表、`__drizzle_migrations` 有旧链遗留行且无 baseline hash）：
  打开后列补齐、废弃表删除、旧遗留行被清、baseline 打标、`0001` 生效；
  最终 `__drizzle_migrations` == 2 行；再次打开幂等。
- 现网库（本机）：启动后 `channel_delivery.platform_meta_json` 存在、
  `cron_job` / `cron_run` 与 `application_storage_format` 被删、`__drizzle_migrations` 含 baseline 行；
  飞书发消息得到回复。
- 门禁：`pnpm --filter @openharness/services test`、`check-types`、`test:bundled-baseline`、
  `pnpm check:clean-slate`、`pnpm test:clean-slate` 全绿。

## 10. 测试计划

- `legacy-adoption.test.ts`：补列 / 建索引（含 partial `where`）/ 删表 / 打标 / 幂等；
  `notNull 无默认`、缺整表、缺 PK 列、索引定义冲突 → 抛 `LegacyAdoptionError`。
- `session-database.test.ts`：新库全量迁移 + 二次打开不重复执行。
- `verify-clean-slate.test.mjs` / `verify-migration-artifact.test.mjs`：多迁移与不匹配场景。
- 手工 E2E：用本机旧库启动，发飞书消息验证回复。

## 11. 修订记录（两轮审核 → 处理）

| 审核问题 | 处理 |
|---|---|
| 路径写成 `src/channel-repository.ts` | 改为 `src/channels/channel-repository.ts`（§1.2） |
| 索引形状漏 `where`（部分唯一索引） | §5 保留 `WHERE`，并加「同名不同定义 → 报错」 |
| 漏 `store.test.ts:141-149` | 加入 §3.1 / §7 |
| 漏 `verify-migration-artifact.test.mjs` | 加入 §3.1 / §7 |
| 漏 `session-runtime-storage-architecture.md` | 加入 §7（含 `:162`） |
| `verify-migration-artifact` 动态化空洞 + `map` 传参 bug | §7 指定源目录来源 + 显式透传 `expectedPaths` |
| `verify-clean-slate.mjs` 生产脚本未列 | §3.1 / §7 明确 `:158/:166/:235/:239` |
| `check-bundled-baseline` 双开行数 | §7 行数 == 迁移数（新库 = 2） |
| warning 归属 | §1.2 改为 `run()` |
| `__drizzle_migrations` 播种不明 | §5 只补 baseline 一行，hash / created_at 明确定义 |
| 用哪个快照 | §4 基线快照 `0000_snapshot.json` |
| FK / CHECK、索引漂移、view / trigger | §2.2 / §5 / §8 明确范围 |
| `defer_foreign_keys` 不足 | §5 改用事务外 `foreign_keys = OFF` |
| 漏 `packages/services/README.md` / `packaging.md` | 加入 §7 |
| `tables 31` 依赖删表 | §6 明确删 `application_storage_format` |

### 11.1 最终复核 → 处理（v3）

| 审核问题 | 处理 |
|---|---|
| 真实旧库已有旧基线行，接管后行数 != 迁移数 | §4 / §5：接管先 `DELETE FROM __drizzle_migrations` 再写 baseline；§9 模拟真实旧库 |
| §6「多余表双保险」与 §5 矛盾（误删会让 0001 失败） | §6 删除该句，明确接管不删 `application_storage_format` |
| 文档引用行未覆盖最强策略陈述 | §7 补 `operations-and-recovery.md:124-133`、`durable-execution-data-model.md:104`、`architecture-migration-status.md:60`、`architecture-overview.md:148` |
| `writePackagedMigrationInventory` 未透传 `expectedPaths` | §7 补充 |
| §2.1「补齐到当前基线」范围过大 | §2.1 收窄为「基线世代旧库」，缺整表走 §5 报错 |
