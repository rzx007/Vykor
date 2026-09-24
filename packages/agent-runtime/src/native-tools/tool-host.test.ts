import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRegistry, type IToolRegistry, type ToolDefinition } from "@vykor/core";
import { loadNativePlugin, validateNativePlugin } from "@vykor/plugins";
import { afterEach, describe, expect, it, vi } from "vitest";
import { activateNativePluginTools } from "./activate.js";
import { buildNativeToolHostEnvironment } from "./tool-host.js";
import { createRunCapabilityView } from "../run-capability-view.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

class TestRegistry implements IToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();
  register(tool: ToolDefinition): void { this.tools.set(tool.name, tool); }
  unregister(name: string): boolean { return this.tools.delete(name); }
  get(name: string): ToolDefinition | undefined { return this.tools.get(name); }
  getAll(): ToolDefinition[] { return [...this.tools.values()]; }
  has(name: string): boolean { return this.tools.has(name); }
}

function writePlugin(moduleSource: string, id = "dev.vykor.runtime-tool") {
  const root = mkdtempSync(join(tmpdir(), "vykor-native-tool-"));
  roots.push(root);
  mkdirSync(join(root, ".vykor-plugin"), { recursive: true });
  mkdirSync(join(root, "tools"), { recursive: true });
  writeFileSync(join(root, ".vykor-plugin", "plugin.json"), JSON.stringify({
    schemaVersion: 1,
    id,
    name: id.split(".").at(-1),
    version: "1.0.0",
    components: { tools: ["./tools/index.mjs"] },
  }));
  writeFileSync(join(root, "tools", "index.mjs"), moduleSource);
  return root;
}

async function loadPlugin(root: string) {
  const validation = await validateNativePlugin(root);
  expect(validation.status).toBe("valid");
  return await loadNativePlugin(validation.plugin!);
}

