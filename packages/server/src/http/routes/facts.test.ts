import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { getLocalRulesDir, loadFacts, loadLocalRules, saveFacts } from "@vykor/personalization";
import { createFactsRoutes } from "./facts.js";

let configDir: string;
let projectDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "vk-facts-route-"));
  process.env.VYKOR_CONFIG_DIR = configDir;
  projectDir = join(configDir, "project");
});

afterEach(() => {
  delete process.env.VYKOR_CONFIG_DIR;
  rmSync(configDir, { recursive: true, force: true });
});

function app(locked = false) {
  const release = vi.fn();
  const closeRuntimesForCwd = vi.fn(async () => {});
  const acquireCwdMutation = vi.fn(() => locked ? null : { release });
  const server = new Hono().route("/facts", createFactsRoutes({
    control: { acquireCwdMutation, closeRuntimesForCwd } as never,
    sessions: { get: (id: string) => id === "s1" ? { cwd: projectDir }
      : id === "other-project" ? { cwd: join(configDir, "other-project") } : null } as never,
  }));
  return { server, release, closeRuntimesForCwd, acquireCwdMutation };
}

describe("facts routes", () => {
  it("lists sourced facts and replaces one fact within the current project", async () => {
    saveFacts({ facts: [{
      key: "ssh_host:ops@10.1.2.3", type: "ssh_host", label: "SSH connection", value: "ops@10.1.2.3", confidence: 0.7,
      sourceSessionId: "s1", sourceMessageId: "u1", observedAt: "2026-09-24T00:00:00.000Z",
    }] }, projectDir);
    const { server, release, closeRuntimesForCwd } = app();

    const listed = await server.request(`/facts?cwd=${encodeURIComponent(projectDir)}`);
    expect(listed.status).toBe(200);
    expect((await listed.json() as { facts: Array<{ key: string }> }).facts[0]?.key).toBe("ssh_host:ops@10.1.2.3");

    const replaced = await server.request("/facts/replace", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: projectDir, oldKey: "ssh_host:ops@10.1.2.3", newValue: "ops@10.1.2.4", sessionId: "s1" }),
    });
    expect(replaced.status).toBe(200);
    expect((await replaced.json() as { result: { newKey: string } }).result.newKey).toBe("ssh_host:ops@10.1.2.4");
    expect(loadLocalRules(projectDir)).toContain("ops@10.1.2.4");
    expect(closeRuntimesForCwd).toHaveBeenCalledWith(projectDir);
    expect(release).toHaveBeenCalledOnce();
  });

  it("rejects missing fields and a missing old key without changing any fact", async () => {
    const { server, release, closeRuntimesForCwd } = app();
    const missing = await server.request("/facts/replace", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: projectDir }),
    });
    expect(missing.status).toBe(400);
    const absent = await server.request("/facts/replace", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: projectDir, oldKey: "ssh_host:missing", newValue: "ops@10.1.2.4" }),
    });
    expect(absent.status).toBe(404);
    expect(release).toHaveBeenCalledOnce();
    expect(closeRuntimesForCwd).not.toHaveBeenCalled();
  });

  it("holds the project mutation boundary while active runs exist", async () => {
    saveFacts({ facts: [{
      key: "ssh_host:ops@10.1.2.3", type: "ssh_host", label: "SSH connection", value: "ops@10.1.2.3", confidence: 0.7,
      sourceSessionId: "s1", sourceMessageId: "u1", observedAt: "2026-09-24T00:00:00.000Z",
    }] }, projectDir);
    const path = join(getLocalRulesDir(projectDir), "facts.json");
    const before = readFileSync(path, "utf-8");
    const { server, release, closeRuntimesForCwd } = app(true);
    const response = await server.request("/facts/replace", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: projectDir, oldKey: "ssh_host:ops@10.1.2.3", newValue: "ops@10.1.2.4" }),
    });
    expect(response.status).toBe(409);
    expect(readFileSync(path, "utf-8")).toBe(before);
    expect(release).not.toHaveBeenCalled();
    expect(closeRuntimesForCwd).not.toHaveBeenCalled();
  });

  it("maps invalid values without mutating the file", async () => {
    saveFacts({ facts: [
      { key: "ssh_host:ops@10.1.2.3", type: "ssh_host", label: "SSH connection", value: "ops@10.1.2.3", confidence: 0.7,
        sourceSessionId: "s1", sourceMessageId: "u1", observedAt: "2026-09-24T00:00:00.000Z" },
      { key: "ssh_host:ops@10.1.2.4", type: "ssh_host", label: "SSH connection", value: "ops@10.1.2.4", confidence: 0.7,
        sourceSessionId: "s1", sourceMessageId: "u2", observedAt: "2026-09-24T00:00:00.000Z" },
    ] }, projectDir);
    const path = join(getLocalRulesDir(projectDir), "facts.json");
    const before = readFileSync(path, "utf-8");
    const { server, release, closeRuntimesForCwd } = app();
    for (const [newValue, status] of [["bad", 400]] as const) {
      const response = await server.request("/facts/replace", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ cwd: projectDir, oldKey: "ssh_host:ops@10.1.2.3", newValue }),
      });
      expect(response.status).toBe(status);
      expect(readFileSync(path, "utf-8")).toBe(before);
    }
    expect(release).toHaveBeenCalledOnce();
    expect(closeRuntimesForCwd).not.toHaveBeenCalled();
  });

  it("links an existing active target while retaining its user-message source", async () => {
    saveFacts({ facts: [
      { key: "ssh_host:ops@10.1.2.3", type: "ssh_host", label: "SSH connection", value: "ops@10.1.2.3", confidence: 0.7,
        sourceSessionId: "s1", sourceMessageId: "u-old", observedAt: "2026-09-23T00:00:00.000Z" },
      { key: "ssh_host:ops@10.1.2.4", type: "ssh_host", label: "SSH connection", value: "ops@10.1.2.4", confidence: 0.7,
        sourceSessionId: "s1", sourceMessageId: "u-new", observedAt: "2026-09-24T00:00:00.000Z" },
    ] }, projectDir);
    const { server, closeRuntimesForCwd } = app();
    const response = await server.request("/facts/replace", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: projectDir, oldKey: "ssh_host:ops@10.1.2.3", newValue: "ops@10.1.2.4", sessionId: "s1" }),
    });
    expect(response.status).toBe(200);
    const facts = loadFacts(projectDir).facts;
    expect(facts).toHaveLength(2);
    expect(facts.find((fact) => fact.key === "ssh_host:ops@10.1.2.4"))
      .toMatchObject({ sourceSessionId: "s1", sourceMessageId: "u-new" });
    expect(closeRuntimesForCwd).toHaveBeenCalledWith(projectDir);
  });

  it("rejects a session ID belonging to another project before writing", async () => {
    saveFacts({ facts: [{
      key: "ssh_host:ops@10.1.2.3", type: "ssh_host", label: "SSH connection", value: "ops@10.1.2.3", confidence: 0.7,
      sourceSessionId: "s1", sourceMessageId: "u1", observedAt: "2026-09-24T00:00:00.000Z",
    }] }, projectDir);
    const path = join(getLocalRulesDir(projectDir), "facts.json");
    const before = readFileSync(path, "utf-8");
    const { server, closeRuntimesForCwd } = app();
    const response = await server.request("/facts/replace", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: projectDir, oldKey: "ssh_host:ops@10.1.2.3", newValue: "ops@10.1.2.4", sessionId: "other-project" }),
    });
    expect(response.status).toBe(400);
    expect(readFileSync(path, "utf-8")).toBe(before);
    expect(closeRuntimesForCwd).not.toHaveBeenCalled();
  });

  it("reports a corrupt facts file instead of replacing it", async () => {
    const { server } = app();
    saveFacts({ facts: [] }, projectDir);
    const path = join(getLocalRulesDir(projectDir), "facts.json");
    writeFileSync(path, "{broken", "utf-8");
    const listed = await server.request(`/facts?cwd=${encodeURIComponent(projectDir)}`);
    expect(listed.status).toBe(500);
    const replaced = await server.request("/facts/replace", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: projectDir, oldKey: "ssh_host:ops@10.1.2.3", newValue: "ops@10.1.2.4" }),
    });
    expect(replaced.status).toBe(500);
    expect(readFileSync(path, "utf-8")).toBe("{broken");
  });
});
