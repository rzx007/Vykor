import { spawn } from "node:child_process"
import { createRequire } from "node:module"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const require = createRequire(import.meta.url)
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const profile = mkdtempSync(join(tmpdir(), "vykor-annotations-"))
const env = { ...process.env, VYKOR_ANNOTATION_ROOT: root, VYKOR_ANNOTATION_PROFILE: profile }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(require("electron"), ["--user-data-dir=" + profile, resolve(root, "../../.superpowers/browser-annotations/main/main.cjs")], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
let output = "", errors = ""
child.stdout.on("data", data => { output += data; process.stdout.write(data) })
child.stderr.on("data", data => { errors += data })
const deadline = setTimeout(() => child.kill(), 60_000)
child.on("error", error => { console.error(error); process.exitCode = 1 })
child.on("close", code => {
  clearTimeout(deadline)
  const passed = output.split(/\r?\n/).some(line => { try { return JSON.parse(line).result === "passed" } catch { return false } })
  if (!passed || code !== 0) process.stderr.write(errors)
  process.exitCode = code === 0 && passed ? 0 : 1
  // Only delete the test profile created above, never the application's real profile.
  if (dirname(resolve(profile)) === resolve(tmpdir()) && profile.includes("vykor-annotations-")) rmSync(profile, { recursive: true, force: true })
})
