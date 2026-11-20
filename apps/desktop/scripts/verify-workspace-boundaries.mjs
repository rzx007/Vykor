import { readFile, readdir } from "node:fs/promises"
import { dirname, extname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const sourceRoot = join(desktopRoot, "src")
const adminImports = ["configuration", "knowledge", "workspace", "channels", "mcp", "plugins"]
  .map((name) => `@vykor/daemon-admin/${name}`)
const mainOnlyImports = new Set([
  ...adminImports,
  "@rzx/client/service",
  "@vykor/server",
  "@vykor/server/daemon-host",
  "@vykor/server/migration-validation",
  "@vykor/services/notes",
  "@vykor/host-config/paths",
])
const allowedImports = new Set([
  ...mainOnlyImports,
  "@rzx/client",
  "@vykor/protocol",
])
const allowedPackageDependencies = new Set([
  "@rzx/client",
  "@vykor/daemon-admin",
  "@vykor/host-config",
  "@vykor/protocol",
  "@vykor/server",
  "@vykor/services",
])
const importPattern =
  /(?:from\s*|import\s*(?:\(\s*)?|require\s*\(\s*)["'](@vykor\/[^"']+|@rzx\/client(?:\/[^"']*)?)["']/g

export function validateDesktopWorkspaceImport(file, specifier) {
  if (!allowedImports.has(specifier)) {
    return `Desktop workspace import is not allowed: ${specifier} (${file})`
  }
  const normalized = file.replaceAll("\\", "/")
  if (mainOnlyImports.has(specifier) && !normalized.startsWith("src/main/")) {
    return `Desktop local service import is only allowed in main: ${specifier} (${file})`
  }
  return null
}

const failures = []
for (const specifier of ["@vykor/application-client", "@vykor/application-client/service"]) {
  if (!validateDesktopWorkspaceImport("src/main/demo.ts", specifier) || allowedPackageDependencies.has(specifier)) {
    failures.push(`Boundary verifier must reject the retired application client: ${specifier}`)
  }
}
const clientInternalImport = [...'import { x } from "@rzx/client/internal"'.matchAll(importPattern)][0]
if (!clientInternalImport || !validateDesktopWorkspaceImport("src/renderer/demo.ts", clientInternalImport[1])) {
  failures.push("Boundary verifier must detect and reject unknown client subpaths")
}
if (!validateDesktopWorkspaceImport("src/main/demo.ts", "@vykor/core")) {
  failures.push("Boundary verifier must reject @vykor/core")
}
if (validateDesktopWorkspaceImport("src/main/demo.ts", "@vykor/server/daemon-host")) {
  failures.push("Boundary verifier must allow daemon-host in main")
}
if (!validateDesktopWorkspaceImport("src/renderer/demo.ts", "@vykor/server")) {
  failures.push("Boundary verifier must reject server in renderer")
}
if (!validateDesktopWorkspaceImport("src/shared/demo.ts", "@vykor/server/daemon-host")) {
  failures.push("Boundary verifier must reject daemon-host outside main")
}
if (!validateDesktopWorkspaceImport("src/main/demo.ts", "@vykor/server/internal")) {
  failures.push("Boundary verifier must reject unknown server subpaths")
}
const packageJson = JSON.parse(await readFile(join(desktopRoot, "package.json"), "utf8"))
for (const section of [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
]) {
  for (const name of Object.keys(packageJson[section] ?? {})) {
    if ((name.startsWith("@vykor/") || name === "@rzx/client") && !allowedPackageDependencies.has(name)) {
      failures.push(`Desktop package dependency is not allowed: ${name} (${section})`)
    }
  }
}

for (const file of await sourceFiles(sourceRoot)) {
  const content = await readFile(file, "utf8")
  for (const match of content.matchAll(importPattern)) {
    const failure = validateDesktopWorkspaceImport(relative(desktopRoot, file), match[1])
    if (failure) failures.push(failure)
  }
}

if (failures.length > 0) {
  process.stderr.write(`${failures.map((failure) => `- ${failure}`).join("\n")}\n`)
  process.exitCode = 1
} else {
  process.stdout.write("Desktop workspace dependency boundaries verified.\n")
}

async function sourceFiles(directory) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await sourceFiles(path)))
    else if ([".ts", ".tsx"].includes(extname(entry.name))) files.push(path)
  }
  return files
}
