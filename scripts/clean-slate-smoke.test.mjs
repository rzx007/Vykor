import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { runCleanSlateSmoke, validateSmokeInputs } from "./clean-slate-smoke.mjs";

function fixturePaths() {
  const tempRoot = mkdtempSync(join(tmpdir(), "openharness-clean-slate-test-"));
  return {
    tempRoot,
    configDir: join(tempRoot, "config"),
    projectDir: join(tempRoot, "project"),
    desktopUserDataDir: join(tempRoot, "desktop-user-data"),
  };
}

test("rejects protected paths and non-loopback providers before starting anything", async () => {
  let started = 0;
  const paths = fixturePaths();
  const runtime = { startFakeProvider: async () => { started += 1; } };
  try {
    await assert.rejects(
      runCleanSlateSmoke({ ...paths, configDir: homedir(), providerUrl: "http://127.0.0.1:1" }, runtime),
      /protected path/i,
    );
    await assert.rejects(
      runCleanSlateSmoke({ ...paths, providerUrl: "https://provider.example/v1" }, runtime),
      /loopback/i,
    );
    assert.equal(started, 0);
  } finally {
    rmSync(paths.tempRoot, { recursive: true, force: true });
  }
});

test("runs the fixed empty-environment sequence and always cleans resources", async () => {
  const paths = fixturePaths();
  const events = [];
  let daemonOpen = false;
  let providerOpen = false;
  const runtime = {
    async startFakeProvider() {
      events.push("provider:start");
      providerOpen = true;
      return { url: "http://127.0.0.1:41234/v1", close: async () => { events.push("provider:close"); providerOpen = false; } };
    },
    async startDaemon(context) {
      events.push("daemon:start");
      assert.ok(context.storePath.startsWith(resolve(paths.desktopUserDataDir)));
      daemonOpen = true;
      return { url: "http://127.0.0.1:42345", close: async () => { events.push("daemon:close"); daemonOpen = false; } };
    },
    async waitForHealth() { events.push("health"); },
    async createClient() {
      return {
        async capabilities() { events.push("capabilities:4"); return { protocol: { version: 4 } }; },
        async createSession() { events.push("session"); return { id: "session-1" }; },
        async admitPrompt() { events.push("prompt"); return { run: { id: "run-1" } }; },
        async waitForRun() { events.push("run"); return { id: "run-1", status: "completed" }; },
        async getState() { events.push("state"); return { session: { status: "idle" } }; },
      };
    },
    async runCliProbe() { events.push("cli"); },
    async verifyDesktopUserData() { events.push("desktop"); },
    async assertReleased() { events.push("released"); assert.equal(daemonOpen, false); assert.equal(providerOpen, false); },
  };

  const result = await runCleanSlateSmoke({ ...paths, providerUrl: "http://127.0.0.1:0/v1" }, runtime);
  assert.deepEqual(events, [
    "provider:start", "daemon:start", "health", "capabilities:4", "session", "prompt",
    "run", "state", "cli", "desktop", "daemon:close", "provider:close", "released",
  ]);
  assert.equal(result.protocolVersion, 4);
  assert.equal(result.sessionId, "session-1");
  assert.equal(result.runId, "run-1");
  assert.equal(existsSync(paths.tempRoot), false);
});

test("closes provider, daemon and temporary root after a failed run", async () => {
  const paths = fixturePaths();
  const closed = [];
  const runtime = {
    async startFakeProvider() {
      return { url: "http://[::1]:41234/v1", close: async () => closed.push("provider") };
    },
    async startDaemon() {
      return { url: "http://localhost:42345", close: async () => closed.push("daemon") };
    },
    async waitForHealth() { throw new Error("health failed"); },
  };
  await assert.rejects(
    runCleanSlateSmoke({ ...paths, providerUrl: "http://[::1]:0/v1" }, runtime),
    /health failed/,
  );
  assert.deepEqual(closed, ["daemon", "provider"]);
  assert.equal(existsSync(paths.tempRoot), false);
});

test("path validation requires all writable locations below the declared temporary root", () => {
  const paths = fixturePaths();
  try {
    assert.throws(
      () => validateSmokeInputs({ ...paths, projectDir: resolve(paths.tempRoot, "..", "escape"), providerUrl: "http://localhost:1" }),
      /temporary root/i,
    );
    assert.throws(
      () => validateSmokeInputs({
        tempRoot: process.cwd(),
        configDir: join(process.cwd(), "config"),
        projectDir: join(process.cwd(), "project"),
        desktopUserDataDir: join(process.cwd(), "desktop"),
        providerUrl: "http://localhost:1",
      }),
      /temporary root|protected path/i,
    );
  } finally {
    rmSync(paths.tempRoot, { recursive: true, force: true });
  }
});
