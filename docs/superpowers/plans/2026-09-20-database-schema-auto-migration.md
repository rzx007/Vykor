# 数据库 schema 自动迁移 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 daemon SQLite 在启动时自动应用增量迁移，并对基线前旧库做一次性快照对账接管，使飞书回复不再因 schema 落后而静默失败。

**Architecture:** 在 `SessionDatabase.open` 的迁移入口里，先按基线快照 `0000_snapshot.json` 对账旧库（补列 / 建索引 / 删废弃表 / 重置 `__drizzle_migrations`），再无条件下调用 `drizzle.migrate()` 应用 `0001+`。删除 `application_storage_format`，迁移状态完全交给 `__drizzle_migrations`。

**Tech Stack:** TypeScript、better-sqlite3 13、drizzle-orm 0.45 / drizzle-kit 0.31、vitest、Node 24。

## Global Constraints

- 设计依据：`docs/superpowers/specs/2026-09-20-database-schema-auto-migration-design.md`（v3）。
- 迁移器是**水位线模型**：只看 `__drizzle_migrations` 最大 `created_at`，`journal.when` 更大者执行，不比对 hash。
- 对账目标是**基线快照** `meta/0000_snapshot.json`，不是最新快照；`0001+` 交给 `migrate()`。
- 接管只处理可加性变更；缺整表、缺 PK 列、列/索引定义冲突 → 抛 `LegacyAdoptionError`，不静默。
- 接管时 `PRAGMA foreign_keys = OFF` 必须在事务外；收尾恢复原值。
- `application_storage_format` 由新增的 `0001` 删除；**接管不删它**（它在基线快照内）。
- 所有命令在仓库根 `D:\code\personal-project\OpenHarness-ts` 运行；包内命令用 `pnpm --filter @openharness/services`。
- 每个任务结束必须提交；提交信息用仓库既有风格（`feat(services):` / `fix(services):` / `chore(services):`）。

---

## File Structure

**核心**
- Create: `packages/services/src/database/legacy-adoption.ts` — 快照对账实现 + `LegacyAdoptionError`。
- Create: `packages/services/src/database/legacy-adoption.test.ts` — 对账单测 + 真实基线集成测试。
- Modify: `packages/services/src/database/migrations.ts` — 入口改为「接管 + 始终 migrate」。
- Modify: `packages/services/src/session-runtime/schema.ts` — 删 `applicationStorageFormat`。
- Create: `packages/services/src/session-runtime/migrations/0001_drop_application_storage_format.sql`（由 `db:generate` 生成后改名）。
- Create: `packages/services/src/session-runtime/migrations/meta/0001_snapshot.json`（`db:generate` 生成）。
- Modify: `packages/services/src/session-runtime/migrations/meta/_journal.json`（新增第 2 条）。

**门禁 / 测试 / 夹具**
- Modify: `packages/services/src/database/session-database.test.ts`
- Modify: `packages/services/src/database/__fixtures__/current-schema-inventory.json`（重新生成）
- Modify: `packages/services/src/session-runtime/__test__/store.test.ts`
- Modify: `packages/services/scripts/check-bundled-baseline.ts`
- Modify: `scripts/verify-clean-slate.mjs`
- Modify: `apps/desktop/scripts/verify-migration-artifact.mjs`
- Modify: `apps/desktop/scripts/verify-migration-artifact.test.mjs`

**文档**
- Modify: `packages/services/README.md`、`apps/desktop/docs/packaging.md`、`docs/session-runtime-storage-architecture.md`、
  `docs/architecture-migration-status.md`、`docs/operations-and-recovery.md`、`docs/durable-execution-data-model.md`、
  `docs/development-data-reset.md`、`docs/channels-flow.md`、`docs/architecture-overview.md`、`docs/release-process.md`。

---

### Task 1: 旧库接管模块

**Files:**
- Create: `packages/services/src/database/legacy-adoption.ts`
- Create: `packages/services/src/database/legacy-adoption.test.ts`
- Modify: `docs/superpowers/specs/2026-09-20-database-schema-auto-migration-design.md`（§5：unique 不报错，仅 PK 报错）

**Interfaces:**
- Produces:
  - `class LegacyAdoptionError extends Error`
  - `interface AdoptionColumn { name: string; type: string; primaryKey: boolean; notNull: boolean; default?: unknown }`
  - `interface AdoptionIndex { name: string; columns: string[]; isUnique: boolean; where?: string }`
  - `interface AdoptionTable { name: string; columns: Record<string, AdoptionColumn>; indexes: Record<string, AdoptionIndex> }`
  - `interface AdoptionSnapshot { tables: Record<string, AdoptionTable> }`
  - `interface AdoptionBaseline { hash: string; folderMillis: number }`
  - `function loadBaselineSnapshot(migrationsFolder: string): AdoptionSnapshot`
  - `function baselineHash(sqlPath: string): string`
  - `function adoptLegacyDatabase(database: Database.Database, input: { baseline: AdoptionBaseline; snapshot: AdoptionSnapshot }): boolean`

- [ ] **Step 1: 同步 spec §5 的 PK/unique 语义**

把 spec 中「该列是 `primaryKey` 或属于 unique 约束 → `LegacyAdoptionError`」改为：仅 `primaryKey` 报错；unique 由随后 `CREATE UNIQUE INDEX` 补齐。

- [ ] **Step 2: 写实现 `legacy-adoption.ts`**

