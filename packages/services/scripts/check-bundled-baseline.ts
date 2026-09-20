/// <reference types="bun" />
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

// Exercise the same relative asset layouts as the CLI and Desktop without loading providers.
const servicesRoot = resolve(import.meta.dir, "..");
const source = join(servicesRoot, "src/session-runtime/migrations");
const directory = mkdtempSync(join(servicesRoot, ".baseline-bundle-"));
try {
  for (const layout of ["cli", "desktop"] as const) {
    const output = join(directory, layout, layout === "desktop" ? "main" : "dist");
    const assets = layout === "desktop"
      ? resolve(output, "../session-runtime/migrations")
      : join(output, "migrations");
    const result = await Bun.build({
      entrypoints: [join(servicesRoot, "src/database/session-database.ts")],
      outdir: output,
      naming: "index.js",
      target: "node",
      format: "esm",
      packages: "external",
    });
    assert.equal(result.success, true, result.logs.map(String).join("\n"));
    cpSync(source, assets, { recursive: true });
    const sqlFiles = readdirSync(source).filter((file) => file.endsWith(".sql")).sort();
    assert.deepEqual(readdirSync(assets).filter((file) => file.endsWith(".sql")).sort(), sqlFiles);
    for (const file of sqlFiles) {
      assert.equal(readFileSync(join(assets, file), "utf8"), readFileSync(join(source, file), "utf8"));
    }
    const journalEntries = JSON.parse(readFileSync(join(assets, "meta/_journal.json"), "utf8")).entries;
    assert.equal(journalEntries.length, sqlFiles.length);
    const moduleUrl = pathToFileURL(join(output, "index.js")).href;
    const path = join(directory, layout, "empty.db");
    const code = `
      const assert = require("node:assert/strict");
      (async () => {
        const { SessionDatabase } = await import(${JSON.stringify(moduleUrl)});
        for (let i = 0; i < 2; i++) {
          const db = SessionDatabase.open({ path: ${JSON.stringify(path)} });
          assert.equal(db.connection.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != '__drizzle_migrations'").get().n, 31);
          assert.equal(db.connection.prepare("SELECT count(*) AS n FROM __drizzle_migrations").get().n, 2);
          db.close();
        }
      })().catch(error => { console.error(error); process.exitCode = 1; });
    `;
    const run = spawnSync("node", ["-e", code], { cwd: servicesRoot, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr || String(run.error));
    console.log(`${layout}: bundled empty database and reopen passed; migration chain applied`);
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
