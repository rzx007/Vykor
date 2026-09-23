import { describe, expect, it, vi } from "vitest";
import type {
  ActiveMcpRuntimeHandle,
  McpRuntimeStatus,
  McpServerIdentity,
} from "@openharness/core";
import { McpRuntimeConnectionCoordinator } from "./mcp-runtime-connection-coordinator.js";

function identity(name: string, fingerprint: string): McpServerIdentity {
  return {
    name,
    transport: "http",
    endpoint: `https://${fingerprint}.test/mcp`,
    endpointFingerprint: fingerprint,
  };
}

function fakeHandle(options: {
  runtimeId: string;
  servers: Record<string, McpServerIdentity>;
  statuses?: Record<string, McpRuntimeStatus>;
  onSynchronize?: (identity: McpServerIdentity, generation: number) => Promise<void> | void;
  onReconcile?: (name: string, generation: number) => Promise<void> | void;
  delayMs?: number;
  reconcileDelayMs?: number;
}) {
  const generations: number[] = [];
  let concurrent = 0;
  let maxConcurrent = 0;
  const synchronize = vi.fn(async (target: McpServerIdentity, generation: number) => {
    concurrent += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    generations.push(generation);
    try {
      if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      await options.onSynchronize?.(target, generation);
    } finally {
      concurrent -= 1;
    }
  });
  const reconcileGenerations: number[] = [];
  let reconcileConcurrent = 0;
  let maxReconcileConcurrent = 0;
  const reconcileGlobal = vi.fn(async (name: string, generation: number) => {
    reconcileConcurrent += 1;
    maxReconcileConcurrent = Math.max(maxReconcileConcurrent, reconcileConcurrent);
    reconcileGenerations.push(generation);
    try {
      if (options.reconcileDelayMs) await new Promise((resolve) => setTimeout(resolve, options.reconcileDelayMs));
      await options.onReconcile?.(name, generation);
    } finally {
      reconcileConcurrent -= 1;
    }
  });
  const handle: ActiveMcpRuntimeHandle = {
    runtimeId: options.runtimeId,
    identity: (name) => options.servers[name],
    getStatus: (target) => options.statuses?.[target.name] ?? "connected",
    synchronize,
    reconcileGlobal,
  };
  return {
    handle,
    generations,
    synchronize,
    reconcileGenerations,
    reconcileGlobal,
    maxConcurrent: () => maxConcurrent,
    maxReconcileConcurrent: () => maxReconcileConcurrent,
  };
}

