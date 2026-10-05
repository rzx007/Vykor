import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import Database from "better-sqlite3";

// Regenerate the test inventory from the complete migration chain, never a live user database.
const database = new Database(":memory:");
try {
  const directory = new URL("../src/session-runtime/migrations/", import.meta.url);
  for (const file of readdirSync(directory).filter((file) => file.endsWith(".sql")).sort()) {
    database.exec(readFileSync(new URL(file, directory), "utf8"));
  }
  const schema = database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE ? AND name != ? ORDER BY type,name").all("sqlite_%", "__drizzle_migrations");
  const tables = schema.filter((row) => row.type === "table").map((row) => ({ name: row.name, columns: database.pragma(`table_info(${JSON.stringify(row.name)})`), foreignKeys: database.pragma(`foreign_key_list(${JSON.stringify(row.name)})`) }));
  writeFileSync(new URL("../src/database/__fixtures__/current-schema-inventory.json", import.meta.url), JSON.stringify({ schema, tables }, null, 2) + "\n");
} finally { database.close(); }
