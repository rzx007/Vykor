import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CURRENT_PROTOCOL_VERSION } from "@vykor/protocol";
import { Service } from "../index.js";
import { withDataRootLock } from "@vykor/host-config/paths";

const fixture = fileURLToPath(new URL("./service-fixture.mjs", import.meta.url));
let directory: string;
let file: string;
let children: ChildProcess[];
let endpoints: Awaited<ReturnType<typeof Service.ensure>>[];

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "vykor-client-service-"));
  file = join(directory, "registry.json");
  children = [];
  endpoints = [];
});

afterEach(async () => {
  for (const endpoint of endpoints) {
    try { process.kill(endpoint.pid, "SIGKILL"); } catch {}
    for (let attempt = 0; attempt < 50; attempt++) {
      try { process.kill(endpoint.pid, 0); } catch { break; }
      await sleep(20);
    }
  }
  for (const child of children) child.kill("SIGKILL");
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

async function start(version = "1.2.3", protocol = String(CURRENT_PROTOCOL_VERSION)) {
  const child = spawn(process.execPath, [fixture, file, version, protocol], { stdio: "ignore", windowsHide: true });
  children.push(child);
  for (let attempt = 0; attempt < 100; attempt++) {
    try { return JSON.parse(await readFile(file, "utf8")); } catch { await sleep(20); }
  }
  throw new Error("Fixture did not start");
}

describe("local service management", () => {
  it("keeps explicit registry-file embedding independent of unrelated invalid root and home inputs", async () => {
    const registry = await start();
    const endpoint = await Service.discover({ file, env: { HOME: "relative-home", USERPROFILE: "relative-home", VYKOR_CONFIG_DIR: "relative-root" } });
    expect(endpoint?.pid).toBe(registry.pid);
  });
  it("waits for normal root initialization and shares the resulting default startup", async () => {
    const registry = join(directory, ".vykor", "data", "daemon", "registry.json");
    const options = { env: { HOME: directory, USERPROFILE: directory, START_RECORD: join(directory, "starts") }, command: [process.execPath, fixture, registry, "1.2.3", String(CURRENT_PROTOCOL_VERSION)], timeoutMs: 5_000 };
    const status = ["waiting", "waiting"];
    const pending: Promise<void>[] = [];
    const failures: unknown[] = [];
    await withDataRootLock(directory, async () => {
      for (let index = 0; index < 2; index++) pending.push(Service.ensure(options).then(endpoint => { endpoints.push(endpoint); status[index] = "started"; }, error => { failures.push(error); status[index] = "failed"; }));
      await sleep(80);
      expect(status).toEqual(["waiting", "waiting"]);
    }).finally(async () => { await Promise.all(pending); });
    expect(failures).toEqual([]);
    expect(endpoints[0]?.pid).toBe(endpoints[1]?.pid);
    expect(await readFile(join(directory, "starts"), "utf8")).toBe("start\n");
  });

  it("honors cancellation and the total deadline while waiting for the root lock", async () => {
    const options = { env: { HOME: directory, USERPROFILE: directory }, command: ["must-not-start"], timeoutMs: 50 };
    await withDataRootLock(directory, async () => {
      await expect(Service.ensure(options)).rejects.toThrow(/timed out/i);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20);
      try { await expect(Service.ensure({ ...options, timeoutMs: 1_000, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" }); }
      finally { clearTimeout(timer); }
    });
  });

  it("does not reset the startup deadline after the root lock is released", async () => {
    const registry = join(directory, ".vykor", "data", "daemon", "registry.json");
    let pending!: Promise<unknown>;
    await withDataRootLock(directory, async () => {
      pending = Service.ensure({ env: { HOME: directory, USERPROFILE: directory }, command: [process.execPath, fixture, registry, "1.2.3", String(CURRENT_PROTOCOL_VERSION), "250"], timeoutMs: 300 }).then(endpoint => { endpoints.push(endpoint); return "unexpected success"; }, error => error);
      await sleep(170);
    });
    expect(await pending).toMatchObject({ message: expect.stringMatching(/timed out/i) });
  });

  it("still refuses a pending migration after normal root-lock contention", async () => {
    let pending!: Promise<unknown>;
    await withDataRootLock(directory, async lock => {
      pending = Service.ensure({ env: { HOME: directory, USERPROFILE: directory }, command: ["must-not-start"] }).catch(error => error);
      await lock.writeSelector({ version: 1, dataRoot: directory, pendingMigration: { id: "pending-move", journalPath: join(directory, "journal") } });
    });
    expect(await pending).toMatchObject({ message: expect.stringMatching(/pending-move.*recover/i) });
  });

  it("still refuses a moved root after normal root-lock contention", async () => {
    let pending!: Promise<unknown>;
    await withDataRootLock(directory, async () => {
      pending = Service.ensure({ env: { HOME: directory, USERPROFILE: directory }, command: ["must-not-start"] }).catch(error => error);
      const migrations = join(directory, ".vykor", "data", "migrations");
      await mkdir(migrations, { recursive: true });
      await writeFile(join(migrations, "moved-root.json"), "{}");
    });
    expect(await pending).toMatchObject({ message: expect.stringMatching(/moved.*recover/i) });
  });
  it("starts in the saved root selected by the caller env, without inheriting another global data override", async () => {
    const root = join(directory, "saved");
    await mkdir(join(root, "data", "session-runtime"), { recursive: true });
    await writeFile(join(root, "data", "session-runtime", "sessions.db"), "existing database");
    await writeFile(join(directory, ".vykor-root.json"), JSON.stringify({ version: 1, dataRoot: root }));
    const registry = join(root, "data", "daemon", "registry.json");
    const endpoint = await Service.ensure({
      env: { HOME: directory, ROOT_RECORD: join(directory, "child-root.json") },
      command: [process.execPath, fixture, registry, "1.2.3", String(CURRENT_PROTOCOL_VERSION)],
      timeoutMs: 5_000,
    });
    endpoints.push(endpoint);
    expect(endpoint.file).toBe(registry);
    expect(JSON.parse(await readFile(join(directory, "child-root.json"), "utf8"))).toEqual({ root, home: directory, userProfile: directory });
    expect((await Service.discover({ env: { HOME: directory, USERPROFILE: directory } }))?.pid).toBe(endpoint.pid);
  });
  it("discovers only an authenticated compatible service without creating registry files", async () => {
    expect(await Service.discover({ file })).toBeUndefined();
    const registry = await start();
    const endpoint = await Service.discover({ file, version: version => version.startsWith("1.") });
    expect(endpoint?.pid).toBe(registry.pid);
    expect(Service.clientOptions(endpoint!)).toEqual({ baseUrl: registry.url, token: "fixture-secret" });
    expect(await Service.discover({ file, version: "2.0.0" })).toBeUndefined();
    await writeFile(file, JSON.stringify({ ...registry, token: "wrong-token" }));
    expect(await Service.discover({ file })).toBeUndefined();
  });

  it("does not return a daemon that is draining before a restart", async () => {
    const child = spawn(process.execPath, [fixture, file, "1.2.3", String(CURRENT_PROTOCOL_VERSION)], {
      env: { ...process.env, FIXTURE_DRAINING: "1" }, stdio: "ignore", windowsHide: true,
    });
    children.push(child);
    for (let attempt = 0; attempt < 100; attempt++) {
      try { await readFile(file, "utf8"); break; } catch { await sleep(20); }
    }
    await expect(Service.discover({ file })).resolves.toBeUndefined();
    await expect(Service.ensure({ file })).rejects.toThrow(/incompatible|unhealthy/i);
  });
  it("rejects incompatible protocols and malformed or non-local registries", async () => {
    const registry = await start("1.2.3", "999");
    expect(await Service.discover({ file })).toBeUndefined();
    for (const invalid of ["{", JSON.stringify({ ...registry, pid: -1 }), JSON.stringify({ ...registry, url: "https://example.com" })]) {
      await writeFile(file, invalid);
      expect(await Service.discover({ file })).toBeUndefined();
    }
  });

  it("starts once for concurrent callers, reuses the endpoint, and stops that instance", async () => {
    const record = join(directory, "starts.txt");
    const options = {
      file, command: [process.execPath, fixture, file, "1.2.3", String(CURRENT_PROTOCOL_VERSION)],
      env: { START_RECORD: record }, timeoutMs: 5_000,
    };
    const [left, right] = await Promise.all([Service.ensure(options), Service.ensure(options)]);
    endpoints.push(left);
    expect(right.pid).toBe(left.pid);
    expect((await Service.ensure({ file })).pid).toBe(left.pid);
    expect(await readFile(record, "utf8")).toBe("start\n");
    expect(await Service.stop(left)).toBe(true);
    expect(await Service.discover({ file })).toBeUndefined();
    expect(await Service.stop(left)).toBe(false);
  });

  it("captures child startup diagnostics when a log path is provided", async () => {
    const logPath = join(directory, "logs", "daemon.log");
    const endpoint = await Service.ensure({
      file, command: [process.execPath, fixture, file, "1.2.3", String(CURRENT_PROTOCOL_VERSION)],
      env: { FIXTURE_LOG: "1" }, logPath, timeoutMs: 5_000,
    });
    endpoints.push(endpoint);
    expect(await readFile(logPath, "utf8")).toContain("startup diagnostic");
  });

  it.each(["/health", "/capabilities"])("starts a compatible service when %s needs more than one second", async path => {
    const endpoint = await Service.ensure({
      file, command: [process.execPath, fixture, file, "1.2.3", String(CURRENT_PROTOCOL_VERSION)],
      env: { FIXTURE_PROBE_DELAY_PATH: path, FIXTURE_PROBE_DELAY_MS: "1200" }, timeoutMs: 4_000,
    });
    endpoints.push(endpoint);
    expect((await Service.discover({ file, timeoutMs: 3_000 }))?.pid).toBe(endpoint.pid);
  });

  it("bounds a stalled registered probe by the overall startup deadline and cleans up its child", async () => {
    const pids = join(directory, "stalled-pids.txt");
    const started = Date.now();
    await expect(Service.ensure({
      file, command: [process.execPath, fixture, file, "1.2.3", String(CURRENT_PROTOCOL_VERSION)],
      env: { FIXTURE_PROBE_DELAY_PATH: "/capabilities", FIXTURE_PROBE_DELAY_MS: "5000", START_PIDS: pids },
      timeoutMs: 500,
    })).rejects.toThrow(/timed out/i);
    expect(Date.now() - started).toBeLessThan(3_000);
    const pid = Number((await readFile(pids, "utf8")).trim());
    expect(() => process.kill(pid, 0)).toThrow();
    expect(await Service.discover({ file })).toBeUndefined();
  });

  it("does not replace or terminate an incompatible registered process", async () => {
    const registry = await start("1.2.3", "999");
    await expect(Service.ensure({ file, command: [process.execPath, fixture, file, "1.2.3", String(CURRENT_PROTOCOL_VERSION)] })).rejects.toThrow(/incompatible|unhealthy/i);
    expect(process.kill(registry.pid, 0)).toBe(true);
    expect(JSON.parse(await readFile(file, "utf8")).pid).toBe(registry.pid);
  });

  it("refuses to stop a service after its registry identity was replaced", async () => {
    const registry = await start();
    const endpoint = (await Service.discover({ file }))!;
    await writeFile(file, JSON.stringify({ ...registry, startedAt: registry.startedAt + 1 }));
    expect(await Service.stop(endpoint)).toBe(false);
    expect(process.kill(registry.pid, 0)).toBe(true);
  });

  it("reports executable failure promptly and leaves no registry behind", async () => {
    await expect(Service.ensure({ file, command: [join(directory, "missing-executable")], timeoutMs: 2_000 })).rejects.toThrow(/start|spawn|ENOENT/i);
    expect(await Service.discover({ file })).toBeUndefined();
  });

  it("cleans up a startup that times out before registration", async () => {
    await expect(Service.ensure({ file, command: [process.execPath, fixture, file, "1.2.3", String(CURRENT_PROTOCOL_VERSION), "400"], timeoutMs: 80 })).rejects.toThrow(/timed out/i);
    await sleep(500);
    expect(await Service.discover({ file })).toBeUndefined();
  });

  it("honors cancellation without starting a process", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(Service.ensure({ file, signal: controller.signal, command: [process.execPath, fixture, file, "1.2.3", String(CURRENT_PROTOCOL_VERSION)] })).rejects.toMatchObject({ name: "AbortError" });
    expect(await Service.discover({ file })).toBeUndefined();
  });

  it("resolves the consuming application's CLI and passes the chosen data directory", async () => {
    file = join(directory, "daemon", "registry.json");
    const cliDirectory = join(directory, "node_modules", "@rzx", "ohs");
    await mkdir(cliDirectory, { recursive: true });
    await writeFile(join(directory, "package.json"), '{"private":true}');
    await writeFile(join(cliDirectory, "package.json"), JSON.stringify({ name: "@rzx/ohs", bin: { vk: "cli.mjs" } }));
    await writeFile(join(cliDirectory, "cli.mjs"), `process.argv.splice(2, process.argv.length - 2, process.env.FIXTURE_REGISTRY, "1.2.3", ${JSON.stringify(String(CURRENT_PROTOCOL_VERSION))}); await import(${JSON.stringify(new URL("./service-fixture.mjs", import.meta.url).href)});`);
    const endpoint = await Service.ensure({ cwd: directory, env: { HOME: directory, USERPROFILE: directory, VYKOR_DATA_DIR: directory, FIXTURE_REGISTRY: file }, timeoutMs: 5_000 });
    endpoints.push(endpoint);
    expect(endpoint.file).toBe(file);
    expect((await Service.discover({ file }))?.pid).toBe(endpoint.pid);
  });

  it("aborts an in-flight startup and cleans up the child before registration", async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 80);
    try {
      await expect(Service.ensure({ file, signal: controller.signal, command: [process.execPath, fixture, file, "1.2.3", String(CURRENT_PROTOCOL_VERSION), "400"] })).rejects.toMatchObject({ name: "AbortError" });
      await sleep(500);
      expect(await Service.discover({ file })).toBeUndefined();
    } finally { clearTimeout(timer); }
  });

  it("closes the probe's protocol request when its deadline expires", async () => {
    let capabilityClosed = false;
    const server = createServer((request, response) => {
      if (request.url === "/capabilities") {
        response.on("close", () => { capabilityClosed = true; });
        return; // A server that never responds must not retain the probe's socket.
      }
      response.setHeader("connection", "close");
      response.end(JSON.stringify({ ok: true, version: "1.2.3" }));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    try {
      await writeFile(file, JSON.stringify({ url: `http://127.0.0.1:${address.port}`, pid: process.pid, token: "test", version: "1.2.3", startedAt: Date.now() }));
      expect(await Service.discover({ file, timeoutMs: 150 })).toBeUndefined();
      await sleep(100);
      expect(capabilityClosed).toBe(true);
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it("cancels a joining caller promptly while keeping the owner's startup alive", async () => {
    const owner = Service.ensure({ file, command: [process.execPath, fixture, file, "1.2.3", String(CURRENT_PROTOCOL_VERSION), "500"], timeoutMs: 5_000 });
    await sleep(30);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 50);
    try {
      const joined = Service.ensure({ file, signal: controller.signal }).then(() => "resolved", error => error.name);
      expect(await Promise.race([joined, sleep(250).then(() => "still-waiting")])).toBe("AbortError");
    } finally {
      clearTimeout(timer);
      endpoints.push(await owner);
    }
  });

  it("bounds a joining caller by its own deadline without canceling the owner", async () => {
    const owner = Service.ensure({ file, command: [process.execPath, fixture, file, "1.2.3", String(CURRENT_PROTOCOL_VERSION), "400"], timeoutMs: 5_000 });
    await sleep(30);
    try { await expect(Service.ensure({ file, timeoutMs: 50 })).rejects.toThrow(/timed out/i); }
    finally { endpoints.push(await owner); }
  });

  it("coordinates independently loaded SDK copies through the registry file", async () => {
    vi.resetModules();
    const { Service: independent } = await import("../index.js");
    const record = join(directory, "independent-starts.txt");
    const pids = join(directory, "fixture-pids.txt");
    const options = {
      file, command: [process.execPath, fixture, file, "1.2.3", String(CURRENT_PROTOCOL_VERSION), "300"],
      env: { START_RECORD: record, START_PIDS: pids }, timeoutMs: 5_000,
    };
    try {
      const [left, right] = await Promise.all([Service.ensure(options), independent.ensure(options)]);
      expect(right.pid).toBe(left.pid);
      expect(await readFile(record, "utf8")).toBe("start\n");
    } finally {
      for (const pid of (await readFile(pids, "utf8").catch(() => "")).trim().split("\n").filter(Boolean)) {
        try { process.kill(Number(pid), "SIGKILL"); } catch {}
      }
    }
  });
});
