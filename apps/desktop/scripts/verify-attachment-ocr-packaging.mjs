/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { access, readdir, readFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const workspaceRoot = resolve(desktopRoot, "../..")
const packageJson = JSON.parse(await readFile(join(desktopRoot, "package.json"), "utf8"))
const builder = await readFile(join(desktopRoot, "electron-builder.yml"), "utf8")
const lock = await readFile(join(workspaceRoot, "pnpm-lock.yaml"), "utf8")
const catalog = await readFile(join(workspaceRoot, "pnpm-workspace.yaml"), "utf8")
const verifyArtifact = process.argv.includes("--artifact")

const failures = []
for (const [name, version] of [
  ["@arcships/light-ocr", "0.5.7"],
  ["sharp", "0.34.4"],
]) {
  const declared = packageJson.dependencies?.[name]
  if (declared === "catalog:") {
    if (catalogVersion(name) !== version)
      failures.push(`${name}@${version} must be pinned in the workspace catalog`)
    continue
  }
  if (declared !== version)
    failures.push(`${name}@${version} must be a Desktop production dependency`)
}
for (const marker of [
  "node_modules/@arcships/light-ocr/**",
  "node_modules/@arcships/light-ocr-model-*/**",
  "node_modules/@arcships/light-ocr-runtime/**",
  "node_modules/@arcships/light-ocr-win32-*/**",
  "node_modules/@arcships/light-ocr-linux-*/**",
  "node_modules/@arcships/light-ocr-darwin-*/**",
  "node_modules/@img/**",
  "node_modules/sharp/**",
]) {
  if (!builder.includes(marker)) failures.push(`asarUnpack is missing ${marker}`)
}
for (const marker of [
  "'@arcships/light-ocr@0.5.7'",
  "'@arcships/light-ocr-runtime@0.1.7'",
  "'@arcships/light-ocr-model-ppocrv6-small@0.3.4'",
  "'@arcships/light-ocr-darwin-arm64@0.5.7'",
  "'@arcships/light-ocr-darwin-x64@0.5.7'",
  "'@arcships/light-ocr-linux-arm64-gnu@0.5.7'",
  "'@arcships/light-ocr-linux-x64-gnu@0.5.7'",
  "'@arcships/light-ocr-win32-arm64@0.5.7'",
  "'@arcships/light-ocr-win32-x64@0.5.7'",
  "sharp@0.34.4",
]) {
  if (!lock.includes(marker)) failures.push(`lockfile is missing ${marker}`)
}
for (const path of [
  "packages/services/node_modules/@arcships/light-ocr/LICENSE",
  "packages/services/node_modules/@arcships/light-ocr/NOTICE",
  "packages/services/node_modules/sharp/LICENSE",
]) {
  try {
    await access(join(workspaceRoot, path))
  } catch {
    failures.push(`installed package is missing ${path}`)
  }
}
if (verifyArtifact) await verifyUnpackedArtifact(failures)

if (failures.length > 0) {
  process.stderr.write(`${failures.map((item) => `- ${item}`).join("\n")}\n`)
  process.exitCode = 1
} else {
  process.stdout.write(
    `Attachment OCR packaging closure${verifyArtifact ? " and unpacked artifact" : ""} verified.\n`
  )
}

async function verifyUnpackedArtifact(output) {
  const modules = await resolveUnpackedModules()
  if (!modules) {
    output.push("unpacked Desktop artifact was not found; run build:unpack first")
    return
  }
  for (const relative of [
    "@arcships/light-ocr/package.json",
    "@arcships/light-ocr/LICENSE",
    "@arcships/light-ocr/NOTICE",
    "@arcships/light-ocr-runtime/package.json",
    "@arcships/light-ocr-runtime/LICENSE",
    "@arcships/light-ocr-runtime/NOTICE",
    "@arcships/light-ocr-model-ppocrv6-small/bundle/manifest.json",
    "@arcships/light-ocr-model-ppocrv6-small/LICENSE",
    "@arcships/light-ocr-model-ppocrv6-small/NOTICE",
    "sharp/package.json",
    "sharp/LICENSE",
  ]) {
    try {
      await access(join(modules, relative))
    } catch {
      output.push(`unpacked artifact is missing ${relative}`)
    }
  }
  for (const relative of [ocrNativePackage(), sharpNativePackage()]) {
    const root = join(modules, relative)
    try {
      if (!(await containsNativeAddon(root)))
        output.push(`unpacked artifact has no native addon under ${relative}`)
    } catch {
      output.push(`unpacked artifact is missing ${relative}`)
    }
  }
  for (const relative of [`${ocrNativePackage()}/LICENSE`, `${ocrNativePackage()}/NOTICE`]) {
    try {
      await access(join(modules, relative))
    } catch {
      output.push(`unpacked artifact is missing ${relative}`)
    }
  }
}

async function resolveUnpackedModules() {
  return await findUnpackedModules(join(desktopRoot, "dist"))
}

async function findUnpackedModules(directory) {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return undefined
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const child = join(directory, entry.name)
    if (
      entry.name === "node_modules" &&
      directory.endsWith(join("resources", "app.asar.unpacked"))
    ) {
      return child
    }
    const found = await findUnpackedModules(child)
    if (found) return found
  }
  return undefined
}

function catalogVersion(name) {
  const match = new RegExp(`^\\s+'${name}':\\s*(\\S+)\\s*$`, "m").exec(catalog)
  return match?.[1]
}

function ocrNativePackage() {
  const arch = process.arch === "arm64" ? "arm64" : "x64"
  if (process.platform === "win32") return `@arcships/light-ocr-win32-${arch}`
  if (process.platform === "darwin") return `@arcships/light-ocr-darwin-${arch}`
  return `@arcships/light-ocr-linux-${arch}-gnu`
}

function sharpNativePackage() {
  const arch = process.arch === "arm64" ? "arm64" : "x64"
  if (process.platform === "win32") return `@img/sharp-win32-${arch}`
  if (process.platform === "darwin") return `@img/sharp-darwin-${arch}`
  return `@img/sharp-linux-${arch}`
}

async function containsNativeAddon(root) {
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".node")) return true
  }
  return false
}