```ts
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type Database from "better-sqlite3";

export class LegacyAdoptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LegacyAdoptionError";
  }
}

export interface AdoptionColumn {
  name: string;
  type: string;
  primaryKey: boolean;
  notNull: boolean;
  default?: unknown;
}

export interface AdoptionIndex {
  name: string;
  columns: string[];
  isUnique: boolean;
  where?: string;
}

export interface AdoptionTable {
  name: string;
  columns: Record<string, AdoptionColumn>;
  indexes: Record<string, AdoptionIndex>;
}

export interface AdoptionSnapshot {
  tables: Record<string, AdoptionTable>;
}

export interface AdoptionBaseline {
  hash: string;
  folderMillis: number;
}

const MIGRATIONS_TABLE = "__drizzle_migrations";

export function baselineHash(sqlPath: string): string {
  return createHash("sha256").update(readFileSync(sqlPath, "utf8")).digest("hex");
}

export function loadBaselineSnapshot(migrationsFolder: string): AdoptionSnapshot {
  const journal = JSON.parse(
    readFileSync(join(migrationsFolder, "meta", "_journal.json"), "utf8"),
  ) as { entries: Array<{ idx: number }> };
  const entry = journal.entries[0];
  if (!entry) throw new LegacyAdoptionError("migration journal is empty");
  const file = join(
    migrationsFolder,
    "meta",
    `${String(entry.idx).padStart(4, "0")}_snapshot.json`,
  );
  return JSON.parse(readFileSync(file, "utf8")) as AdoptionSnapshot;
}

/** 返回是否执行了接管；空库与已打标库返回 false。 */
export function adoptLegacyDatabase(
  database: Database.Database,
  input: { baseline: AdoptionBaseline; snapshot: AdoptionSnapshot },
): boolean {
  if (!hasAnyTable(database)) return false;
  if (hasBaselineRow(database, input.baseline.hash)) return false;
  reconcile(database, input.snapshot, input.baseline);
  return true;
}

function hasAnyTable(database: Database.Database): boolean {
  return Boolean(
    database
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != ? LIMIT 1",
      )
      .get(MIGRATIONS_TABLE),
  );
}

function hasBaselineRow(database: Database.Database, hash: string): boolean {
  const exists = database
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(MIGRATIONS_TABLE);
  if (!exists) return false;
  return Boolean(
    database.prepare(`SELECT 1 FROM ${quote(MIGRATIONS_TABLE)} WHERE hash = ?`).get(hash),
  );
}

function reconcile(
  database: Database.Database,
  snapshot: AdoptionSnapshot,
  baseline: AdoptionBaseline,
): void {
  const previousForeignKeys = database.pragma("foreign_keys", { simple: true }) as number;
  database.pragma("foreign_keys = OFF");
  let inTransaction = false;
  try {
    database.exec("BEGIN");
    inTransaction = true;
    for (const table of Object.values(snapshot.tables)) reconcileTable(database, table);
    dropExtraTables(database, snapshot);
    seedBaseline(database, baseline);
    database.exec("COMMIT");
    inTransaction = false;
  } catch (error) {
    if (inTransaction) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // keep the original error
      }
    }
    throw error;
  } finally {
    database.pragma(`foreign_keys = ${previousForeignKeys ? "ON" : "OFF"}`);
  }
}

function reconcileTable(database: Database.Database, table: AdoptionTable): void {
  if (!tableExists(database, table.name)) {
    throw new LegacyAdoptionError(`legacy adoption: baseline table is missing: ${table.name}`);
  }
  const liveColumns = new Map(
    (
      database.pragma(`table_info(${quote(table.name)})`) as Array<{
        name: string;
        type: string;
        notnull: number;
      }>
    ).map((row) => [row.name, row]),
  );
  for (const column of Object.values(table.columns)) {
    const live = liveColumns.get(column.name);
    if (!live) {
      addColumn(database, table, column);
      continue;
    }
    if (
      live.type.trim().toLowerCase() !== column.type.trim().toLowerCase() ||
      Boolean(live.notnull) !== column.notNull
    ) {
      throw new LegacyAdoptionError(
        `legacy adoption: column definition differs: ${table.name}.${column.name}`,
      );
    }
  }
  reconcileIndexes(database, table);
}

function addColumn(
  database: Database.Database,
  table: AdoptionTable,
  column: AdoptionColumn,
): void {
  if (column.primaryKey) {
    throw new LegacyAdoptionError(
      `legacy adoption: cannot add a primary key column: ${table.name}.${column.name}`,
    );
  }
  const hasDefault = column.default !== undefined;
  if (column.notNull && !hasDefault) {
    const row = database.prepare(`SELECT 1 FROM ${quote(table.name)} LIMIT 1`).get();
    if (row) {
      throw new LegacyAdoptionError(
        `legacy adoption: cannot add NOT NULL column without default to non-empty table: ${table.name}.${column.name}`,
      );
    }
  }
  const definition = [`${quote(column.name)} ${column.type}`];
  if (hasDefault) definition.push(`DEFAULT ${renderDefault(column.default)}`);
  if (column.notNull) definition.push("NOT NULL");
  database.exec(`ALTER TABLE ${quote(table.name)} ADD COLUMN ${definition.join(" ")}`);
}

function reconcileIndexes(database: Database.Database, table: AdoptionTable): void {
  const live = existingIndexes(database, table.name);
  for (const index of Object.values(table.indexes)) {
    const current = live.get(index.name);
    if (!current) {
      database.exec(createIndexSql(table.name, index, true));
      continue;
    }
    if (
      current.isUnique !== index.isUnique ||
      normalizePredicate(current.where) !== normalizePredicate(index.where) ||
      current.columns.join(",") !== index.columns.join(",")
    ) {
      throw new LegacyAdoptionError(`legacy adoption: index definition differs: ${index.name}`);
    }
  }
}

function existingIndexes(
  database: Database.Database,
  tableName: string,
): Map<string, { isUnique: boolean; columns: string[]; where: string | undefined }> {
  const result = new Map<
    string,
    { isUnique: boolean; columns: string[]; where: string | undefined }
  >();
  const list = database.pragma(`index_list(${quote(tableName)})`) as Array<{
    name: string;
    unique: number;
  }>;
  for (const row of list) {
    if (row.name.startsWith("sqlite_autoindex")) continue;
    const columns = (
      database.pragma(`index_info(${quote(row.name)})`) as Array<{ name: string }>
    ).map((info) => info.name);
    const definition = database
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get(row.name) as { sql: string } | undefined;
    result.set(row.name, {
      isUnique: Boolean(row.unique),
      columns,
      where: extractWhere(definition?.sql),
    });
  }
  return result;
}

function extractWhere(sql: string | undefined): string | undefined {
  if (!sql) return undefined;
  const match = sql.match(/\bWHERE\b([\s\S]*)$/i);
  return match?.[1]?.trim();
}

function normalizePredicate(value: string | undefined): string {
  if (value === undefined) return "";
  return value.replace(/[`"]/g, "").replace(/\s+/g, " ").trim();
}

