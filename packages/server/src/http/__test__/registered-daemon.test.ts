import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { CURRENT_PROTOCOL_VERSION, PROTOCOL_VERSION_HEADER } from "@vykor/protocol";
import { SessionStore } from "@vykor/services";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readDaemonRegistry } from "../../daemon/paths.js";
import { startVykorDaemon } from "../../daemon/default-daemon.js";
import {
  runRegisteredDaemon,
  type RegisteredDaemonControl,
  type RegisteredDaemonOptions,
} from "../../daemon-host/registered-daemon.js";
import { withDaemonControlLock } from "../../daemon-host/registry-lease.js";

let root: string;
let base: string;
let target: string;
let targetStore: string;
let registry: string;
let state: string;
let stop: AbortController;
let run: Promise<void> | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "vk-registered-"));
  base = join(root, "data");
  target = join(root, "restored");
  targetStore = join(target, "sessions.db");
  registry = join(base, "daemon", "registry.json");
  state = join(base, "daemon", "data-location.json");
  await mkdir(target);
  await writeFile(targetStore, "SQLite format 3\0");
  stop = new AbortController();
  run = undefined;
});

afterEach(async () => {
  stop.abort();
  await run;
  await rm(root, { recursive: true, force: true });
});

function launch(overrides: Partial<RegisteredDaemonOptions> = {}) {
  let control: RegisteredDaemonControl | undefined;
  const opened: string[] = [];
  const closed: string[] = [];
  const activated: string[] = [];
  const start: NonNullable<RegisteredDaemonOptions["start"]> = async (options) => {
    control = options.registeredDaemonControl;
    const path = options.storePath!;
    opened.push(path);
    return {
      listen: { url: `http://127.0.0.1:${9000 + opened.length}` },
      server: {
        store: { path },
        close: async () => { closed.push(path); },
        application: { activateBackgroundWork: () => { activated.push(path); } },
      },
    };
  };
  run = runRegisteredDaemon({
    launcher: "cli",
    version: "0.1.0",
    baseDataDirectory: base,
    canSwitchData: async () => true,
    signal: stop.signal,
    start,
    ...overrides,
  });
  void run.catch(() => {});
  return { control: () => control!, opened, closed, activated, start };
}

function launchFixture(launcher: "desktop" | "cli") {
  const require = createRequire(import.meta.url);
  const requireFromVitest = createRequire(require.resolve("vitest/package.json"));
  const viteNode = requireFromVitest.resolve("vite-node/vite-node.mjs");
  const config = fileURLToPath(new URL("../../../../../vitest.config.ts", import.meta.url));
  const fixture = fileURLToPath(new URL("./registered-daemon-fixture.ts", import.meta.url));
  const child = spawn(process.execPath, [viteNode, "--config", config, fixture], {
    env: { ...process.env, VYKOR_TEST_LAUNCHER: launcher, VYKOR_TEST_BASE_DATA: base },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    windowsHide: true,
  });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const reported = new Promise<{
    launcher: "desktop" | "cli"; pid: number; ownerPid: number; sessionIds: string[]; eventSeq: number;
  }>((resolve, reject) => {
    child.once("message", (message) => resolve(message as Parameters<typeof resolve>[0]));
    child.once("error", reject);
    void exited.then(({ code, signal }) => reject(new Error(`${launcher} fixture exited (code=${code}, signal=${signal}): ${stderr}`)));
  });
  return {
    reported,
    async stop() {
      if (child.connected) child.send("stop", () => {});
      const exitedPromptly = await Promise.race([
        exited.then(() => true),
        sleep(10_000, false, { ref: false }),
      ]);
      if (!exitedPromptly) child.kill();
      const result = await exited;
      return { launcher, ...result, timedOut: !exitedPromptly, stderr };
    },
  };
}

