/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { access, readdir, readFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const packageJson = JSON.parse(await readFile(join(desktopRoot, "package.json"), "utf8"))
const builder = await readFile(join(desktopRoot, "electron-builder.yml"), "utf8")
const viteConfig = await readFile(join(desktopRoot, "electron.vite.config.ts"), "utf8")
const verifyArtifact = process.argv.includes("--artifact")
const verifyBuild = process.argv.includes("--build")

const failures = []

for (const name of ["electron-updater", "electron-log"]) {
  if (!packageJson.dependencies?.[name]) {
    failures.push(`${name} must be a Desktop production dependency`)
  }
  if (packageJson.devDependencies?.[name]) {
    failures.push(`${name} must not remain a Desktop development dependency`)
  }
}

for (const name of Object.keys(packageJson.dependencies ?? {})) {
  if (name.startsWith("@openharness/")) {
    failures.push(
      `${name} must not be a Desktop production dependency (bundle workspace packages; see docs/packaging.md)`,
    )
  }
}

for (const marker of [
  "provider: github",
  "owner: rzx007",
  "repo: openharness-ts",
  "- AppImage",
  "- deb",
]) {
  if (!builder.includes(marker)) failures.push(`electron-builder.yml is missing ${marker}`)
}
const linuxSection = builder.slice(builder.indexOf("\nlinux:"))
if (!linuxSection.includes("executableName: OpenHarness")) {
  failures.push("electron-builder.yml must set linux.executableName to OpenHarness")
}
if (builder.includes("- snap")) failures.push("electron-builder.yml should not publish snap")
if (builder.includes("example.com")) {
  failures.push("electron-builder.yml still points updater traffic at a placeholder URL")
}
if (!viteConfig.includes('"electron-updater"') || !viteConfig.includes('"electron-log"')) {
  failures.push("electron.vite.config.ts must keep electron-updater and electron-log external")
}

if (verifyBuild) {
  try {
    await access(join(desktopRoot, "out", "main", "host-entry.mjs"))
  } catch {
    failures.push("Desktop main build is missing host-entry.mjs")
  }
  try {
    await access(join(desktopRoot, "out", "session-runtime", "migrations", "meta", "_journal.json"))
  } catch {
    failures.push("Desktop main build is missing session-runtime migrations")
  }
}

if (verifyArtifact) await verifyUpdateArtifacts(failures)

if (failures.length > 0) {
  process.stderr.write(`${failures.map((item) => `- ${item}`).join("\n")}\n`)
  process.exitCode = 1
} else {
  process.stdout.write(
    `Desktop update packaging${verifyArtifact ? " and artifacts" : ""} verified.\n`
  )
}

async function verifyUpdateArtifacts(output) {
  const dist = join(desktopRoot, "dist")
  let names
  try {
    names = await readdir(dist)
  } catch {
    output.push("desktop dist/ was not found; run build:win or build:linux first")
    return
  }

  const manifestName = process.platform === "win32" ? "latest.yml" : "latest-linux.yml"
  if (!names.includes(manifestName)) {
    output.push(`missing updater manifest ${manifestName}`)
    return
  }

  const manifest = await readFile(join(dist, manifestName), "utf8")
  const referenced = [...manifest.matchAll(/^\s*path:\s*(.+)\s*$/gm)].map((match) =>
    match[1].trim().replace(/^['"]|['"]$/g, "")
  )
  if (referenced.length === 0) {
    output.push(`${manifestName} does not reference any update files`)
    return
  }

  for (const fileName of referenced) {
    try {
      await access(join(dist, fileName))
    } catch {
      output.push(`${manifestName} references missing file ${fileName}`)
    }
  }
}
