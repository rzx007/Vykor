import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDaemonSystemService } from "../daemon-system-service.js";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "daemon-root-invocation-")); });
afterEach(() => { vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });
it.each(["win32", "linux", "darwin"] as const)("pins the selected root in %s system service restarts", platform => {
  const dataRoot = join(home, "selected data");
  vi.stubEnv("VYKOR_CONFIG_DIR", dataRoot);
  const invocation = createDaemonSystemService(join(home, "index.js"), ["serve", "--register"], {
    platform, homeDir: home, execPath: process.execPath, bunRuntime: false, logsDir: join(home, "logs"),
  }).invocation();
  expect(invocation.args.slice(1, 3)).toEqual(["--data-root", dataRoot]);
  expect(invocation.args.slice(3)).toEqual(platform === "win32" ? ["daemon", "watchdog", "serve", "--register"] : ["serve", "--register", "--supervised"]);
});
