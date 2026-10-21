import { spawn } from "node:child_process"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
const scratch = resolve(root, ".superpowers/sdd/2026-10-20-mcp-apps-resident-panels")
const executable =
  process.env.VYKOR_UI_TEST_ELECTRON ??
  resolve(root, ".superpowers/sdd/2026-10-03-native-plugin-ui-a3/electron-runtime/electron.exe")
if (!existsSync(executable))
  throw new Error("Prepare the existing cached Electron runtime before running UI tests")
const profile = mkdtempSync(join(tmpdir(), "vykor-plugin-apps-"))
const environment = {
  ...process.env,
  VYKOR_UI_TEST_PLUGIN_APPS_ONLY: "1",
  VYKOR_UI_TEST_ROOT: root,
  VYKOR_UI_TEST_NODE: process.execPath,
  VYKOR_UI_TEST_PROFILE: profile,
}
delete environment.ELECTRON_RUN_AS_NODE
const child = spawn(
  executable,
  ["--disable-gpu", "--user-data-dir=" + profile, resolve(scratch, "electron-build/main/main.cjs")],
  {
    env: environment,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  }
)
let stderr = ""
let stdout = ""
let timedOut = false
child.stdout.on("data", (chunk) => {
  stdout += chunk
  process.stdout.write(chunk)
})
child.stderr.on("data", (chunk) => {
  stderr += chunk
})
const timeout = setTimeout(() => {
  timedOut = true
  child.kill()
  process.exitCode = 2
}, 130_000)
child.on("error", (error) => {
  clearTimeout(timeout)
  console.error(error)
  process.exitCode = 1
})
child.on("close", (code) => {
  clearTimeout(timeout)
  writeFileSync(resolve(scratch, "phase-5-electron-stderr.log"), stderr)
  // Real negative IPC tests intentionally reject. Keep raw diagnostics, and only recognize
  // the exact failures whose effects/receipts are asserted by the resident App scenarios.
  const diagnosticBlocks = stderr.split(/(?=^Error occurred in handler|^Error:|^AssertionError)/m)
  const checkedStderr = true
    ? diagnosticBlocks.filter(block => !(
      /^Error occurred in handler for 'plugin-apps:prepareTool': Error: plugin_app_mount_closed\r?\n/.test(block)
      // Explicit post-cancel call is denied; an already-started refresh can finish after viewer release.
      || /^Error occurred in handler for 'plugin-apps:prepareTool': Error: plugin_app_tool_not_available\r?\n/.test(block)
      || /^Error occurred in handler for 'plugin-apps:refresh': Error: plugin_app_mount_closed\r?\n/.test(block)
      || /^Error occurred in handler for 'plugin-apps:invokeTool': VykorApiError: Vykor API request failed with 409\r?\n/.test(block)
        && block.includes("code: 'plugin_app_not_accepted'")
      || /^Error occurred in handler for 'plugin-apps:invokeTool': Error: test: accepted tool acknowledgement lost\r?\n/.test(block)
      || /^Error occurred in handler for 'plugin-apps:submitMessage': Error: test: accepted message acknowledgement lost\r?\n/.test(block)
      || /^Error occurred in handler for 'plugin-apps:close': VykorApiError: /.test(block) && block.includes("status: 409")
      // Stage 4 asserts an in-flight resource read denied after the app closes; no stale body escapes.
      || /^Error occurred in handler for 'plugin-apps:readResource': VykorApiError: 应用资源当前不可读\r?\n/.test(block)
        && block.includes("status: 409") && block.includes("body: { error: '应用资源当前不可读' }")
    ) || !block.split(/\r?\n/).every(line => !line || /^\s|^}\s*$|^Error occurred in handler/.test(line))).join("") : stderr
  // Expected only for this fixed opaque-origin data-URL attack in Electron 39.8.10.
  const unexpected = checkedStderr
    .split(/\r?\n/)
    .filter(
      (line) =>
        line.trim() &&
        !/^\[\d+:\d+\/[\d.]+:ERROR:content\\browser\\site_info\.cc:847\] Check failed: origin\.GetTupleOrPrecursorTupleIfOpaque\(\)\.IsValid\(\)\.\s*$/.test(
          line
        ) &&
        !/^\(node:\d+\) electron: Failed to load URL: data:text\/html,<script>window\.escaped=1<\/script> with error: ERR_BLOCKED_BY_CSP$/.test(
          line
        ) &&
        !/^\(Use .electron --trace-warnings \.\.\.. to show where the warning was created\)$/.test(
          line
        )
    )
  if (unexpected.length) process.stderr.write(unexpected.join("\n") + "\n")
  const passed = stdout.split(/\r?\n/).some((line) => {
    try {
      return JSON.parse(line).result === "passed"
    } catch {
      return false
    }
  })
  console.log(
    JSON.stringify({
      electronExitCode: code,
      timedOut,
      expectedEngineDiagnostics: stderr.split(/\r?\n/).filter(Boolean).length,
    })
  )
  process.exitCode = !timedOut && code === 0 && passed && unexpected.length === 0 ? 0 : 1
  if (
    dirname(resolve(profile)) === resolve(tmpdir()) &&
    profile.startsWith(join(tmpdir(), "vykor-plugin-apps-"))
  ) {
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } catch (error) {
      console.error("Test profile cleanup failed:", error.message)
      process.exitCode = 1
    }
  }
})