function createIndexSql(
  tableName: string,
  index: AdoptionIndex,
  ifNotExists: boolean,
): string {
  const unique = index.isUnique ? "UNIQUE " : "";
  const guard = ifNotExists ? "IF NOT EXISTS " : "";
  const columns = index.columns.map(quote).join(", ");
  const where = index.where ? ` WHERE ${index.where}` : "";
  return `CREATE ${unique}INDEX ${guard}${quote(index.name)} ON ${quote(tableName)} (${columns})${where}`;
}

function dropExtraTables(database: Database.Database, snapshot: AdoptionSnapshot): void {
  const wanted = new Set(Object.keys(snapshot.tables));
  const rows = database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != ?",
    )
    .all(MIGRATIONS_TABLE) as Array<{ name: string }>;
  for (const row of rows) {
    if (!wanted.has(row.name)) database.exec(`DROP TABLE ${quote(row.name)}`);
  }
}

function seedBaseline(database: Database.Database, baseline: AdoptionBaseline): void {
  database.exec(
    `CREATE TABLE IF NOT EXISTS ${quote(MIGRATIONS_TABLE)} (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)`,
  );
  database.exec(`DELETE FROM ${quote(MIGRATIONS_TABLE)}`);
  database
    .prepare(`INSERT INTO ${quote(MIGRATIONS_TABLE)} (hash, created_at) VALUES (?, ?)`)
    .run(baseline.hash, baseline.folderMillis);
}

function tableExists(database: Database.Database, name: string): boolean {
  return Boolean(
    database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name),
  );
}

function renderDefault(value: unknown): string {
  return typeof value === "string" ? value : String(value);
}

function quote(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}
```

- [ ] **Step 3: 写失败测试 `legacy-adoption.test.ts`**

```ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import {
  adoptLegacyDatabase,
  baselineHash,
  LegacyAdoptionError,
  loadBaselineSnapshot,
  type AdoptionSnapshot,
} from "./legacy-adoption.js";

const migrationsFolder = fileURLToPath(
  new URL("../session-runtime/migrations", import.meta.url),
);
const baselineSqlPath = join(migrationsFolder, "0000_current_schema.sql");
const journal = JSON.parse(
  readFileSync(join(migrationsFolder, "meta", "_journal.json"), "utf8"),
) as { entries: Array<{ when: number }> };

function snapshotOf(tables: AdoptionSnapshot["tables"]): AdoptionSnapshot {
  return { tables };
}

function baselineDatabase(): Database.Database {
  const db = new Database(":memory:");
  const sql = readFileSync(baselineSqlPath, "utf8");
  for (const statement of sql.split("--> statement-breakpoint")) {
    const trimmed = statement.trim();
    if (trimmed) db.exec(trimmed);
  }
  db.exec(
    "CREATE TABLE __drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)",
  );
  return db;
}

const baseline = { hash: baselineHash(baselineSqlPath), folderMillis: journal.entries[0]!.when };

