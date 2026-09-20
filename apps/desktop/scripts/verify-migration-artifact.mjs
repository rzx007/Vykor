import { createHash } from "node:crypto"
import { readdirSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const sha256Pattern = /^[0-9a-f]{64}$/

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

export function validateMigrationInventory(value, expectedPaths) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("migration inventory must be an object")
  }
  if (value.version !== 1)
    throw new Error(`unsupported migration inventory version: ${String(value.version)}`)
  if (value.platform !== "win" && value.platform !== "linux") {
    throw new Error(`unsupported migration inventory platform: ${String(value.platform)}`)
  }
  if (typeof value.archiveSha256 !== "string" || !sha256Pattern.test(value.archiveSha256)) {
    throw new Error("migration inventory requires a lowercase SHA-256 app.asar hash")
  }
  if (!Array.isArray(value.migrations)) throw new Error("migration inventory requires migrations")

  const actualPaths = value.migrations.map((entry) => entry?.path).sort()
  if (JSON.stringify(actualPaths) !== JSON.stringify([...expectedPaths].sort())) {
    throw new Error(
      `migration inventory must contain exactly [${[...expectedPaths].sort().join(", ")}]; found [${actualPaths.join(", ")}]`
    )
  }
  for (const entry of value.migrations) {
    if (typeof entry.sha256 !== "string" || !sha256Pattern.test(entry.sha256)) {
      throw new Error(`migration ${String(entry.path)} requires a lowercase SHA-256 hash`)
    }
  }
  return value
}

export function verifyPlatformInventories(values, expectedPaths) {
  const entries = values.map((value) => validateMigrationInventory(value, expectedPaths))
  const byPlatform = Object.fromEntries(entries.map((entry) => [entry.platform, entry]))
  if (entries.length !== 2 || !byPlatform.win || !byPlatform.linux) {
    throw new Error("exactly one Windows and one Linux migration inventory are required")
  }
  const winHashes = Object.fromEntries(
    byPlatform.win.migrations.map((entry) => [entry.path, entry.sha256])
  )
  const linuxHashes = Object.fromEntries(
    byPlatform.linux.migrations.map((entry) => [entry.path, entry.sha256])
  )
  if (JSON.stringify(winHashes) !== JSON.stringify(linuxHashes)) {
    throw new Error("Windows and Linux packaged migration hashes differ")
  }
  return { win: byPlatform.win, linux: byPlatform.linux }
}

export async function writePackagedMigrationInventory(platform, expectedPaths) {
  if (platform !== "win" && platform !== "linux") {
    throw new Error(`expected platform win or linux, received ${String(platform)}`)
  }
  const unpacked = platform === "win" ? "win-unpacked" : "linux-unpacked"
  const archive = join(desktopRoot, "dist", unpacked, "resources", "app.asar")
  const { extractFile, listPackage, statFile } = await import("@electron/asar")
  const prefix = "out/session-runtime/migrations/"
  const packagedFiles = listPackage(archive)
    .map((archivePath) => ({
      archivePath,
      archiveKey: archivePath.replace(/^[/\\]+/, ""),
      normalizedPath: archivePath.replaceAll("\\", "/").replace(/^\/+/, ""),
    }))
    .filter((entry) => entry.normalizedPath.startsWith(prefix))
    .filter((entry) => {
      const stat = statFile(archive, entry.archiveKey)
      return !stat.files && !stat.link
    })
    .map((entry) => ({ ...entry, path: entry.normalizedPath.slice(prefix.length) }))
    .filter((entry) => entry.path)
    .sort((left, right) => left.path.localeCompare(right.path))
  const migrations = packagedFiles.map(({ archiveKey, path }) => ({
    path,
    sha256: sha256(extractFile(archive, archiveKey)),
  }))
  const inventory = validateMigrationInventory(
    {
      version: 1,
      platform,
      archiveSha256: sha256(await readFile(archive)),
      migrations,
    },
    expectedPaths
  )
  const output = join(desktopRoot, "dist", `clean-slate-migrations-${platform}.json`)
  await writeFile(output, `${JSON.stringify(inventory, null, 2)}\n`, "utf8")
  return output
}

async function main() {
  const [command, ...args] = process.argv.slice(2)
  const sourceMigrations = resolve(
    desktopRoot,
    "../../packages/services/src/session-runtime/migrations"
  )
  const expected = expectedMigrationPaths(sourceMigrations)
  if (command === "--write-inventory" && args.length === 1) {
    const output = await writePackagedMigrationInventory(args[0], expected)
    process.stdout.write(`Wrote packaged migration inventory: ${output}\n`)
    return
  }
  if (command === "--verify-inventories" && args.length === 2) {
    const inventories = await Promise.all(
      args.map(async (path) => JSON.parse(await readFile(resolve(path), "utf8")))
    )
    verifyPlatformInventories(inventories, expected)
    process.stdout.write("Windows and Linux packaged migration inventories verified.\n")
    return
  }
  throw new Error(
    "usage: verify-migration-artifact.mjs --write-inventory <win|linux> | --verify-inventories <win.json> <linux.json>"
  )
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex")
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}