describe("registered daemon", () => {
  it("keeps the registry in the base directory after importing a custom database", async () => {
    const legacyDataLocationPath = join(root, "runtime-data-location.json");
    await writeFile(legacyDataLocationPath, JSON.stringify({
      version: 1, location: { directory: target, storePath: targetStore },
    }));
    const { opened } = launch({ legacyDataLocationPath });
    await vi.waitFor(() => expect(readDaemonRegistry(registry)?.storePath).toBe(targetStore));
    expect(opened).toEqual([targetStore]);
    expect(JSON.parse(await readFile(state, "utf8")).location).toEqual({
      directory: target, storePath: targetStore,
    });
    expect(readDaemonRegistry(join(target, "daemon", "registry.json"))).toBeUndefined();
  });

  it("holds the fixed registry exclusively before opening a database", async () => {
    const { opened, start } = launch();
    await vi.waitFor(() => expect(readDaemonRegistry(registry)?.pid).toBe(process.pid));
    await expect(runRegisteredDaemon({
      launcher: "desktop", version: "0.1.0", baseDataDirectory: base, start,
    })).rejects.toThrow();
    expect(opened).toHaveLength(1);
  });

  it("shares one registered owner, session and event stream between desktop and CLI processes", async () => {
    const storePath = join(base, "session-runtime", "sessions.db");
    await mkdir(join(base, "session-runtime"), { recursive: true });
    const store = new SessionStore({ path: storePath });
    let eventSeq: number;
    try {
      const session = store.sessions.create({ id: "shared-session", cwd: root, model: "test" });
      const created = store.conversations.listEvents({ sessionId: session.id })
        .find(event => event.type === "session.created");
      if (!created) throw new Error("The seeded session did not produce a creation event.");
      eventSeq = created.seq;
    } finally {
      store.close();
    }

    const desktop = launchFixture("desktop");
    const cli = launchFixture("cli");
    let exits: Awaited<ReturnType<typeof desktop.stop>>[];
    try {
      const [desktopResult, cliResult] = await Promise.race([
        Promise.all([desktop.reported, cli.reported]),
        sleep(45_000, undefined, { ref: false }).then(() => { throw new Error("Daemon fixtures timed out."); }),
      ]);
      const owner = readDaemonRegistry(registry)!;
      expect(desktopResult.pid).not.toBe(cliResult.pid);
      expect(desktopResult.ownerPid).toBe(cliResult.ownerPid);
      expect([desktopResult.pid, cliResult.pid]).toContain(owner.pid);
      expect(owner.pid).toBe(desktopResult.ownerPid);
      expect(owner.launcher).toBe(owner.pid === desktopResult.pid ? "desktop" : "cli");
      expect(owner.storePath).toBe(storePath);
      expect(desktopResult.sessionIds).toEqual(["shared-session"]);
      expect(cliResult.sessionIds).toEqual(["shared-session"]);
      expect([desktopResult.eventSeq, cliResult.eventSeq]).toEqual([eventSeq, eventSeq]);
    } finally {
      exits = await Promise.all([desktop.stop(), cli.stop()]);
    }
    for (const exit of exits) {
      expect(exit, `${exit.launcher} fixture failed to exit cleanly: ${JSON.stringify(exit)}`).toMatchObject({
        code: 0, signal: null, timedOut: false,
      });
    }
    expect(readDaemonRegistry(registry)).toBeUndefined();
  }, 65_000);

  it("lets a system service wait for an already running on-demand daemon", async () => {
    const { opened, start } = launch();
    await vi.waitFor(() => expect(readDaemonRegistry(registry)?.supervised).toBe(false));
    const first = readDaemonRegistry(registry)!;
    const stopService = new AbortController();
    const service = runRegisteredDaemon({
      launcher: "desktop", supervised: true, version: "0.1.0", baseDataDirectory: base,
      signal: stopService.signal, start,
    });
    void service.catch(() => {});
    try {
      const stateBeforeRelease = await Promise.race([
        service.then(() => "exited", () => "failed"),
        sleep(100, "waiting"),
      ]);
      expect(stateBeforeRelease).toBe("waiting");
      expect(opened).toHaveLength(1);
      expect(readDaemonRegistry(registry)).toEqual(first);
      stop.abort();
      await run;
      await vi.waitFor(() => expect(readDaemonRegistry(registry)?.supervised).toBe(true), { timeout: 3_000 });
      expect(opened).toHaveLength(2);
    } finally {
      stopService.abort();
      await service;
    }
  });

  it("shares the lifecycle control lock with callers changing system service state", async () => {
    const { control, closed } = launch();
    await vi.waitFor(() => expect(readDaemonRegistry(registry)).toBeDefined());
    await withDaemonControlLock(async () => {
      await expect(control().requestSwitch(
        { directory: target, storePath: targetStore },
        async () => ({ close: async () => {}, release: () => {} }),
      )).rejects.toMatchObject({ status: 409 });
    }, registry);
    expect(closed).toEqual([]);
  });

  it("lets a detached service worker switch data once its OS service is disabled", async () => {
    const { control } = launch({ supervised: true, canSwitchData: async () => true });
    await vi.waitFor(() => expect(readDaemonRegistry(registry)?.supervised).toBe(true));
    const { id } = await control().requestSwitch(
      { directory: target, storePath: targetStore },
      async () => ({ close: async () => {}, release: () => {} }),
    );
    await vi.waitFor(() => expect(control().getSwitchResult(id)).toMatchObject({ status: "succeeded" }));
    expect(readDaemonRegistry(registry)?.storePath).toBe(targetStore);
  });

  it("still refuses a switch while the OS service is installed", async () => {
    const { control, closed } = launch({ supervised: true, canSwitchData: async () => false });
    await vi.waitFor(() => expect(readDaemonRegistry(registry)?.supervised).toBe(true));
    await expect(control().requestSwitch({ directory: target, storePath: targetStore }, async () => {
      throw new Error("reached the drain");
    })).rejects.toMatchObject({ status: 409 });
    expect(closed).toEqual([]);
  });

  it("rejects an active-work switch without closing or replacing the current registration", async () => {
    const { control, opened, closed } = launch();
    await vi.waitFor(() => expect(readDaemonRegistry(registry)).toBeDefined());
    const initial = readDaemonRegistry(registry);
    await expect(control().requestSwitch({ directory: target, storePath: targetStore }, async () => {
      throw new Error("work is active");
    })).rejects.toThrow("work is active");
    expect(closed).toEqual([]);
    expect(opened).toHaveLength(1);
    expect(readDaemonRegistry(registry)).toEqual(initial);
  });

  it("rejects a database outside the selected directory before draining the runtime", async () => {
    const { control, closed } = launch();
    await vi.waitFor(() => expect(readDaemonRegistry(registry)).toBeDefined());
    const outside = join(root, "outside.db");
    await writeFile(outside, "SQLite format 3\0");
    await expect(control().requestSwitch({ directory: target, storePath: outside }, async () => {
      throw new Error("reached the drain");
    })).rejects.toMatchObject({ status: 400 });
    expect(closed).toEqual([]);
  });

  it("reopens and republishes the previous database when the target fails to start", async () => {
    const entry = launch({
      async start(options) {
        if (options.storePath === targetStore) throw new Error("target failed");
        return entry.start(options);
      },
    });
    await vi.waitFor(() => expect(readDaemonRegistry(registry)).toBeDefined());
    const initial = readDaemonRegistry(registry)!;
    const { id } = await entry.control().requestSwitch(
      { directory: target, storePath: targetStore },
      async () => ({ close: async () => {}, release: () => {} }),
    );
    await vi.waitFor(() => expect(entry.control().getSwitchResult(id)).toMatchObject({
      status: "failed", error: "target failed",
    }));
    const reopened = readDaemonRegistry(registry)!;
    expect(reopened).toMatchObject({ pid: initial.pid, storePath: initial.storePath });
    expect(reopened.token).not.toBe(initial.token);
    expect(entry.closed).toEqual([initial.storePath]);
    expect(entry.activated).toEqual([initial.storePath, initial.storePath]);
  });

  it("commits the verified location before publishing a fresh endpoint in the same process", async () => {
    let allowTarget!: () => void;
    const targetReady = new Promise<void>((resolve) => { allowTarget = resolve; });
    const entry = launch({
      initialToken: "explicit-test-token",
      async start(options) {
        if (options.storePath === targetStore) await targetReady;
        return entry.start(options);
      },
    });
    await vi.waitFor(() => expect(readDaemonRegistry(registry)).toBeDefined());
    const initial = readDaemonRegistry(registry)!;
    expect(initial.token).toBe("explicit-test-token");
    const { id } = await entry.control().requestSwitch(
      { directory: target, storePath: targetStore },
      async () => ({ close: async () => {}, release: () => {} }),
    );
    try {
      await vi.waitFor(() => expect(entry.closed).toEqual([initial.storePath]));
      expect(readDaemonRegistry(registry)).toEqual(initial);
      expect(entry.control().getSwitchResult(id)).toMatchObject({ status: "pending" });
    } finally {
      allowTarget();
    }
    await vi.waitFor(() => expect(entry.control().getSwitchResult(id)).toMatchObject({ status: "succeeded" }));
    const reopened = readDaemonRegistry(registry)!;
    expect(reopened).toMatchObject({ pid: initial.pid, storePath: targetStore });
    expect(reopened.token).not.toBe(initial.token);
    expect(JSON.parse(await readFile(state, "utf8")).location).toEqual({
      directory: target, storePath: targetStore,
    });
    expect(entry.activated).toEqual([initial.storePath, targetStore]);
  });

  it("reports an interrupted transaction and starts from the last committed location", async () => {
    const committed = join(root, "committed");
    const storePath = join(committed, "custom.db");
    await mkdir(committed);
    await writeFile(storePath, "database fixture");
    await mkdir(join(base, "daemon"), { recursive: true });
    await writeFile(state, JSON.stringify({
      version: 1, location: { directory: committed, storePath },
      result: { id: "interrupted", status: "pending" },
    }));
    const { control } = launch();
    await vi.waitFor(() => expect(readDaemonRegistry(registry)?.storePath).toBe(storePath));
    expect(control().getSwitchResult("interrupted")).toMatchObject({ status: "interrupted" });
  });

  it("closes an opening runtime without publishing it when shutdown arrives", async () => {
    let allowOpen!: () => void;
    const waitToOpen = new Promise<void>((resolve) => { allowOpen = resolve; });
    let markOpening!: () => void;
    const opening = new Promise<void>((resolve) => { markOpening = resolve; });
    const entry = launch({
      async start(options) {
        markOpening();
        await waitToOpen;
        return entry.start(options);
      },
    });
    await opening;
    stop.abort();
    allowOpen();
    await run;
    expect(readDaemonRegistry(registry)).toBeUndefined();
    expect(entry.closed).toEqual(entry.opened);
    expect(entry.activated).toEqual([]);
  });

  it("skips startup when the watchdog worker no longer has permission to open", async () => {
    const entry = launch({
      shouldStart: async () => false,
      async start(options) {
        stop.abort();
        return await entry.start(options);
      },
    });
    await run;
    expect(entry.opened).toEqual([]);
    expect(readDaemonRegistry(registry)).toBeUndefined();
  });

  it("closes the opened runtime if the watchdog is disabled before registration", async () => {
    let enabled = true;
    const entry = launch({
      shouldStart: async () => enabled,
      async start(options) {
        const runtime = await entry.start(options);
        enabled = false;
        return runtime;
      },
    });
    const timeout = setTimeout(() => stop.abort(), 1_000);
    try {
      await run;
    } finally {
      clearTimeout(timeout);
    }
    expect(entry.opened).toHaveLength(1);
    expect(entry.closed).toEqual(entry.opened);
    expect(entry.activated).toEqual([]);
    expect(readDaemonRegistry(registry)).toBeUndefined();
  });

  it.each([
    { scenario: "the restored database", removeBeforeOpen: false, status: "succeeded" },
    { scenario: "a missing target", removeBeforeOpen: true, status: "failed" },
  ])("reconnects after a real HTTP switch with $scenario", async ({ removeBeforeOpen, status }) => {
    await rm(targetStore);
    const restored = new SessionStore({ path: targetStore });
    restored.close();
    run = runRegisteredDaemon({
      launcher: "cli",
      version: "0.1.0",
      baseDataDirectory: base,
      canSwitchData: async () => true,
      signal: stop.signal,
      async start(options) {
        if (removeBeforeOpen && options.storePath === targetStore) await rm(targetStore);
        return await startVykorDaemon(options);
      },
    });
    void run.catch(() => {});
    await vi.waitFor(() => expect(readDaemonRegistry(registry)).toBeDefined(), { timeout: 10_000 });
    const first = readDaemonRegistry(registry)!;
    const response = await fetch(`${first.url}/maintenance/data-switch`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${first.token}`,
        "content-type": "application/json",
        [PROTOCOL_VERSION_HEADER]: String(CURRENT_PROTOCOL_VERSION),
      },
      body: JSON.stringify({ id: "actual-switch", directory: target, storePath: targetStore }),
      signal: AbortSignal.timeout(5_000),
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ id: "actual-switch" });
    await vi.waitFor(() => {
      const current = readDaemonRegistry(registry);
      expect(current).toBeDefined();
      expect(current?.token).not.toBe(first.token);
    }, { timeout: 10_000 });
    const next = readDaemonRegistry(registry)!;
    const result = await fetch(`${next.url}/maintenance/data-switch/actual-switch`, {
      headers: {
        authorization: `Bearer ${next.token}`,
        [PROTOCOL_VERSION_HEADER]: String(CURRENT_PROTOCOL_VERSION),
      },
      signal: AbortSignal.timeout(5_000),
    });
    expect(next.pid).toBe(first.pid);
    expect(next.token).not.toBe(first.token);
    expect(next.storePath).toBe(removeBeforeOpen ? first.storePath : targetStore);
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ id: "actual-switch", status });
    if (removeBeforeOpen) await expect(stat(targetStore)).rejects.toMatchObject({ code: "ENOENT" });
  }, 25_000);

  it.each(["saved", "legacy"])("refuses to create an empty database at a missing %s location", async (kind) => {
    await rm(targetStore);
    await mkdir(join(base, "daemon"), { recursive: true });
    const locationFile = kind === "saved" ? state : join(root, "runtime-data-location.json");
    await writeFile(locationFile, JSON.stringify({
      version: 1,
      location: { directory: target, storePath: targetStore },
    }));
    const attempt = runRegisteredDaemon({
      launcher: "desktop",
      version: "0.1.0",
      baseDataDirectory: base,
      ...(kind === "legacy" ? { legacyDataLocationPath: locationFile } : {}),
      signal: stop.signal,
    });
    const completed = attempt.then(() => undefined, (error: unknown) => error);
    try {
      const error = await Promise.race([
        completed,
        vi.waitFor(() => expect(readDaemonRegistry(registry)).toBeDefined()).then(() => undefined),
      ]);
      expect(error).toBeInstanceOf(Error);
      expect(readDaemonRegistry(registry)).toBeUndefined();
      await expect(stat(targetStore)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      stop.abort();
      await completed;
    }
  });
});
