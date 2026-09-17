import assert from "node:assert/strict"
import test from "node:test"

import {
  validateMigrationInventory,
  verifyPlatformInventories,
} from "./verify-migration-artifact.mjs"

const migrations = [
  { path: "0000_current_schema.sql", sha256: "a".repeat(64) },
  { path: "meta/0000_snapshot.json", sha256: "b".repeat(64) },
  { path: "meta/_journal.json", sha256: "c".repeat(64) },
]

test("accepts Windows and Linux inventories extracted from matching packaged apps", () => {
  const win = inventory("win")
  const linux = inventory("linux")

  assert.deepEqual(validateMigrationInventory(win), win)
  assert.deepEqual(verifyPlatformInventories([win, linux]), { win, linux })
})

test("rejects a packaged app with a missing or legacy migration", () => {
  assert.throws(
    () => validateMigrationInventory(inventory("win", migrations.slice(1))),
    /migration inventory must contain exactly/
  )
  assert.throws(
    () =>
      validateMigrationInventory(
        inventory("win", [...migrations, { path: "0001_legacy.sql", sha256: "d".repeat(64) }])
      ),
    /0001_legacy\.sql/
  )
})

test("rejects platform packages whose migration bytes differ", () => {
  const linuxMigrations = migrations.map((entry) =>
    entry.path === "0000_current_schema.sql" ? { ...entry, sha256: "e".repeat(64) } : entry
  )
  assert.throws(
    () => verifyPlatformInventories([inventory("win"), inventory("linux", linuxMigrations)]),
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
