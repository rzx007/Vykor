import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const scratch = resolve(root, ".superpowers/sdd/2026-10-03-native-plugin-ui-a3");
const executable = process.env.VYKOR_UI_TEST_ELECTRON ?? resolve(scratch, "electron-runtime/electron.exe");
if (!existsSync(executable)) throw new Error("Prepare the existing cached Electron runtime before running UI tests");
const environment = { ...process.env, VYKOR_UI_TEST_ROOT: root, VYKOR_UI_TEST_NODE: process.execPath };
delete environment.ELECTRON_RUN_AS_NODE;
const child = spawn(executable, ["--user-data-dir=" + resolve(scratch, "electron-profile"), resolve(scratch, "electron-build/main/main.cjs")], {
  env: environment, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
});
let stderr = "";
let stdout = "";
child.stdout.on("data", chunk => { stdout += chunk; process.stdout.write(chunk); });
child.stderr.on("data", chunk => { stderr += chunk; });
const timeout = setTimeout(() => { child.kill(); process.exitCode = 2; }, 90_000);
child.on("error", error => { clearTimeout(timeout); console.error(error); process.exitCode = 1; });
child.on("close", code => {
  clearTimeout(timeout);
  // Expected only for this fixed opaque-origin data-URL attack in Electron 39.8.10.
  const unexpected = stderr.split(/\r?\n/).filter(line => line.trim() &&
    !/^\[\d+:\d+\/[\d.]+:ERROR:content\\browser\\site_info\.cc:847\] Check failed: origin\.GetTupleOrPrecursorTupleIfOpaque\(\)\.IsValid\(\)\.\s*$/.test(line) &&
    !/^\(node:\d+\) electron: Failed to load URL: data:text\/html,<script>window\.escaped=1<\/script> with error: ERR_BLOCKED_BY_CSP$/.test(line) &&
    !/^\(Use .electron --trace-warnings \.\.\.. to show where the warning was created\)$/.test(line));
  if (unexpected.length) process.stderr.write(unexpected.join("\n") + "\n");
  const passed = stdout.split(/\r?\n/).some(line => {
    try { return JSON.parse(line).result === "passed"; } catch { return false; }
  });
  console.log(JSON.stringify({ electronExitCode: code, expectedEngineDiagnostics: stderr.split(/\r?\n/).filter(Boolean).length }));
  process.exitCode = code === 0 && passed && unexpected.length === 0 ? 0 : 1;
});
