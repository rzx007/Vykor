import { spawn } from "node:child_process"
import { createRequire } from "node:module"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const profile = mkdtempSync(join(tmpdir(), "vykor-transcript-"))
const env = { ...process.env, VYKOR_TRANSCRIPT_PROFILE: profile }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(
  createRequire(import.meta.url)("electron"),
  [
    "--user-data-dir=" + profile,
    resolve(root, "../../.superpowers/transcript-performance/main/main.cjs"),
  ],
  { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }
)
let output = "",
  errors = ""
child.stdout.on("data", (data) => {
  output += data
  process.stdout.write(data)
})
child.stderr.on("data", (data) => {
  errors += data
})
const deadline = setTimeout(() => child.kill(), 125_000)
child.on("error", (error) => {
  console.error(error)
  process.exitCode = 1
})
child.on("close", (code) => {
  clearTimeout(deadline)
  const passed = output.split(/\r?\n/).some((line) => {
    try {
      return JSON.parse(line).result === "passed"
    } catch {
      return false
    }
  })
  if (!passed || code !== 0) process.stderr.write(errors)
  process.exitCode = code === 0 && passed ? 0 : 1
  if (
    dirname(resolve(profile)) === resolve(tmpdir()) &&
    profile.startsWith(join(tmpdir(), "vykor-transcript-"))
  )
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } catch (error) {
      console.error("Test profile cleanup failed:", error.message)
    }
})