describe("McpRuntimeConnectionCoordinator", () => {
  it("returns unavailable when no Runtime participates", async () => {
    const coordinator = new McpRuntimeConnectionCoordinator();
    const other = fakeHandle({ runtimeId: "r1", servers: { linear: identity("linear", "aaa") } });
    coordinator.register(other.handle);

    await expect(coordinator.getStatus(identity("linear", "bbb"))).resolves.toEqual({
      status: "unavailable",
      affectedRuntimes: 0,
      failures: [],
    });
    await expect(coordinator.synchronize(identity("linear", "bbb"))).resolves.toEqual({
      status: "unavailable",
      affectedRuntimes: 0,
      failures: [],
    });
    expect(other.synchronize).not.toHaveBeenCalled();
  });

  it("matches only the same name and endpoint fingerprint", async () => {
    const coordinator = new McpRuntimeConnectionCoordinator();
    const target = identity("linear", "same");
    const match = fakeHandle({ runtimeId: "match", servers: { linear: target } });
    const otherEndpoint = fakeHandle({ runtimeId: "endpoint", servers: { linear: identity("linear", "other") } });
    const otherName = fakeHandle({ runtimeId: "name", servers: { github: target } });
    coordinator.register(match.handle);
    coordinator.register(otherEndpoint.handle);
    coordinator.register(otherName.handle);

    const result = await coordinator.synchronize(target);

    expect(result.affectedRuntimes).toBe(1);
    expect(match.synchronize).toHaveBeenCalledTimes(1);
    expect(otherEndpoint.synchronize).not.toHaveBeenCalled();
    expect(otherName.synchronize).not.toHaveBeenCalled();
  });

  it("keeps same-name different-endpoint runtimes isolated across projects", async () => {
    const coordinator = new McpRuntimeConnectionCoordinator();
    const projectA = identity("linear", "project-a");
    const projectB = identity("linear", "project-b");
    const a = fakeHandle({ runtimeId: "a", servers: { linear: projectA } });
    const b = fakeHandle({ runtimeId: "b", servers: { linear: projectB } });
    coordinator.register(a.handle);
    coordinator.register(b.handle);

    await coordinator.synchronize(projectA);

    expect(a.synchronize).toHaveBeenCalledTimes(1);
    expect(b.synchronize).not.toHaveBeenCalled();
  });

  it("keeps generations isolated for different names sharing one endpoint", async () => {
    const coordinator = new McpRuntimeConnectionCoordinator();
    const linear = identity("linear", "shared-endpoint");
    const github = identity("github", "shared-endpoint");
    const linearHandle = fakeHandle({ runtimeId: "linear-runtime", servers: { linear } });
    const githubHandle = fakeHandle({ runtimeId: "github-runtime", servers: { github } });
    coordinator.register(linearHandle.handle);
    coordinator.register(githubHandle.handle);

    await coordinator.synchronize(linear);
    await coordinator.synchronize(github);

    expect(linearHandle.generations).toEqual([1]);
    expect(githubHandle.generations).toEqual([1]);
    expect(coordinator.currentGeneration(linear)).toBe(1);
    expect(coordinator.currentGeneration(github)).toBe(1);
  });

  it("aggregates error over disconnected over connected", async () => {
    const coordinator = new McpRuntimeConnectionCoordinator();
    const target = identity("linear", "agg");
    coordinator.register(fakeHandle({ runtimeId: "c", servers: { linear: target }, statuses: { linear: "connected" } }).handle);
    coordinator.register(fakeHandle({ runtimeId: "d", servers: { linear: target }, statuses: { linear: "disconnected" } }).handle);

    await expect(coordinator.getStatus(target)).resolves.toMatchObject({ status: "disconnected", affectedRuntimes: 2 });
    await expect(coordinator.synchronize(target)).resolves.toMatchObject({ status: "disconnected" });

    const errorCoordinator = new McpRuntimeConnectionCoordinator();
    errorCoordinator.register(fakeHandle({ runtimeId: "c", servers: { linear: target }, statuses: { linear: "connected" } }).handle);
    errorCoordinator.register(fakeHandle({ runtimeId: "e", servers: { linear: target }, statuses: { linear: "error" } }).handle);
    await expect(errorCoordinator.synchronize(target)).resolves.toMatchObject({ status: "error" });
  });

  it("serializes synchronize per identity and increments generation", async () => {
    const coordinator = new McpRuntimeConnectionCoordinator();
    const target = identity("linear", "serial");
    const handle = fakeHandle({ runtimeId: "r1", servers: { linear: target }, delayMs: 10 });
    coordinator.register(handle.handle);

    const first = coordinator.synchronize(target);
    const second = coordinator.synchronize(target);
    await Promise.all([first, second]);

    expect(handle.generations).toEqual([1, 2]);
    expect(handle.maxConcurrent()).toBe(1);
  });

  it("reports failures with runtime ids but keeps other runtimes", async () => {
    const coordinator = new McpRuntimeConnectionCoordinator();
    const target = identity("linear", "fail");
    const failing = fakeHandle({
      runtimeId: "failing",
      servers: { linear: target },
      statuses: { linear: "error" },
      onSynchronize: () => { throw new Error("reconnect failed"); },
    });
    const healthy = fakeHandle({ runtimeId: "healthy", servers: { linear: target } });
    coordinator.register(failing.handle);
    coordinator.register(healthy.handle);

    const result = await coordinator.synchronize(target);

    expect(result.affectedRuntimes).toBe(2);
    expect(result.failures).toEqual([{ runtimeId: "failing", message: "MCP runtime synchronization failed" }]);
    expect(healthy.synchronize).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("error");
  });

  it("redacts credentials and endpoint queries from runtime failure messages", async () => {
    const coordinator = new McpRuntimeConnectionCoordinator();
    const target = identity("linear", "redaction");
    coordinator.register(fakeHandle({
      runtimeId: "failing",
      servers: { linear: target },
      onSynchronize: () => {
        throw new Error("POST https://mcp.example.test/mcp?token=query-secret Authorization: Bearer access-secret failed");
      },
    }).handle);

    const result = await coordinator.synchronize(target);
    const serialized = JSON.stringify(result.failures);

    expect(serialized).not.toContain("query-secret");
    expect(serialized).not.toContain("access-secret");
    expect(serialized).not.toContain("?token=");
  });

  it("never lets an older generation synchronize overwrite a newer one", async () => {
    const coordinator = new McpRuntimeConnectionCoordinator();
    const target = identity("linear", "generation");
    const seen: number[] = [];
    const handle = fakeHandle({
      runtimeId: "r1",
      servers: { linear: target },
      onSynchronize: async (_target, generation) => { seen.push(generation); },
    });
    coordinator.register(handle.handle);

    await coordinator.synchronize(target);
    await coordinator.synchronize(target);

    expect(seen).toEqual([1, 2]);
    expect(coordinator.currentGeneration(target)).toBe(2);
  });

  it("does not run synchronize during getStatus", async () => {
    const coordinator = new McpRuntimeConnectionCoordinator();
    const target = identity("linear", "readonly");
    const handle = fakeHandle({ runtimeId: "r1", servers: { linear: target } });
    coordinator.register(handle.handle);

    await coordinator.getStatus(target);

    expect(handle.synchronize).not.toHaveBeenCalled();
  });

  it("unregisters a handle when its cleanup runs", async () => {
    const coordinator = new McpRuntimeConnectionCoordinator();
    const target = identity("linear", "cleanup");
    const handle = fakeHandle({ runtimeId: "r1", servers: { linear: target } });
    const unregister = coordinator.register(handle.handle);

    unregister();
    await expect(coordinator.synchronize(target)).resolves.toMatchObject({ affectedRuntimes: 0, status: "unavailable" });
  });

  it("reconciles every active handle by name, including stdio without an identity", async () => {
    const coordinator = new McpRuntimeConnectionCoordinator();
    const http = fakeHandle({ runtimeId: "http", servers: { linear: identity("linear", "aaa") } });
    const stdio = fakeHandle({ runtimeId: "stdio", servers: {} });
    coordinator.register(http.handle);
    coordinator.register(stdio.handle);

    const result = await coordinator.reconcileGlobal("local");

    expect(result.affectedRuntimes).toBe(2);
    expect(http.reconcileGlobal).toHaveBeenCalledWith("local", 1);
    expect(stdio.reconcileGlobal).toHaveBeenCalledWith("local", 1);
    expect(coordinator.currentNamedGeneration("local")).toBe(1);
  });

  it("serializes reconciles per name and advances the named generation", async () => {
    const coordinator = new McpRuntimeConnectionCoordinator();
    const order: number[] = [];
    const handle = fakeHandle({
      runtimeId: "r1",
      servers: {},
      reconcileDelayMs: 20,
      onReconcile: (_name, generation) => { order.push(generation); },
    });
    coordinator.register(handle.handle);

    const first = coordinator.reconcileGlobal("linear");
    const second = coordinator.reconcileGlobal("linear");
    await Promise.all([first, second]);

    expect(order).toEqual([1, 2]);
    expect(handle.maxReconcileConcurrent()).toBe(1);
    expect(coordinator.currentNamedGeneration("linear")).toBe(2);
  });

  it("reports reconcile failures without leaking details", async () => {
    const coordinator = new McpRuntimeConnectionCoordinator();
    coordinator.register(fakeHandle({
      runtimeId: "failing",
      servers: {},
      onReconcile: () => {
        throw new Error("POST https://mcp.example.test/mcp?token=query-secret failed");
      },
    }).handle);

    const result = await coordinator.reconcileGlobal("linear");

    expect(result.status).toBe("error");
    expect(result.failures).toEqual([{ runtimeId: "failing", message: "MCP runtime synchronization failed" }]);
    expect(JSON.stringify(result)).not.toContain("query-secret");
  });

  it("reports unavailable when no runtime can reconcile a name", async () => {
    const coordinator = new McpRuntimeConnectionCoordinator();
    await expect(coordinator.reconcileGlobal("linear")).resolves.toEqual({
      status: "unavailable",
      affectedRuntimes: 0,
      failures: [],
    });
  });
});
