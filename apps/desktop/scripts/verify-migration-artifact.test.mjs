import assert from "node:assert/strict"
import test from "node:test"

import {
  validateMigrationInventory,
  verifyPlatformInventories,
} from "./verify-migration-artifact.mjs"

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

test("accepts Windows and Linux inventories extracted from matching packaged apps", () => {
  const win = inventory("win")
  const linux = inventory("linux")

  assert.deepEqual(validateMigrationInventory(win, expected), win)
  assert.deepEqual(verifyPlatformInventories([win, linux], expected), { win, linux })
})

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

test("rejects platform packages whose migration bytes differ", () => {
  const linuxMigrations = migrations.map((entry) =>
    entry.path === "0000_current_schema.sql" ? { ...entry, sha256: "f".repeat(64) } : entry
  )
  assert.throws(
    () => verifyPlatformInventories([inventory("win"), inventory("linux", linuxMigrations)], expected),
    /migration hashes differ/
  )
})

function inventory(platform, entries = migrations) {
  return {
    version: 1,
    platform,
    archiveSha256: platform === "win" ? "1".repeat(64) : "2".repeat(64),
    migrations: entries,
  }
}