describe("NativeToolHost", () => {
  it("rejects a native plugin call outside its captured Run owner", async () => {
    const plugin = await loadPlugin(writePlugin(`
      export function registerTools() { return [{ name: "PrivateNative", description: "private native", inputSchema: {},
        invoke() { return { content: [{ type: "text", text: "native secret" }] }; }
      }]; }
    `));
    const registry = new ToolRegistry();
    const cleanups: Array<() => Promise<void> | void> = [];
    await activateNativePluginTools(plugin, { cwd: plugin.root, toolRegistry: registry, addCleanup: cleanup => cleanups.push(cleanup) });
    try {
      const sources = { toolRegistry: registry, pluginIds: new Set([plugin.manifest.id]) };
      const definition = registry.get("PrivateNative")!;
      const denied = await definition.execute({}, { cwd: plugin.root, capabilityView: createRunCapabilityView(sources) });
      expect(denied.isError).toBe(true);
      expect(JSON.stringify(denied)).not.toContain("native secret");
      const allowed = await definition.execute({}, { cwd: plugin.root, capabilityView: createRunCapabilityView(sources, plugin.manifest.id) });
      expect(allowed.content).toEqual([{ type: "text", text: "native secret" }]);
    } finally { for (const cleanup of cleanups.reverse()) await cleanup(); }
  });
  it("runs forked tool hosts in Node mode when the parent runtime is Electron", () => {
    expect(buildNativeToolHostEnvironment({ PATH: "D:/bin" }, "39.2.6")).toEqual({
      PATH: "D:/bin",
      VYKOR_NATIVE_TOOL_HOST: "1",
      ELECTRON_RUN_AS_NODE: "1",
    });
    expect(buildNativeToolHostEnvironment({ PATH: "D:/bin" })).toEqual({
      PATH: "D:/bin",
      VYKOR_NATIVE_TOOL_HOST: "1",
    });
  });

  it("provides the documented registration and invocation contexts inside the child", async () => {
    const plugin = await loadPlugin(writePlugin(`
      export function registerTools(registration) {
        registration.log("info", "sdk-context-ready");
        return [{ name: "PluginSdkContext", description: "inspect the public context", inputSchema: {},
          invoke(_input, context) {
            return { content: [{ type: "text", text: JSON.stringify({
              registrationPlugin: registration.plugin,
              registrationPermissions: registration.permissions,
              plugin: context.plugin, permissions: context.permissions,
              cwd: context.cwd, sessionId: context.sessionId, deadline: context.deadline,
              hasSignal: context.signal instanceof AbortSignal,
              hasSettings: "settings" in context, hasTerminal: "terminal" in context,
            }) }] };
          }
        }];
      }
    `, "dev.vykor.sdk-context"));
    const registry = new TestRegistry();
    const cleanups: Array<() => Promise<void> | void> = [];
    const logs: string[] = [];
    const activation = await activateNativePluginTools(plugin, {
      cwd: plugin.root, toolRegistry: registry, callTimeoutMs: 4000,
      addCleanup: cleanup => cleanups.push(cleanup), onLog: message => logs.push(message),
    });
    try {
      expect(activation.state).toBe("active");
      const before = Date.now();
      const result = await registry.get("PluginSdkContext")!.execute({}, { cwd: tmpdir(), sessionId: "sdk-session" });
      const first = result.content[0];
      expect(first?.type).toBe("text");
      if (first?.type !== "text") throw new Error("Expected a text result");
      const context = JSON.parse(first.text);
      const identity = { id: "dev.vykor.sdk-context", name: "sdk-context", version: "1.0.0", root: plugin.root };
      expect(context).toMatchObject({
        registrationPlugin: identity, registrationPermissions: {}, plugin: identity, permissions: {},
        cwd: tmpdir(), sessionId: "sdk-session", hasSignal: true, hasSettings: false, hasTerminal: false,
      });
      expect(context.deadline).toBeGreaterThanOrEqual(before + 4000);
      expect(context.deadline).toBeLessThanOrEqual(Date.now() + 4000);
      expect(logs.some(message => message.includes("sdk-context-ready"))).toBe(true);
    } finally { for (const cleanup of cleanups) await cleanup(); }
  });

  it("forwards caller cancellation to the child and keeps the host usable afterwards", async () => {
    const plugin = await loadPlugin(writePlugin(`
      let cancelled = 0;
      export function registerTools(ctx) {
        return [{ name: "PluginCallerCancel", description: "wait for caller cancellation", inputSchema: {},
          async invoke(input, context) {
            if (!input.wait) return { content: [{ type: "text", text: String(cancelled) }] };
            await new Promise(resolve => {
              context.signal.addEventListener("abort", () => { cancelled++; resolve(); }, { once: true });
              ctx.log("info", "caller-cancel-ready");
            });
            return { content: [] };
          }
        }];
      }
    `, "dev.vykor.caller-cancel"));
    const registry = new TestRegistry();
    const cleanups: Array<() => Promise<void> | void> = [];
    let ready = false;
    const activation = await activateNativePluginTools(plugin, {
      cwd: plugin.root, toolRegistry: registry, callTimeoutMs: 4000, cancellationGraceMs: 1000,
      addCleanup: cleanup => cleanups.push(cleanup),
      onLog: message => { if (message.includes("caller-cancel-ready")) ready = true; },
    });
    try {
      expect(activation.state).toBe("active");
      const controller = new AbortController();
      const call = registry.get("PluginCallerCancel")!.execute({ wait: true }, { cwd: plugin.root, abortSignal: controller.signal });
      const cancelled = expect(call).rejects.toMatchObject({ code: "tool_call_cancelled" });
      await vi.waitFor(() => expect(ready).toBe(true), { timeout: 2000 });
      controller.abort();
      await cancelled;
      await expect(registry.get("PluginCallerCancel")!.execute({}, { cwd: plugin.root }))
        .resolves.toEqual({ content: [{ type: "text", text: "1" }] });
      expect(activation.host?.state).toBe("active");
    } finally { for (const cleanup of cleanups) await cleanup(); }
  });

  it("does not invoke a tool when the caller signal is already aborted", async () => {
    const plugin = await loadPlugin(writePlugin(`
      let calls = 0;
      export function registerTools() {
        return [{ name: "PluginPreCancelled", description: "count invocations", inputSchema: {},
          invoke() { calls++; return { content: [{ type: "text", text: String(calls) }] }; }
        }];
      }
    `, "dev.vykor.pre-cancelled"));
    const registry = new TestRegistry();
    const cleanups: Array<() => Promise<void> | void> = [];
    await activateNativePluginTools(plugin, { cwd: plugin.root, toolRegistry: registry, addCleanup: cleanup => cleanups.push(cleanup) });
    try {
      const controller = new AbortController(); controller.abort();
      await expect(registry.get("PluginPreCancelled")!.execute({}, { cwd: plugin.root, abortSignal: controller.signal }))
        .rejects.toMatchObject({ code: "tool_call_cancelled" });
      await expect(registry.get("PluginPreCancelled")!.execute({}, { cwd: plugin.root }))
        .resolves.toEqual({ content: [{ type: "text", text: "1" }] });
    } finally { for (const cleanup of cleanups) await cleanup(); }
  });

  it("registers and invokes multiple tools in a child process, then cleans them up", async () => {
    const plugin = await loadPlugin(writePlugin(`
      export async function registerTools(ctx) {
        return [
          {
            name: "PluginEcho",
            description: "echo input",
            inputSchema: { type: "object" },
            async invoke(input) { return { content: [{ type: "text", text: ctx.plugin.id + ":" + input.value }] }; }
          },
          {
            name: "PluginFailure",
            description: "fail without crashing host",
            inputSchema: { type: "object" },
            async invoke() { throw new Error("expected tool failure"); }
          }
        ];
      }
    `));
    const registry = new TestRegistry();
    const cleanups: Array<() => Promise<void> | void> = [];
    const activation = await activateNativePluginTools(plugin, {
      cwd: plugin.root,
      toolRegistry: registry,
      addCleanup: (cleanup) => cleanups.push(cleanup),
    });

    expect(activation.state).toBe("active");
    expect(activation.toolNames).toEqual(["PluginEcho", "PluginFailure"]);
    await expect(registry.get("PluginFailure")!.execute({}, { cwd: plugin.root })).rejects.toMatchObject({ code: "tool_call_failed" });
    await expect(registry.get("PluginEcho")!.execute({ value: "ok" }, { cwd: plugin.root })).resolves.toEqual({
      content: [{ type: "text", text: "dev.vykor.runtime-tool:ok" }],
    });

    await cleanups[0]!();
    expect(registry.getAll()).toEqual([]);
    expect(activation.host?.state).toBe("inactive");
  });

  it("returns a structured registration error when registerTools is missing", async () => {
    const plugin = await loadPlugin(writePlugin(`export const value = 1;`, "dev.vykor.missing-register"));
    const activation = await activateNativePluginTools(plugin, {
      cwd: plugin.root,
      toolRegistry: new TestRegistry(),
      addCleanup: () => undefined,
    });
    expect(activation.state).toBe("error");
    expect(activation.diagnostics[0]).toMatchObject({ code: "tool_register_failed", component: "tools" });
  });

  it("times out a call without taking down the host", async () => {
    const plugin = await loadPlugin(writePlugin(`
      export async function registerTools() {
        return [{
          name: "PluginSlow", description: "slow", inputSchema: {},
          async invoke(_input, context) {
            await new Promise((resolve, reject) => {
              const timer = setTimeout(resolve, 10000);
              context.signal.addEventListener("abort", () => { clearTimeout(timer); reject(context.signal.reason); }, { once: true });
            });
            return { content: [] };
          }
        }];
      }
    `, "dev.vykor.slow-tool"));
    const registry = new TestRegistry();
    const cleanups: Array<() => Promise<void> | void> = [];
    const activation = await activateNativePluginTools(plugin, {
      cwd: plugin.root,
      toolRegistry: registry,
      callTimeoutMs: 50,
      addCleanup: (cleanup) => cleanups.push(cleanup),
    });
    await expect(registry.get("PluginSlow")!.execute({}, { cwd: plugin.root })).rejects.toMatchObject({ code: "tool_call_timeout" });
    expect(activation.host?.state).toBe("active");
    await cleanups[0]!();
  });

  it("rejects invalid input before invoking plugin code and writes an audit event", async () => {
    const plugin = await loadPlugin(writePlugin(`
      export async function registerTools() {
        return [{
          name: "PluginStrict", description: "strict input", inputSchema: {
            type: "object",
            required: ["value"],
            properties: { value: { type: "string", minLength: 2 } },
            additionalProperties: false
          },
          async invoke() { throw new Error("invoke should not run"); }
        }];
      }
    `, "dev.vykor.strict-tool"));
    const registry = new TestRegistry();
    const audits: unknown[] = [];
    const activation = await activateNativePluginTools(plugin, {
      cwd: plugin.root,
      toolRegistry: registry,
      addCleanup: () => undefined,
      onAudit: (event) => audits.push(event),
    });

    expect(activation.state).toBe("active");
    await expect(registry.get("PluginStrict")!.execute({ value: "x" }, { cwd: plugin.root }))
      .rejects.toMatchObject({ code: "tool_input_invalid" });
    expect(audits).toMatchObject([{
      pluginId: "dev.vykor.strict-tool",
      toolName: "PluginStrict",
      status: "failed",
      errorCode: "tool_input_invalid",
    }]);
    await activation.host?.stop();
  });

  it("enforces a per-plugin Native Tool concurrency limit", async () => {
    const plugin = await loadPlugin(writePlugin(`
      export async function registerTools() {
        return [{
          name: "PluginWait", description: "wait", inputSchema: {},
          async invoke(_input, context) {
            await new Promise((resolve, reject) => {
              const timer = setTimeout(resolve, 100);
              context.signal.addEventListener("abort", () => { clearTimeout(timer); reject(context.signal.reason); }, { once: true });
            });
            return { content: [] };
          }
        }];
      }
    `, "dev.vykor.concurrent-tool"));
    const registry = new TestRegistry();
    const activation = await activateNativePluginTools(plugin, {
      cwd: plugin.root,
      toolRegistry: registry,
      maxConcurrentCalls: 1,
      addCleanup: () => undefined,
    });

    const first = registry.get("PluginWait")!.execute({}, { cwd: plugin.root });
    await expect(registry.get("PluginWait")!.execute({}, { cwd: plugin.root }))
      .rejects.toMatchObject({ code: "tool_concurrency_limit" });
    await expect(first).resolves.toEqual({ content: [] });
    await activation.host?.stop();
  });

  it("caps Native Tool stdout and stderr logs", async () => {
    const plugin = await loadPlugin(writePlugin(`
      export async function registerTools() {
        process.stdout.write("o".repeat(64));
        process.stderr.write("e".repeat(64));
        return [{
          name: "PluginNoop", description: "noop", inputSchema: {},
          async invoke() { return { content: [] }; }
        }];
      }
    `, "dev.vykor.noisy-tool"));
    const registry = new TestRegistry();
    const logs: string[] = [];
    const activation = await activateNativePluginTools(plugin, {
      cwd: plugin.root,
      toolRegistry: registry,
      outputMaxBytes: 16,
      addCleanup: () => undefined,
      onLog: (message) => logs.push(message),
    });

    expect(activation.state).toBe("active");
    expect(logs.join("\n")).toContain("output limit reached (16 bytes)");
    await activation.host?.stop();
  });

  it("kills an unresponsive host and unregisters its tools after the cancellation grace period", async () => {
    const plugin = await loadPlugin(writePlugin(`
      export async function registerTools() {
        return [{
          name: "PluginBlocked", description: "blocks synchronously", inputSchema: {},
          invoke() {
            const until = Date.now() + 5000;
            while (Date.now() < until) {}
            return { content: [] };
          }
        }];
      }
    `, "dev.vykor.blocked-tool"));
    const registry = new TestRegistry();
    const activation = await activateNativePluginTools(plugin, {
      cwd: plugin.root,
      toolRegistry: registry,
      callTimeoutMs: 25,
      cancellationGraceMs: 25,
      addCleanup: () => undefined,
    });

    await expect(registry.get("PluginBlocked")!.execute({}, { cwd: plugin.root }))
      .rejects.toMatchObject({ code: "tool_call_timeout" });
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(activation.host?.state).toBe("error");
    expect(registry.getAll()).toEqual([]);
  });

  it("removes every registered tool when its host process crashes", async () => {
    const plugin = await loadPlugin(writePlugin(`
      export async function registerTools() {
        return [{
          name: "PluginCrash", description: "crash host", inputSchema: {},
          async invoke() { process.exit(17); }
        }];
      }
    `, "dev.vykor.crash-tool"));
    const registry = new TestRegistry();
    const activation = await activateNativePluginTools(plugin, {
      cwd: plugin.root,
      toolRegistry: registry,
      addCleanup: () => undefined,
    });
    await expect(registry.get("PluginCrash")!.execute({}, { cwd: plugin.root })).rejects.toMatchObject({ code: "tool_host_crashed" });
    expect(registry.getAll()).toEqual([]);
    expect(activation.host?.state).toBe("error");
  });
});
