import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { describe, expect, it } from "vitest";

import { sessionEventSequence } from "../session-runtime/schema.js";
import { SessionDatabase } from "./session-database.js";

// Regenerated from the current migration chain, including temporary resource sources.
const expected = JSON.parse(readFileSync(new URL("./__fixtures__/current-schema-inventory.json", import.meta.url), "utf8"));

function inventory(database: Database.Database) {
  const schema = database.prepare(
    "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE ? AND name != ? ORDER BY type,name",
  ).all("sqlite_%", "__drizzle_migrations") as Array<{ type: string; name: string; sql: string }>;
  return {
    schema,
    tables: schema.filter((row) => row.type === "table").map((row) => ({
      name: row.name,
      columns: database.pragma(`table_info(${JSON.stringify(row.name)})`),
      foreignKeys: database.pragma(`foreign_key_list(${JSON.stringify(row.name)})`),
    })),
  };
}

function normalize(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_key, item) =>
    typeof item === "string" ? item.replace(/\s+/g, " ").trim() : item));
}

function withTempPath(test: (path: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "vk-session-database-"));
  const path = join(directory, "sessions.db");
  try {
    test(path);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("SessionDatabase", () => {
  it("rebuilds only Goal tables while preserving existing sessions, messages, Runs, and tool results", () => {
    const directory = mkdtempSync(join(tmpdir(), "vk-goal-migration-"));
    const path = join(directory, "upgrade.db");
    const previousMigrations = join(directory, "migrations");
    mkdirSync(join(previousMigrations, "meta"), { recursive: true });
    const source = new URL("../session-runtime/migrations/", import.meta.url);
    const journal = JSON.parse(readFileSync(new URL("meta/_journal.json", source), "utf8"));
    const goalMigrationIndex = journal.entries.findIndex((entry: { tag: string }) => entry.tag === "0007_goal_simplification");
    expect(goalMigrationIndex).toBeGreaterThan(0);
    const goalMigration = journal.entries[goalMigrationIndex];
    journal.entries = journal.entries.slice(0, goalMigrationIndex);
    writeFileSync(join(previousMigrations, "meta/_journal.json"), JSON.stringify(journal));
    for (const entry of journal.entries) copyFileSync(new URL(`${entry.tag}.sql`, source), join(previousMigrations, `${entry.tag}.sql`));
    let connection = new Database(path);
    try {
      connection.pragma("foreign_keys = ON");
      migrate(drizzle(connection), { migrationsFolder: previousMigrations });
      connection.exec(`
        INSERT INTO session (id,cwd,title,model,status,metadata_json,created_at,updated_at) VALUES ('s','cwd','saved','m','idle','{}',1,1);
        INSERT INTO session_input (id,session_id,seq,delivery,content,items_json,metadata_json,created_at) VALUES ('i','s',1,'queue','saved','[]','{}',1);
        INSERT INTO session_run (id,session_id,input_id,status,metadata_json,created_at,updated_at) VALUES ('r','s','i','completed','{}',1,1);
        INSERT INTO session_message (id,session_id,seq,role,run_id,metadata_json,created_at,updated_at) VALUES ('m','s',1,'assistant','r','{}',1,1);
        INSERT INTO session_message_part (id,session_id,message_id,seq,type,status,tool_name,output_json,metadata_json,created_at,updated_at)
          VALUES ('p','s','m',1,'tool','completed','Read','{"text":"saved tool result"}','{}',1,1);
        INSERT INTO session_goal (id,session_id,objective,objective_version,phase,requirements_json,revision,status,max_auto_turns,usage_json,auto_turns_used,no_progress_count,stagnation_count,evidence_json,created_at,updated_at)
          VALUES ('g','s','old',1,'executing','[]',0,'active',0,'{}',0,0,0,'[]',1,1);
        INSERT INTO session_goal_version (goal_id,objective_version,objective,requirements_json,change_kind,change_reason,request_id,actor_json,input_ids_json,created_at)
          VALUES ('g',1,'old','[]','create','old','q','{}','[]',1);
        INSERT INTO session_goal_model_attempt (run_id,generation_id,attempt,goal_id,objective_version,session_id,model,purpose,state,known_input_tokens,known_output_tokens,inconsistent,started_at)
          VALUES ('r','gen',1,'g',1,'s','m','generation','complete',1,1,0,1);
        INSERT INTO session_goal_request (request_id,session_id,fingerprint,status,goal_id,created_at,updated_at) VALUES ('q','s','old','completed','g',1,1);
        INSERT INTO session_goal_assessment (id,goal_id,revision,run_id,assessment_json,created_at) VALUES ('a','g',0,'r','{}',1);
        INSERT INTO session_goal_continuation (id,goal_id,revision,previous_run_id,input_id,run_id,status,created_at,updated_at) VALUES ('c','g',0,'r','i','r','pending',1,1);
      `);
      const retainedTables = ["session", "session_input", "session_run", "session_message", "session_message_part"];
      const saved = retainedTables.map(table => connection.prepare(`SELECT * FROM ${table}`).all());
      const nonGoalInventory = (value: ReturnType<typeof inventory>) => ({
        schema: value.schema.filter(row => !row.tbl_name.startsWith("session_goal")),
        tables: value.tables.filter(row => !row.name.startsWith("session_goal")),
      });
      const originalInventory = nonGoalInventory(inventory(connection));
      // 单独验证 Goal 迁移不改其他表，再验证后续完整迁移链。
      journal.entries.push(goalMigration);
      copyFileSync(new URL(`${goalMigration.tag}.sql`, source), join(previousMigrations, `${goalMigration.tag}.sql`));
      writeFileSync(join(previousMigrations, "meta/_journal.json"), JSON.stringify(journal));
      migrate(drizzle(connection), { migrationsFolder: previousMigrations });
      expect(normalize(nonGoalInventory(inventory(connection)))).toEqual(normalize(originalInventory));
      connection.close();
      const upgraded = SessionDatabase.open({ path });
      connection = upgraded.connection;
      expect(retainedTables.map(table => connection.prepare(`SELECT * FROM ${table}`).all())).toEqual(saved);
      expect(normalize(inventory(connection))).toEqual(normalize(expected));
      for (const table of ["session_goal", "session_goal_version", "session_goal_model_attempt", "session_goal_request", "session_goal_continuation"])
        expect(connection.prepare(`SELECT count(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
      expect(connection.prepare("SELECT 1 FROM sqlite_master WHERE name = 'session_goal_assessment'").get()).toBeUndefined();
      expect(connection.pragma("foreign_key_check")).toEqual([]);
    } finally {
      if (connection.open) connection.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rolls schema-based writes back with the existing SQLite transaction", () => {
    withTempPath((path) => {
      const database = SessionDatabase.open({ path });
      try {
        expect(database.orm.select().from(sessionEventSequence).get()).toEqual({ id: 1, reservedThrough: 0 });
        expect(() => database.connection.transaction(() => {
          database.orm.update(sessionEventSequence).set({ reservedThrough: 42 })
            .where(eq(sessionEventSequence.id, 1)).run();
          expect(database.orm.select().from(sessionEventSequence).get()?.reservedThrough).toBe(42);
          throw new Error("rollback typed write");
        })()).toThrow("rollback typed write");
        expect(database.orm.select().from(sessionEventSequence).get()?.reservedThrough).toBe(0);
      } finally {
        database.close();
      }
    });
  });

  it("initializes an empty database with the current storage format and closes it", () => {
    withTempPath((path) => {
      const database = SessionDatabase.open({ path });
      expect(database.path).toBe(resolve(path));
      expect(database.connection.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(
        database.connection
          .prepare("SELECT 1 FROM sqlite_master WHERE name = 'application_storage_format'")
          .get(),
      ).toBeUndefined();

      database.close();

      expect(() => database.connection.prepare("SELECT 1").get()).toThrow();
    });
  });

  it("preserves the current inventory and data on a second open with the migration chain", () => {
    withTempPath((path) => {
      const first = SessionDatabase.open({ path });
      let journal: unknown[];
      try {
        expect(normalize(inventory(first.connection))).toEqual(normalize(expected));
        first.connection.prepare("UPDATE session_event_sequence SET reserved_through = 42 WHERE id = 1").run();
        journal = first.connection.prepare("SELECT * FROM __drizzle_migrations").all();
        expect(journal).toHaveLength(9);
      } finally {
        first.close();
      }
      const second = SessionDatabase.open({ path });
      try {
        expect(normalize(inventory(second.connection))).toEqual(normalize(expected));
        expect(second.connection.prepare("SELECT * FROM __drizzle_migrations").all()).toEqual(journal);
        expect(second.connection.prepare("SELECT reserved_through FROM session_event_sequence").get()).toEqual({ reserved_through: 42 });
      } finally { second.close(); }
    });
    const directory = new URL("../session-runtime/migrations/", import.meta.url);
    const sqlFiles = readdirSync(directory).filter((name) => name.endsWith(".sql")).sort();
    expect(sqlFiles).toEqual([
      "0000_current_schema.sql",
      "0001_drop_application_storage_format.sql",
      "0002_temporary_resource_sources.sql",
      "0003_global_notes.sql",
      "0004_note_organization.sql",
      "0005_note_attachments.sql",
      "0006_note_file_index.sql",
      "0007_goal_simplification.sql",
      "0008_session_plugin_apps.sql",
    ]);
    const journal = JSON.parse(readFileSync(new URL("meta/_journal.json", directory), "utf8"));
    expect(journal.entries.map((entry: { tag: string }) => entry.tag).sort()).toEqual([
      "0000_current_schema",
      "0001_drop_application_storage_format",
      "0002_temporary_resource_sources",
      "0003_global_notes",
      "0004_note_organization",
      "0005_note_attachments",
      "0006_note_file_index",
      "0007_goal_simplification",
      "0008_session_plugin_apps",
    ]);
  });

  it("creates parent directories before opening the SQLite file", () => {
    const directory = mkdtempSync(join(tmpdir(), "vk-session-database-parent-"));
    const path = join(directory, "nested", "sessions.db");
    try {
      const database = SessionDatabase.open({ path });
      expect(database.path).toBe(resolve(path));
      database.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
