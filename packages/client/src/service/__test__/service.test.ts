import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CURRENT_PROTOCOL_VERSION } from "@vykor/protocol";
import { Service } from "../index.js";
import { listDataRootWriters, withDataRootLock } from "@vykor/host-config/paths";
import { acquireStartupLock } from "../startup-lock.js";
import * as rootWriters from "../../../../host-config/src/storage/data-root-writers.js";
import * as registries from "../registry.js";

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
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
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

async function installCapturingCli(registry: string, record: string, verifyRealGuard = false) {
  const cli = join(directory, "node_modules/@rzx/ohs"); await mkdir(cli, { recursive: true });
  await writeFile(join(cli, "package.json"), JSON.stringify({ name: "@rzx/ohs", bin: { vk: "cli.mjs" } }));
  const realCli = fileURLToPath(new URL("../../../../../apps/cli/src/index.ts", import.meta.url));
  const loader = new URL("../../../../../apps/cli/node_modules/tsx/dist/loader.mjs", import.meta.url).href;
  await writeFile(join(cli, "cli.mjs"), `import {writeFile} from 'node:fs/promises';
await writeFile(${JSON.stringify(record)},JSON.stringify({channels:process.env.VYKOR_CHANNELS_DIR??null,images:process.env.VYKOR_IMAGE_ATTACHMENT_CACHE_DIR??null}));
${verifyRealGuard ? `const {spawnSync}=await import('node:child_process');const child=spawnSync(process.execPath,['--import',${JSON.stringify(loader)},${JSON.stringify(realCli)},'serve','--register'],{stdio:'inherit',windowsHide:true,timeout:5000});process.exit(child.status??1);`
    : `process.argv=[process.execPath,${JSON.stringify(fixture)},${JSON.stringify(registry)},'1.2.3','${CURRENT_PROTOCOL_VERSION}'];await import(${JSON.stringify(pathToFileURL(fixture).href)});`}`);
  return join(cli, "cli.mjs");
}

