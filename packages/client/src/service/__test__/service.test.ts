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
    const endpoint = await Service.ensure({ cwd: directory, env: { VYKOR_DATA_DIR: directory, FIXTURE_REGISTRY: file }, timeoutMs: 5_000 });
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