describe("adoptLegacyDatabase", () => {
  it("adds missing columns, creates partial indexes and drops obsolete tables", () => {
    const db = baselineDatabase();
    db.exec("ALTER TABLE channel_delivery DROP COLUMN platform_meta_json");
    db.exec("DROP INDEX project_location_active_path");
    db.exec("CREATE TABLE cron_job (id text PRIMARY KEY NOT NULL)");
    db.exec("INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('stale', 1)");

    expect(
      adoptLegacyDatabase(db, { baseline, snapshot: loadBaselineSnapshot(migrationsFolder) }),
    ).toBe(true);

    const columns = (db.pragma("table_info(channel_delivery)") as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(columns).toContain("platform_meta_json");
    const indexSql = (
      db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type='index' AND name='project_location_active_path'",
        )
        .get() as { sql: string }
    ).sql;
    expect(indexSql.replace(/[`"]/g, "")).toContain("WHERE project_location.status = 'active'");
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'cron_job'").get()).toBeUndefined();
    expect(db.prepare("SELECT hash, created_at FROM __drizzle_migrations").all()).toEqual([
      { hash: baseline.hash, created_at: baseline.folderMillis },
    ]);

    // 幂等：第二次不再接管
    expect(
      adoptLegacyDatabase(db, { baseline, snapshot: loadBaselineSnapshot(migrationsFolder) }),
    ).toBe(false);
  });

  it("rejects a partial index whose predicate differs", () => {
    const db = baselineDatabase();
    db.exec("DROP INDEX project_location_active_path");
    db.exec(
      "CREATE UNIQUE INDEX project_location_active_path ON project_location (normalized_path) WHERE \"project_location\".\"status\" = 'inactive'",
    );
    expect(() =>
      adoptLegacyDatabase(db, { baseline, snapshot: loadBaselineSnapshot(migrationsFolder) }),
    ).toThrow(LegacyAdoptionError);
  });

  it("returns false for a fresh database", () => {
    const db = new Database(":memory:");
    expect(
      adoptLegacyDatabase(db, { baseline, snapshot: loadBaselineSnapshot(migrationsFolder) }),
    ).toBe(false);
  });

  it("rejects a missing baseline table", () => {
    const db = baselineDatabase();
    db.exec("DROP TABLE channel_delivery");
    expect(() =>
      adoptLegacyDatabase(db, { baseline, snapshot: loadBaselineSnapshot(migrationsFolder) }),
    ).toThrow(/baseline table is missing: channel_delivery/);
  });

  it("rejects adding a NOT NULL column without default to a non-empty table", () => {
    const db = baselineDatabase();
    db.exec("ALTER TABLE application_storage_format DROP COLUMN version");
    expect(() =>
      adoptLegacyDatabase(db, { baseline, snapshot: loadBaselineSnapshot(migrationsFolder) }),
    ).toThrow(LegacyAdoptionError);
  });

  it("rejects adding a primary key column", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE t (keep text NOT NULL)");
    db.exec(
      "CREATE TABLE __drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)",
    );
    const snapshot = snapshotOf({
      t: {
        name: "t",
        columns: {
          id: { name: "id", type: "text", primaryKey: true, notNull: true },
          keep: { name: "keep", type: "text", primaryKey: false, notNull: true },
        },
        indexes: {},
      },
    });
    expect(() => adoptLegacyDatabase(db, { baseline, snapshot })).toThrow(/primary key column/);
  });
});
```

- [ ] **Step 4: 运行测试**

Run: `pnpm --filter @openharness/services exec vitest run src/database/legacy-adoption.test.ts`
Expected: PASS（6 个用例）。

- [ ] **Step 5: 提交**

```bash
git add packages/services/src/database/legacy-adoption.ts packages/services/src/database/legacy-adoption.test.ts docs/superpowers/specs/2026-09-20-database-schema-auto-migration-design.md
git commit -m "feat(services): add legacy schema adoption reconcile"
```

---

### Task 2: 接入迁移入口

**Files:**
- Modify: `packages/services/src/database/migrations.ts`
- Modify: `packages/services/src/database/session-database.test.ts`

**Interfaces:**
- Consumes: `adoptLegacyDatabase`、`loadBaselineSnapshot`（Task 1）。
- Produces: `applySessionMigrations` 现在「接管旧库 + 始终 `migrate()`」。

- [ ] **Step 1: 替换 `migrations.ts` 全文**

```ts
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";

import { adoptLegacyDatabase, loadBaselineSnapshot } from "./legacy-adoption.js";

/** 源码/Desktop 用相邻目录，CLI 打包后回退到 bundle 旁的 ./migrations。 */
function resolveMigrationsFolder(): string {
  const sourceOrDesktop = new URL("../session-runtime/migrations", import.meta.url);
  return fileURLToPath(
    existsSync(sourceOrDesktop) ? sourceOrDesktop : new URL("./migrations", import.meta.url),
  );
}

/** 每次打开：先接管基线前旧库，再无条件下应用增量迁移。 */
export function applySessionMigrations(database: Database.Database): void {
  const migrationsFolder = resolveMigrationsFolder();
  const migrations = readMigrationFiles({ migrationsFolder });
  const baseline = migrations[0];
  if (baseline) {
    adoptLegacyDatabase(database, {
      baseline: { hash: baseline.hash, folderMillis: baseline.folderMillis },
      snapshot: loadBaselineSnapshot(migrationsFolder),
    });
  }
  migrate(drizzle(database), { migrationsFolder });
}
```

注意：上面的实现只用到 `existsSync`，第一行 import 必须是 `import { existsSync } from "node:fs";`（不要保留 `readFileSync`，本文件已不再读取 journal）。

- [ ] **Step 2: 在 `session-database.test.ts` 增加旧库集成用例**

在 `describe("SessionDatabase", ...)` 内新增（顶部补 `readFileSync` 已有；`Database` 已 import）：

```ts
it("adopts a pre-baseline database on open and then applies incremental migrations", () => {
  withTempPath((path) => {
    const migrationsFolder = fileURLToPath(
      new URL("../session-runtime/migrations/", import.meta.url),
    );
    const baselineSql = readFileSync(join(migrationsFolder, "0000_current_schema.sql"), "utf8");
    const legacy = new Database(path);
    for (const statement of baselineSql.split("--> statement-breakpoint")) {
      const trimmed = statement.trim();
      if (trimmed) legacy.exec(trimmed);
    }
    legacy.exec("ALTER TABLE channel_delivery DROP COLUMN platform_meta_json");
    legacy.exec("CREATE TABLE cron_job (id text PRIMARY KEY NOT NULL)");
    legacy.exec(
      "CREATE TABLE __drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)",
    );
    legacy.exec("INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('stale', 1)");
    legacy.close();

    const database = SessionDatabase.open({ path });
    try {
      const columns = (
        database.connection.pragma("table_info(channel_delivery)") as Array<{ name: string }>
      ).map((column) => column.name);
      expect(columns).toContain("platform_meta_json");
      expect(
        database.connection
          .prepare("SELECT 1 FROM sqlite_master WHERE name = 'cron_job'")
          .get(),
      ).toBeUndefined();
    } finally {
      database.close();
    }
  });
});
```

顶部 import 需补 `fileURLToPath`：`import { fileURLToPath } from "node:url";`（`readFileSync` 已在）。

- [ ] **Step 3: 运行**

Run: `pnpm --filter @openharness/services exec vitest run src/database/session-database.test.ts`
Expected: 新用例 PASS；现有单基线断言此阶段仍通过（尚未加 `0001`）。

- [ ] **Step 4: 提交**

```bash
git add packages/services/src/database/migrations.ts packages/services/src/database/session-database.test.ts
git commit -m "feat(services): always migrate and adopt legacy databases on open"
```

---

### Task 3: 删除 `application_storage_format` 并生成 0001

**Files:**
- Modify: `packages/services/src/session-runtime/schema.ts`
- Create: `packages/services/src/session-runtime/migrations/0001_drop_application_storage_format.sql`
- Create: `packages/services/src/session-runtime/migrations/meta/0001_snapshot.json`
- Modify: `packages/services/src/session-runtime/migrations/meta/_journal.json`
- Modify: `packages/services/src/session-runtime/__test__/store.test.ts`
- Modify: `packages/services/src/database/session-database.test.ts`
- Modify: `packages/services/src/database/__fixtures__/current-schema-inventory.json`
- Modify: `packages/services/scripts/check-bundled-baseline.ts`

- [ ] **Step 1: 删除 schema 定义**

删除 `schema.ts:597-600` 整段：

```ts
export const applicationStorageFormat = sqliteTable("application_storage_format", {
  id: integer("id").primaryKey(),
  version: integer("version").notNull(),
}, (table) => [check("application_storage_format_singleton", sql`${table.id} = 1`)]);
```

- [ ] **Step 2: 生成迁移**

Run: `pnpm --filter @openharness/services db:generate`
Expected: 生成 `migrations/0001_<随机>.sql`、`meta/0001_snapshot.json`，`_journal.json` 新增第 2 条。

**先核对生成的 SQL 只含 `DROP TABLE \`application_storage_format\`;`**（`read` 打开该文件确认没有其它语句；若出现额外语句说明存在 schema 漂移，停下排查）。

- [ ] **Step 3: 规范化文件名与 tag**

把 `0001_<随机>.sql` 重命名为 `0001_drop_application_storage_format.sql`，并把 `_journal.json` 第 2 条的 `tag` 改成 `0001_drop_application_storage_format`（其余字段保持 drizzle 生成值）。

Run: `pnpm --filter @openharness/services db:check`
Expected: PASS。

- [ ] **Step 4: 更新 `store.test.ts`**

`store.test.ts:141-149` 的 `it("creates a format 3 database with input attachment and typed part columns", ...)` 里，把：

```ts
        expect(
          database
            .prepare("SELECT version FROM application_storage_format WHERE id = 1")
            .get(),
        ).toEqual({ version: 3 });
```

替换为：

```ts
        expect(
          database
            .prepare("SELECT 1 FROM sqlite_master WHERE name = 'application_storage_format'")
            .get(),
        ).toBeUndefined();
```

并把用例名改为 `"creates a current-format database with input attachment and typed part columns"`。

- [ ] **Step 5: 更新 `session-database.test.ts`**

1. 删掉 `inventory()` 里的 `format` 字段（`:24` 的一行）。
2. 用例 `"initializes an empty database with the current storage format and closes it"` 中，把 `SELECT version FROM application_storage_format` 断言替换为：

```ts
      expect(
        database.connection
          .prepare("SELECT 1 FROM sqlite_master WHERE name = 'application_storage_format'")
          .get(),
      ).toBeUndefined();
```

3. 用例 `"preserves the current inventory and data on a second open with one baseline"` 中：
   - 把 `expect(journal).toHaveLength(1)` 改为 `expect(journal).toHaveLength(2)`；
   - **整段替换**现有 `const directory = ...` / `const journal = ...` 声明与断言（原 `:76-80`），不要只改断言，否则重复声明 `const` 会编译失败：

```ts
    const directory = new URL("../session-runtime/migrations/", import.meta.url);
    const sqlFiles = readdirSync(directory).filter((name) => name.endsWith(".sql")).sort();
    expect(sqlFiles).toEqual([
      "0000_current_schema.sql",
      "0001_drop_application_storage_format.sql",
    ]);
    const journal = JSON.parse(readFileSync(new URL("meta/_journal.json", directory), "utf8"));
    expect(journal.entries.map((entry: { tag: string }) => entry.tag).sort()).toEqual([
      "0000_current_schema",
      "0001_drop_application_storage_format",
    ]);
```

- [ ] **Step 6: 重新生成 schema inventory 夹具**

临时新建 `packages/services/src/database/__dump-inventory.test.ts`：

```ts
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { it } from "vitest";

import { SessionDatabase } from "./session-database.js";

it("dump inventory", () => {
  const directory = mkdtempSync(join(tmpdir(), "ohs-dump-"));
  const database = SessionDatabase.open({ path: join(directory, "sessions.db") });
  const schema = database.connection
    .prepare(
      "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE ? AND name != ? ORDER BY type,name",
    )
    .all("sqlite_%", "__drizzle_migrations") as Array<{ type: string; name: string; sql: string }>;
  const inventory = {
    schema,
    tables: schema
      .filter((row) => row.type === "table")
      .map((row) => ({
        name: row.name,
        columns: database.connection.pragma(`table_info(${JSON.stringify(row.name)})`),
        foreignKeys: database.connection.pragma(`foreign_key_list(${JSON.stringify(row.name)})`),
      })),
  };
  const normalized = JSON.parse(
    JSON.stringify(inventory, (_key, item) =>
      typeof item === "string" ? item.replace(/\s+/g, " ").trim() : item,
    ),
  );
  writeFileSync(
    new URL("./__fixtures__/current-schema-inventory.json", import.meta.url),
    `${JSON.stringify(normalized, null, 2)}\n`,
  );
  database.close();
  rmSync(directory, { recursive: true, force: true });
});
```

Run: `pnpm --filter @openharness/services exec vitest run src/database/__dump-inventory.test.ts`
然后**删除**该临时文件。Expected: 夹具被重写，且不再含 `application_storage_format`（表数 31）。

- [ ] **Step 7: 更新 `check-bundled-baseline.ts`**

把 `:28` 的

```ts
    assert.deepEqual(readdirSync(assets).filter((file) => file.endsWith(".sql")), ["0000_current_schema.sql"]);
    assert.equal(
      readFileSync(join(assets, "0000_current_schema.sql"), "utf8"),
      readFileSync(join(source, "0000_current_schema.sql"), "utf8"),
    );
    assert.equal(JSON.parse(readFileSync(join(assets, "meta/_journal.json"), "utf8")).entries.length, 1);
```

替换为：

```ts
    const sqlFiles = readdirSync(source).filter((file) => file.endsWith(".sql")).sort();
    assert.deepEqual(readdirSync(assets).filter((file) => file.endsWith(".sql")).sort(), sqlFiles);
    for (const file of sqlFiles) {
      assert.equal(readFileSync(join(assets, file), "utf8"), readFileSync(join(source, file), "utf8"));
    }
    const journalEntries = JSON.parse(readFileSync(join(assets, "meta/_journal.json"), "utf8")).entries;
    assert.equal(journalEntries.length, sqlFiles.length);
```

并把 `:40-46` 的断言改为：

```ts
          assert.equal(db.connection.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != '__drizzle_migrations'").get().n, 31);
          assert.equal(db.connection.prepare("SELECT count(*) AS n FROM __drizzle_migrations").get().n, 2);
```

（删除 `application_storage_format.version` 断言。）

- [ ] **Step 8: 运行 services 全量测试与基线检查**

Run: `pnpm --filter @openharness/services test`
Run: `pnpm --filter @openharness/services test:bundled-baseline`
Expected: 全绿。

- [ ] **Step 9: 提交**

```bash
git add packages/services/src/session-runtime/schema.ts packages/services/src/session-runtime/migrations packages/services/src/session-runtime/__test__/store.test.ts packages/services/src/database
git commit -m "chore(services): drop application_storage_format and add incremental migration"
```

---

### Task 4: 放宽 `verify-clean-slate` 的单基线断言

**Files:**
- Modify: `scripts/verify-clean-slate.mjs`

**Interfaces:**
- Consumes: 迁移目录现在含 `0000` + `0001`。
- Produces: 门禁改为「基线存在 + journal 与 `.sql` 文件一一对应」。

- [ ] **Step 1: 替换 `checkMigrations`**

```js
function checkMigrations(root) {
  const directory = join(root, "packages/services/src/session-runtime/migrations");
  const rel = "packages/services/src/session-runtime/migrations";
  if (!existsSync(directory)) return [missing("migration", rel)];
  const sql = readdirSync(directory).filter((name) => name.endsWith(".sql")).sort();
  const results = [];
  const baseline = "0000_current_schema.sql";
  if (!sql.includes(baseline)) {
    results.push(problem("migration", rel, 1, `missing baseline ${baseline}; found [${sql.join(", ")}]`));
  }
  const journalFile = `${rel}/meta/_journal.json`;
  const journalSource = read(root, journalFile);
  if (journalSource === undefined) return [...results, missing("migration", journalFile)];
  try {
    const journal = JSON.parse(journalSource);
    const entries = Array.isArray(journal.entries) ? journal.entries : [];
    const tags = entries.map((entry) => `${entry.tag}.sql`).sort();
    if (entries.length === 0 || tags.join("|") !== sql.join("|")) {
      results.push(problem("migration", journalFile, 1, `journal tags must match migration files; journal=[${tags.join(", ")}] files=[${sql.join(", ")}]`));
    }
    if (entries[0]?.tag !== "0000_current_schema") {
      results.push(problem("migration", journalFile, 1, "first journal entry must be 0000_current_schema"));
    }
  } catch (error) {
    results.push(problem("migration", journalFile, 1, `invalid journal JSON: ${error.message}`));
  }
  return results;
}
```

- [ ] **Step 2: 替换 `inventoryDirectory` 内的两处断言**

把 `sql.length !== 1 || sql[0] !== "0000_current_schema.sql"` 段替换为：

```js
  if (!sql.includes("0000_current_schema.sql")) {
    results.push(problem(category, directory, 1, `bundled migration inventory must contain the baseline; found [${sql.join(", ")}]`));
  }
```

把 journal 断言**整段替换**（现有 `inventoryDirectory` 里已有 `const journal = ...` 声明，必须连声明一起替换，否则重复 `const`）：

```js
  const journal = read(root, `${directory}/meta/_journal.json`);
  let journalOk = false;
  if (journal) {
    try {
      const entries = JSON.parse(journal).entries ?? [];
      const tags = entries.map((entry) => `${entry.tag}.sql`).sort();
      journalOk = entries.length > 0 && tags.join("|") === sql.join("|");
    } catch {
      journalOk = false;
    }
  }
  if (!journalOk) {
    results.push(problem(category, `${directory}/meta/_journal.json`, 1, "bundled journal must match bundled migration files"));
  }
```

- [ ] **Step 3: 运行门禁与其测试**

Run: `pnpm check:clean-slate`
Run: `pnpm test:clean-slate`
Expected: 全绿（`verify-clean-slate.test.mjs` 构造的 `0001_old.sql` + 空 journal 仍会因「journal 与文件不匹配」被标记，输出仍含 `0001_old.sql`，断言不变即通过；若断言依赖具体文案则同步更新该测试）。

- [ ] **Step 4: 提交**

```bash
git add scripts/verify-clean-slate.mjs
git commit -m "fix(scripts): verify migration chain instead of single baseline"
```

---

### Task 5: 让打包迁移清单从源目录动态推导

**Files:**
- Modify: `apps/desktop/scripts/verify-migration-artifact.mjs`
- Modify: `apps/desktop/scripts/verify-migration-artifact.test.mjs`

**Interfaces:**
- Produces:
  - `function expectedMigrationPaths(migrationsDirectory: string): string[]`
  - `validateMigrationInventory(value, expectedPaths: string[])`
  - `verifyPlatformInventories(values, expectedPaths: string[])`
  - `writePackagedMigrationInventory(platform, expectedPaths: string[])`

- [ ] **Step 1: 改 `verify-migration-artifact.mjs`**

只把 fs 相关 import 换成下面两行（`readdirSync` 属于 `node:fs`，**不能**从 `node:fs/promises` 导入，否则模块加载即抛 `does not provide an export named 'readdirSync'`）；crypto / path / url 的 import 保持不变。改完后顶部应为：

```js
import { createHash } from "node:crypto"
import { readdirSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
```

删除硬编码的 `expectedMigrationPaths` 常量，改为导出函数：

```js
export function expectedMigrationPaths(migrationsDirectory) {
  const paths = []
  for (const name of readdirSync(migrationsDirectory)) {
    if (name.endsWith(".sql")) paths.push(name)
  }
  for (const name of readdirSync(join(migrationsDirectory, "meta"))) {
    if (name.endsWith(".json")) paths.push(`meta/${name}`)
  }
  return paths.sort()
}
```

`validateMigrationInventory` 改为接收期望清单：

```js
export function validateMigrationInventory(value, expectedPaths) {
  // ...原有校验不变...
  const actualPaths = value.migrations.map((entry) => entry?.path).sort()
  if (JSON.stringify(actualPaths) !== JSON.stringify([...expectedPaths].sort())) {
    throw new Error(
      `migration inventory must contain exactly [${[...expectedPaths].sort().join(", ")}]; found [${actualPaths.join(", ")}]`
    )
  }
  // ...其余不变...
}
```

`verifyPlatformInventories` 改为显式透传（不要用 `values.map(validateMigrationInventory)`）：

```js
export function verifyPlatformInventories(values, expectedPaths) {
  const entries = values.map((value) => validateMigrationInventory(value, expectedPaths))
  // ...其余不变...
}
```

`writePackagedMigrationInventory(platform, expectedPaths)` 中把

```js
  const inventory = validateMigrationInventory({
```

改为 `validateMigrationInventory({ ... }, expectedPaths)`。

`main()` 增加源目录推导并透传：

```js
const sourceMigrations = resolve(desktopRoot, "../../packages/services/src/session-runtime/migrations")
const expected = expectedMigrationPaths(sourceMigrations)
```

`--write-inventory` 调用 `writePackagedMigrationInventory(args[0], expected)`；`--verify-inventories` 调用 `verifyPlatformInventories(inventories, expected)`。

- [ ] **Step 2: 更新 `verify-migration-artifact.test.mjs`**

把顶部 `migrations` 常量与调用改为：

```js
const expected = [
  "0000_current_schema.sql",
  "0001_drop_application_storage_format.sql",
  "meta/0000_snapshot.json",
  "meta/0001_snapshot.json",
  "meta/_journal.json",
]

const migrations = [
  { path: "0000_current_schema.sql", sha256: "a".repeat(64) },
  { path: "0001_drop_application_storage_format.sql", sha256: "d".repeat(64) },
  { path: "meta/0000_snapshot.json", sha256: "b".repeat(64) },
  { path: "meta/0001_snapshot.json", sha256: "e".repeat(64) },
  { path: "meta/_journal.json", sha256: "c".repeat(64) },
]
```

所有 `validateMigrationInventory(win)` → `validateMigrationInventory(win, expected)`；
`verifyPlatformInventories([win, linux])` → `verifyPlatformInventories([win, linux], expected)`。

把「rejects a packaged app with a missing or legacy migration」用例改为「与源目录不一致被拒」：

```js
test("rejects a packaged app whose migration set differs from the source", () => {
  assert.throws(
    () => validateMigrationInventory(inventory("win", migrations.slice(1)), expected),
    /migration inventory must contain exactly/
  )
  assert.throws(
    () =>
      validateMigrationInventory(
        inventory("win", [...migrations, { path: "0002_extra.sql", sha256: "f".repeat(64) }]),
        expected
      ),
    /0002_extra\.sql/
  )
  assert.throws(
    () =>
      validateMigrationInventory(
        inventory("win", [...migrations, { path: "meta/0002_snapshot.json", sha256: "f".repeat(64) }]),
        expected
      ),
    /meta\/0002_snapshot\.json/
  )
})
```

`verifyPlatformInventories` 的哈希差异用例同样补 `expected` 参数。

- [ ] **Step 3: 运行测试**

Run: `node --test apps/desktop/scripts/verify-migration-artifact.test.mjs`
Expected: PASS。

- [ ] **Step 4: 提交**

```bash
git add apps/desktop/scripts/verify-migration-artifact.mjs apps/desktop/scripts/verify-migration-artifact.test.mjs
git commit -m "fix(desktop): derive packaged migration inventory from source dir"
```

---

### Task 6: 文档同步

**Files:** 见每步；另需更新 `docs/README.md` 的 `## 当前格式策略` 块（SQLite 自动迁移 + 旧库接管口径与入链锚点）。

- [ ] **Step 1: `packages/services/README.md`**

把 `数据库只包含 \`0000_current_schema.sql\` 和一条 \`_journal.json\` 记录。它从空目录一次建立当前 schema，二次打开保持幂等；旧数据库不在支持路径内，也不会在启动时自动转换。`

改为：

`数据库包含基线 \`0000_current_schema.sql\` 及其后的增量迁移。从空目录一次建立当前 schema，二次打开幂等；基线前旧库在启动时按基线快照一次性接管补齐（补列、建索引、清理废弃表），再应用增量迁移。`

- [ ] **Step 2: `apps/desktop/docs/packaging.md`**

把 `确认都只有 \`0000_current_schema.sql\`、当前 snapshot 和单条 journal，并且两边文件哈希一致；`

改为：

`确认包含基线与全部增量迁移（\`.sql\` 与 \`meta/*.json\`，清单从源迁移目录推导），并且两边文件哈希一致；`

- [ ] **Step 3: `docs/session-runtime-storage-architecture.md`**

`:111-117` 的文件清单（「当前数据库只有：」+ 三行 `0000` 路径）改为：

```text
迁移目录以 0000_current_schema.sql 为基线，其后是 0001+ 增量迁移：

packages/services/src/session-runtime/migrations/0000_current_schema.sql
packages/services/src/session-runtime/migrations/0001_drop_application_storage_format.sql
packages/services/src/session-runtime/migrations/meta/0000_snapshot.json
packages/services/src/session-runtime/migrations/meta/0001_snapshot.json
packages/services/src/session-runtime/migrations/meta/_journal.json
```

`:119` 改为：

`迁移目录以 \`0000_current_schema.sql\` 为基线，其后为增量迁移；journal 与 \`.sql\` 文件一一对应。启动先按基线快照接管基线前旧库，再无条件应用增量迁移；不做字段猜测或读取时降级。`

`:162` 改为：

`- \`node scripts/verify-clean-slate.mjs\`：迁移链完整性（基线 + journal 与文件一致）、协议和禁止兼容面。`

`:31` 表格行的「应用唯一当前 migration」改为「应用迁移链（基线 + 增量）」。`

- [ ] **Step 4: `docs/architecture-migration-status.md`**

- `:59` 改为：`- SQLite 以 \`packages/services/src/session-runtime/migrations/0000_current_schema.sql\` 为基线，其后为 \`drizzle-kit generate\` 产出的增量迁移链。`
- `:60` 改为：`- 启动先接管基线前旧库（按基线快照补齐列/索引、清理废弃表），再无条件下应用增量迁移；不做字段猜测或读取时降级。`
- `:72` 改为：`- 旧 schema 的读取时升级与字段猜测；仅保留快照驱动的基线接管（见数据库 schema 自动迁移设计）。`
- `:82` 表格该行改为：`| \`pnpm check:clean-slate\` | Client 公开导出、协议版本/header、迁移链完整性、发布顺序和 bundle inventory |`

- [ ] **Step 5: `docs/operations-and-recovery.md`**

- `:10` 的 `- 旧格式数据不会自动升级。格式不匹配时先停下，不要手改版本号。` 改为：`- 基线前旧库由快照驱动的接管自动补齐结构，再应用增量迁移；不要手改 __drizzle_migrations。`
- `:16` 改为：`  -> 接管基线前旧库并应用增量迁移`
- `:120` 改为：`- 迁移链必须完整：基线 \`0000_current_schema.sql\` 与其后增量迁移的 journal 与文件一一对应。`
- `:122` 改为：`旧库由快照驱动的接管处理，不要手工改 \`__drizzle_migrations\`；接管只补齐基线快照的结构，不做字段猜测。`
- `## 破坏性格式切换`（`:124-133`，其中含 `:129`）整节替换为：

```markdown
## schema 演进与旧库接管

- 迁移链以 `0000_current_schema.sql` 为基线，其后为增量迁移；启动时按 `__drizzle_migrations` 水位线应用。
- 基线前旧库（表结构属于当前基线世代、但缺列/索引或含废弃表）由快照对账一次性接管补齐，再应用增量迁移。
- 接管只做可加性变更：缺列补列、缺索引建索引、删除基线中不存在的表；改名/改类型/数据变换必须写显式迁移文件。
- 缺整表、缺主键列、列或索引定义冲突会明确失败，不做猜测。
- 需要继续使用更早世代的旧数据时，改用对应旧版本运行并按需导出；新版本不负责跨世代转换。
```

- [ ] **Step 6: `docs/durable-execution-data-model.md`**

- `:91` 的 `本项目不读取旧数据，也不自动升级旧数据。` 改为：`本项目对基线前旧库做快照驱动的接管补齐，并自动应用增量迁移；不做字段猜测或跨世代数据转换。`
- `:95` 表格行改为：`| daemon SQLite | \`__drizzle_migrations\` 水位线 | 启动接管基线前旧库并应用增量迁移；基线 hash 缺失视为旧库 |`
- `:104` 改为：`数据库 migrations 建立新库并对已存在库应用增量迁移；基线前旧库先按基线快照接管补齐。不做字段猜测、别名或读取时降级。`

- [ ] **Step 7: 其余文档**

- `docs/development-data-reset.md:156`：把 `确认生成协议版本 4 所用配置和单一数据库基线。` 改为 `确认生成协议版本 4 所用配置和迁移链基线（旧库会自动接管，无需为此重置）。`
- `docs/channels-flow.md:204` 表格该行说明改为：`迁移链基线（起点），包含聊天映射和回复状态`。
- `docs/architecture-overview.md:148`：把 `- 从旧字段、旧目录或旧数据库猜测当前格式；` 改为 `- 从旧字段、旧目录猜测当前格式；旧库只允许按基线快照接管补齐结构。`
- `docs/release-process.md:53`：把 `都只包含当前单一数据库基线` 改为 `都包含基线与全部增量迁移（journal 与文件一一对应）`。

- [ ] **Step 8: 运行文档检查**

Run: `pnpm check-docs`
Expected: 通过。

- [ ] **Step 9: 提交**

```bash
git add docs packages/services/README.md apps/desktop/docs/packaging.md
git commit -m "docs: describe schema auto-migration and legacy adoption"
```

---

### Task 7: 全量验证与现网库 E2E

**Files:** 无（验证）。

- [ ] **Step 1: 全仓门禁**

Run:
```bash
pnpm --filter @openharness/services test
pnpm --filter @openharness/services check-types
pnpm --filter @openharness/services test:bundled-baseline
pnpm check:clean-slate
pnpm test:clean-slate
pnpm check-docs
```
Expected: 全绿。

- [ ] **Step 2: 现网库 E2E**

1. 停掉桌面 dev（Ctrl+C 那个 `pnpm dev:apps` 终端），确保 daemon 释放 `sessions.db`。
2. 重启桌面 dev，让 daemon 打开库（自动接管 + 应用 `0001`）。
3. 只读核对（把路径换成你的 `%USERPROFILE%`）：

```powershell
node -e "const {DatabaseSync}=require('node:sqlite'); const p=process.env.USERPROFILE+'/.openharness-ts/data/session-runtime/sessions.db'; const db=new DatabaseSync(p,{readOnly:true}); console.log('tables:', db.prepare(\"select count(*) n from sqlite_master where type='table' and name not like 'sqlite_%'\").get()); console.log('has_platform_meta:', db.prepare(\"select count(*) n from pragma_table_info('channel_delivery') where name='platform_meta_json'\").get()); console.log('legacy_tables:', db.prepare(\"select name from sqlite_master where name in ('cron_job','cron_run','application_storage_format')\").all()); console.log('migrations:', db.prepare('select hash, created_at from __drizzle_migrations order by created_at').all().length); db.close();"
```

Expected：`legacy_tables` 为空；`has_platform_meta.n == 1`；`migrations == 2`。

4. 在飞书里给机器人发一条消息，确认收到回复。

- [ ] **Step 3: 最终提交（如 E2E 暴露修复）**

```bash
git add -A
git commit -m "fix(services): address schema auto-migration E2E findings"
```

---

## Self-Review

**Spec coverage**
- §1 根因 → Task 3（补列、0001）与 Task 2（始终迁移）。
- §2 目标 → Task 1/2/3；非目标（FK/CHECK、不可加性变更）由 Task 1 的报错路径兜住。
- §4 目标机制 → Task 2。
- §5 对账算法 → Task 1（含 partial `where`、PK 报错、`foreign_keys=OFF`、`DELETE`+seed baseline）。
- §6 移除标记 → Task 3。
- §7 影响面 → Task 3（测试/夹具/基线脚本）、Task 4、Task 5、Task 6。
- §9/§10 验收与测试 → Task 1/2/3 的单测 + Task 7 全量。

**Placeholder scan**：无 TODO/TBD；每个代码步骤给出完整实现或完整替换片段。

**Type consistency**：`AdoptionSnapshot` / `AdoptionBaseline` / `LegacyAdoptionError` 在 Task 1 定义，Task 2 使用；`expectedMigrationPaths` 在 Task 5 定义并被同任务调用。

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-09-20-database-schema-auto-migration.md`。两种执行方式：**

1. **Subagent-Driven（推荐）** — 每个任务派新子代理，任务间复核。
2. **Inline Execution** — 本会话内按批执行 + 检查点。

选哪种？