describe("local service management", () => {
  it.each([
    { state: "invalid selector", rootEnv: true, canonicalShape: false },
    { state: "pending migration", rootEnv: true, canonicalShape: false },
    { state: "invalid selector", rootEnv: true, canonicalShape: true },
    { state: "pending migration", rootEnv: true, canonicalShape: true },
    { state: "invalid selector", rootEnv: false, canonicalShape: false },
    { state: "pending migration", rootEnv: false, canonicalShape: false },
    { state: "invalid selector", rootEnv: false, canonicalShape: true },
    { state: "pending migration", rootEnv: false, canonicalShape: true },
  ])("reuses an unrelated explicit existing registry without a command: $state rootEnv=$rootEnv canonicalShape=$canonicalShape", async ({ state, rootEnv, canonicalShape }) => {
    const root = join(directory, "product");
    file = canonicalShape ? join(directory, "caller/data/daemon/registry.json") : join(directory, "caller-registry.json");
    await start();
    if (state === "invalid selector") await writeFile(join(directory, ".vykor-root.json"), "broken selector");
    else await withDataRootLock(directory, lock => lock.writeSelector({ version: 1, dataRoot: root,
      pendingMigration: { id: "owned", journalPath: join(directory, "journal") } }));
    const env = { HOME: directory, USERPROFILE: directory, ...(rootEnv ? { VYKOR_CONFIG_DIR: root } : {}) };
    expect(await Service.discover({ file, env })).toMatchObject({ file });
    const endpoint = await Service.ensure({ file, env, timeoutMs: 5000 });
    endpoints.push(endpoint);
    expect(endpoint.file).toBe(file);
    expect(await Service.stop(endpoint)).toBe(true);
    expect(await listDataRootWriters(root)).toEqual([]);
  });

  it.each([false, true])("rejects an invalid selector for an existing explicit canonical registry without a command: rootEnv=$0", async rootEnv => {
    const root = join(directory, ".vykor");
    file = join(root, "data/daemon/registry.json");
    await start();
    await writeFile(join(directory, ".vykor-root.json"), "broken selector");
    await expect(Service.ensure({ file, env: { HOME: directory, USERPROFILE: directory,
      ...(rootEnv ? { VYKOR_CONFIG_DIR: root } : {}) }, timeoutMs: 3000 })).rejects.toThrow(/Invalid data root selector/);
  });

  it("keeps mixed concurrent ensure callers' management provenance independent", async () => {
    const root = join(directory, ".vykor"), registry = join(root, "data/daemon/registry.json");
    const env = { HOME: directory, USERPROFILE: directory, VYKOR_CONFIG_DIR: root, START_RECORD: join(directory, "starts") };
    const ownedStartup = Service.ensure({ file: registry, env, command: [process.execPath, fixture, registry, "1.2.3", String(CURRENT_PROTOCOL_VERSION), "300"], timeoutMs: 5000 });
    await sleep(30);
    const managedStartup = Service.ensure({ file: registry, env, timeoutMs: 5000 });
    const [owned, managed] = await Promise.all([ownedStartup, managedStartup]);
    endpoints.push(owned, managed);
    expect(managed.pid).toBe(owned.pid);
    expect(await readFile(env.START_RECORD, "utf8")).toBe("start\n");
    await withDataRootLock(directory, lock => lock.writeSelector({ version: 1, dataRoot: root,
      pendingMigration: { id: "owned", journalPath: join(directory, "journal") } }));
    await expect(Service.stop(managed)).rejects.toThrow(/pending|migration/);
    expect(await Service.stop(owned)).toBe(true);
  });

  it.each(["invalid selector", "pending migration"] as const)("keeps explicit canonical file plus command caller managed with %s", async state => {
    const root = join(directory, ".vykor"), registry = join(root, "data/daemon/registry.json");
    if (state === "invalid selector") await writeFile(join(directory, ".vykor-root.json"), "broken selector");
    else await withDataRootLock(directory, lock => lock.writeSelector({ version: 1, dataRoot: root,
      pendingMigration: { id: "owned", journalPath: join(directory, "journal") } }));
    const endpoint = await Service.ensure({ file: registry, command: [process.execPath, fixture, registry, "1.2.3", String(CURRENT_PROTOCOL_VERSION)],
      env: { HOME: directory, USERPROFILE: directory, VYKOR_CONFIG_DIR: root }, timeoutMs: 5000 });
    endpoints.push(endpoint);
    expect(endpoint.file).toBe(registry);
    expect(await Service.stop(endpoint)).toBe(true);
    expect(await listDataRootWriters(root)).toEqual([]);
  });

  it.each([false, true])("protects managed startup from an invalid selector: explicit canonical=$0", async explicit => {
    const root = join(directory, ".vykor"), registry = join(root, "data/daemon/registry.json");
    await writeFile(join(directory, ".vykor-root.json"), "broken selector");
    await expect(Service.ensure({ ...(explicit ? { file: registry } : {}), cwd: directory,
      env: { HOME: directory, USERPROFILE: directory, VYKOR_CONFIG_DIR: root }, timeoutMs: 3000 })).rejects.toThrow(/Invalid data root selector/);
    await expect(readFile(registry)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains managed provenance when reusing an explicit canonical registry without a command", async () => {
    const root = join(directory, ".vykor"), registry = join(root, "data/daemon/registry.json");
    const env = { HOME: directory, USERPROFILE: directory, VYKOR_CONFIG_DIR: root };
    const started = await Service.ensure({ file: registry, env, command: [process.execPath, fixture, registry, "1.2.3", String(CURRENT_PROTOCOL_VERSION)], timeoutMs: 5000 });
    endpoints.push(started);
    const reused = await Service.ensure({ file: registry, env, timeoutMs: 5000 });
    await withDataRootLock(directory, lock => lock.writeSelector({ version: 1, dataRoot: root,
      pendingMigration: { id: "owned", journalPath: join(directory, "journal") } }));
    await expect(Service.ensure({ file: registry, env, timeoutMs: 3000 })).rejects.toThrow(/pending|migration/);
    await expect(Service.stop(reused)).rejects.toThrow(/pending|migration/);
    // The explicit command endpoint keeps its original caller-managed ownership.
    expect(await Service.stop(started)).toBe(true);
  });

  it.each([
    { canonical: false, inherited: "old" }, { canonical: false, inherited: "empty" },
    { canonical: true, inherited: "old" }, { canonical: true, inherited: "empty" },
  ])("uses only explicit managed directory environment: canonical=$canonical inherited=$inherited", async ({ canonical, inherited }) => {
    const registry = join(directory, ".vykor/data/daemon/registry.json"), record = join(directory, "child-env.json");
    vi.stubEnv("VYKOR_CHANNELS_DIR", inherited === "empty" ? "" : join(directory, "global-channels"));
    vi.stubEnv("VYKOR_IMAGE_ATTACHMENT_CACHE_DIR", inherited === "empty" ? "" : join(directory, "global-images"));
    await installCapturingCli(registry, record);
    const endpoint = await Service.ensure({ ...(canonical ? { file: registry } : {}), cwd: directory,
      env: { HOME: directory, USERPROFILE: directory }, timeoutMs: 5000 }); endpoints.push(endpoint);
    expect(JSON.parse(await readFile(record, "utf8"))).toEqual({ channels: null, images: null });
  });

  it("preserves explicit managed old pins so the real CLI directory guard refuses them", async () => {
    const registry = join(directory, ".vykor/data/daemon/registry.json"), record = join(directory, "child-env.json"), logPath = join(directory, "guard.log");
    vi.stubEnv("VYKOR_CHANNELS_DIR", ""); vi.stubEnv("VYKOR_IMAGE_ATTACHMENT_CACHE_DIR", "");
    await installCapturingCli(registry, record, true);
    const env = { HOME: directory, USERPROFILE: directory, VYKOR_CHANNELS_DIR: join(directory, "explicit-old-channels"), VYKOR_IMAGE_ATTACHMENT_CACHE_DIR: join(directory, "explicit-old-images") };
    await expect(Service.ensure({ cwd: directory, env, logPath, timeoutMs: 10000 })).rejects.toThrow(/exited/);
    expect(JSON.parse(await readFile(record, "utf8"))).toEqual({ channels: env.VYKOR_CHANNELS_DIR, images: env.VYKOR_IMAGE_ATTACHMENT_CACHE_DIR });
    expect(await readFile(logPath, "utf8")).toMatch(/VYKOR_CHANNELS_DIR.*VYKOR_IMAGE_ATTACHMENT_CACHE_DIR/s);
    await expect(readFile(registry)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps caller-managed directory environment merging independent of managed root selection", async () => {
    const record = join(directory, "child-env.json"), inherited = join(directory, "global-channels");
    vi.stubEnv("VYKOR_CHANNELS_DIR", inherited); vi.stubEnv("VYKOR_IMAGE_ATTACHMENT_CACHE_DIR", "");
    const command = await installCapturingCli(file, record);
    const endpoint = await Service.ensure({ file, command: [process.execPath, command], env: { HOME: directory, USERPROFILE: directory, VYKOR_CONFIG_DIR: "relative-caller-root" }, timeoutMs: 5000 }); endpoints.push(endpoint);
    expect(JSON.parse(await readFile(record, "utf8"))).toEqual({ channels: inherited, images: "" });
  });

  it("starts an explicit canonical registry with no root environment or custom command", async () => {
    const root = join(directory, ".vykor"), registry = join(root, "data/daemon/registry.json");
    const cli = join(directory, "node_modules/@rzx/ohs"); await mkdir(cli, { recursive: true });
    await writeFile(join(cli, "package.json"), JSON.stringify({ name: "@rzx/ohs", bin: { vk: "cli.mjs" } }));
    await writeFile(join(cli, "cli.mjs"), `process.argv = [process.execPath, ${JSON.stringify(fixture)}, ${JSON.stringify(registry)}, '1.2.3', '${CURRENT_PROTOCOL_VERSION}']; await import(${JSON.stringify(pathToFileURL(fixture).href)});`);
    const env = { HOME: directory, USERPROFILE: directory, VYKOR_CONFIG_DIR: undefined, VYKOR_DATA_DIR: undefined, VYKOR_CHANNELS_DIR: undefined, VYKOR_IMAGE_ATTACHMENT_CACHE_DIR: undefined, ROOT_RECORD: join(directory, "child-root") };
    const endpoint = await Service.ensure({ file: registry, env, cwd: directory, timeoutMs: 5000 }); endpoints.push(endpoint);
    expect(endpoint.file).toBe(registry);
    expect(JSON.parse(await readFile(env.ROOT_RECORD, "utf8"))).toMatchObject({ root, home: directory });
    await withDataRootLock(directory, lock => lock.writeSelector({ version: 1, dataRoot: root, pendingMigration: { id: "owned", journalPath: join(directory, "journal") } }));
    await expect(Service.stop(endpoint)).rejects.toThrow(/pending|migration/);
    expect(await listDataRootWriters(root)).toEqual([]);
  });

  it("protects explicit canonical default startup from a pending migration", async () => {
    const root = join(directory, ".vykor"), registry = join(root, "data/daemon/registry.json");
    await withDataRootLock(directory, lock => lock.writeSelector({ version: 1, dataRoot: root, pendingMigration: { id: "owned", journalPath: join(directory, "journal") } }));
    await expect(Service.ensure({ file: registry, env: { HOME: directory, USERPROFILE: directory }, cwd: directory })).rejects.toThrow(/pending|migration/);
    await expect(readFile(registry)).rejects.toThrow();
    await expect(readdir(`${registry}.sdk-start.lock`)).rejects.toThrow();
  });

  it("starts a caller-managed registry independently of invalid default root inputs", async () => {
    const endpoint = await Service.ensure({ file, env: { HOME: "relative-home", USERPROFILE: "relative-home", VYKOR_CONFIG_DIR: "relative-root" }, command: [process.execPath, fixture, file, "1.2.3", String(CURRENT_PROTOCOL_VERSION)] }); endpoints.push(endpoint);
    expect(endpoint.file).toBe(file);
  });

  it.each(["ensure", "stop"] as const)("cancels %s at home writer admission with the original reason and no leaked control files", async operation => {
    const root = join(directory, ".vykor"), registry = join(root, "data/daemon/registry.json");
    const env = { HOME: directory, USERPROFILE: directory, START_RECORD: join(directory, "starts") };
    const options = { env, command: [process.execPath, fixture, registry, "1.2.3", String(CURRENT_PROTOCOL_VERSION)], timeoutMs: 5000 };
    let endpoint: Awaited<ReturnType<typeof Service.ensure>> | undefined;
    if (operation === "stop") { endpoint = await Service.ensure(options); endpoints.push(endpoint); }
    const before = await readFile(registry, "utf8").catch(() => undefined);
    let unlock!: () => void, locked!: () => void, admitted!: () => void;
    const held = new Promise<void>(resolve => { locked = resolve });
    const entered = new Promise<void>(resolve => { admitted = resolve });
    const barrier = new Promise<void>(resolve => { unlock = resolve });
    const hold = () => withDataRootLock(directory, async () => { locked(); await barrier });
    let holding: Promise<void>;
    if (operation === "ensure") {
      const original = registries.readEndpoint;
      vi.spyOn(registries, "readEndpoint").mockImplementationOnce(async path => { holding = hold(); await held; return original(path); });
    } else { holding = hold(); await held; }
    const acquire = rootWriters.acquireDataRootWriter;
    vi.spyOn(rootWriters, "acquireDataRootWriter").mockImplementation(input => { admitted(); return acquire(input); });
    const controller = new AbortController(), reason = new Error("owned admission cancelled");
    let settled = false;
    const pending = (operation === "ensure" ? Service.ensure({ ...options, signal: controller.signal }) : Service.stop(endpoint!, { timeoutMs: 5000, signal: controller.signal }))
      .then(value => { settled = true; return value }, error => { settled = true; return error });
    try {
      await entered; controller.abort(reason);
      await vi.waitFor(() => expect(settled).toBe(true), { timeout: 1500 });
      expect(await pending).toBe(reason);
      expect(await listDataRootWriters(root)).toEqual([]);
      await expect(readdir(`${registry}.sdk-start.lock`)).rejects.toThrow();
    } finally { unlock(); await holding!; await pending; }
    expect(await readdir(join(root, "data/daemon/writers")).catch(() => [])).toEqual([]);
    expect(await readFile(registry, "utf8").catch(() => undefined)).toBe(before);
    expect(await readFile(env.START_RECORD, "utf8").catch(() => "")).toBe(operation === "stop" ? "start\n" : "");
    if (endpoint) expect(process.kill(endpoint.pid, 0)).toBe(true);
  }, 15000);

  it("does not renew the stop deadline after home writer admission", async () => {
    const root = join(directory, ".vykor"), registry = join(root, "data/daemon/registry.json"), env = { HOME: directory, USERPROFILE: directory };
    const endpoint = await Service.ensure({ env, command: [process.execPath, fixture, registry, "1.2.3", String(CURRENT_PROTOCOL_VERSION)], timeoutMs: 5000 }); endpoints.push(endpoint);
    const before = await readFile(registry, "utf8"), end = Date.now() + 5000;
    const acquire = rootWriters.acquireDataRootWriter;
    vi.spyOn(rootWriters, "acquireDataRootWriter").mockImplementation(async input => {
      const lease = await acquire(input);
      vi.spyOn(Date, "now").mockReturnValue(end + 1);
      return lease;
    });
    await expect(Service.stop(endpoint, { timeoutMs: 5000 })).rejects.toThrow(/deadline|timed out/);
    expect(process.kill(endpoint.pid, 0)).toBe(true);
    expect(await readFile(registry, "utf8")).toBe(before);
    expect(await listDataRootWriters(root)).toEqual([]);
  });

  it("registers SDK control writes before waiting for the registry lock and releases ownership after timeout", async () => {
    const root = join(directory, ".vykor"), registry = join(root, "data", "daemon", "registry.json");
    const control = await acquireStartupLock(registry, Date.now() + 5000);
    const pending = Service.ensure({ env: { HOME: directory, USERPROFILE: directory }, command: ["must-not-start"], timeoutMs: 1800 }).catch(error => error);
    try {
      let writers: Awaited<ReturnType<typeof listDataRootWriters>> = [];
      for (let count = 0; count < 10 && !writers.length; count++) { await sleep(20); writers = await withDataRootLock(directory, () => listDataRootWriters(root)); }
      expect(writers).toMatchObject([{ kind: "sdk-control", pid: process.pid }]);
      // Migration holding home sees busy and can refuse without acquiring control.
      await withDataRootLock(directory, async () => { expect(await listDataRootWriters(root)).toHaveLength(1); });
      expect(await pending).toBeInstanceOf(Error);
      expect(await listDataRootWriters(root)).toEqual([]);
    } finally { await control.release(); await pending; }
  }, 10000);
  it("requires fresh root writer admission before stopping and cleaning a default discovered endpoint", async () => {
    const registry = join(directory, ".vykor/data/daemon/registry.json"), env = { HOME: directory, USERPROFILE: directory };
    const endpoint = await Service.ensure({ env, command: [process.execPath, fixture, registry, "1.2.3", String(CURRENT_PROTOCOL_VERSION)], timeoutMs: 5000 }); endpoints.push(endpoint);
    const discovered = await Service.discover({ env }); expect(discovered).toBeDefined();
    await withDataRootLock(directory, lock => lock.writeSelector({ version: 1, dataRoot: join(directory, ".vykor"), pendingMigration: { id: "owned-migration", journalPath: join(directory, "migration.json") } }));
    await expect(Service.stop(discovered!)).rejects.toThrow(/pending|migration/);
    await expect(Service.stop(endpoint)).rejects.toThrow(/pending|migration/);
    expect(process.kill(endpoint.pid, 0)).toBe(true);
    expect(await readFile(registry, "utf8")).toContain(String(endpoint.pid));
  });
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
