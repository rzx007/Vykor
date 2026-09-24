import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ToolRegistry, type Settings } from "@vykor/core";
import { expect } from "vitest";
import { discoverVykorExtensions } from "../src/extensions.js";
import { activateNativePluginTools, type NativeToolActivationResult } from "../src/native-tools/activate.js";

export const pluginId = "example.text-inspector";
export const toolName = "TextInspectorCheck";
export const settings: Settings = {
  model: "test", apiFormat: "anthropic", maxTurns: 1, permission: { mode: "default" },
};
const sampleRoot = fileURLToPath(new URL("../../../examples/plugins/text-inspector/", import.meta.url));
type Cleanup = () => Promise<void> | void;
type EntryExecution = { pid: number; host: string };

export interface TestPluginRuntime {
  cwd: string;
  registry: ToolRegistry;
  activation?: NativeToolActivationResult;
  pid?: number;
  close(): Promise<void>;
}

export class NativePluginFixture {
  readonly source: string;
  readonly config: string;
  readonly cwds: [string, string];
  readonly entry: string;
  readonly manifest: string;
  readonly marker: string;
  readonly runtimes: TestPluginRuntime[] = [];

  constructor(readonly root: string) {
    this.source = join(root, "source");
    this.config = join(root, "user-config");
    this.cwds = [join(root, "project-a"), join(root, "project-b")];
    this.entry = join(this.source, "tools", "index.mjs");
    this.manifest = join(this.source, ".vykor-plugin", "plugin.json");
    this.marker = join(root, "entry-executions.jsonl");
  }

  async prepare(): Promise<void> {
    await cp(sampleRoot, this.source, { recursive: true });
    await Promise.all([this.config, ...this.cwds].map(path => mkdir(path, { recursive: true })));
    // Only the temporary copy gains an observation marker; the reference plugin stays untouched.
    const source = await readFile(this.entry, "utf8");
    await writeFile(this.entry, `import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(this.marker)}, JSON.stringify({ pid: process.pid, host: process.env.VYKOR_NATIVE_TOOL_HOST }) + "\\n");
${source}`);
  }

  async executions(): Promise<EntryExecution[]> {
    try {
      return (await readFile(this.marker, "utf8")).trim().split("\n").filter(Boolean)
        .map(line => JSON.parse(line) as EntryExecution);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  discover(cwd = this.cwds[0]) {
    return discoverVykorExtensions(cwd, settings);
  }

  async activate(cwd = this.cwds[0]): Promise<TestPluginRuntime> {
    const discovery = await this.discover(cwd);
    expect(discovery.plugins.map(plugin => plugin.manifest.id), discovery.warnings.join("\n")).toEqual([pluginId]);
    const cleanups: Cleanup[] = [];
    const runtime: TestPluginRuntime = {
      cwd,
      registry: new ToolRegistry(),
      async close() {
        const results = await Promise.allSettled(cleanups.splice(0).reverse().map(cleanup => Promise.resolve().then(cleanup)));
        const failures = results.filter(result => result.status === "rejected");
        if (failures.length) throw new AggregateError(failures.map(result => result.reason), "Plugin cleanup failed");
      },
    };
    this.runtimes.push(runtime);
    const before = await this.executions();
    runtime.activation = await activateNativePluginTools(discovery.plugins[0]!, {
      cwd, toolRegistry: runtime.registry, addCleanup: cleanup => cleanups.push(cleanup),
    });
    expect(runtime.activation.state, JSON.stringify(runtime.activation.diagnostics)).toBe("active");
    expect(runtime.registry.inspect(toolName)?.source).toEqual({ kind: "plugin", id: pluginId });
    const executions = await this.executions();
    expect(executions).toHaveLength(before.length + 1);
    const execution = executions.at(-1)!;
    expect(execution.host).toBe("1");
    expect(execution.pid).not.toBe(process.pid);
    runtime.pid = execution.pid;
    return runtime;
  }

  async closeAll(): Promise<void> {
    const results = await Promise.allSettled(this.runtimes.map(runtime => runtime.close()));
    const failures = results.filter(result => result.status === "rejected");
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), "Runtime cleanup failed");
  }
}

export function callInspector(runtime: TestPluginRuntime, text = "ok  \n") {
  return runtime.registry.get(toolName)!.execute({ text }, { cwd: runtime.cwd });
}

export async function expectProcessStopped(pid: number): Promise<void> {
  await expect.poll(() => {
    try { process.kill(pid, 0); return false; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
      throw error;
    }
  }, { timeout: 5_000, interval: 25 }).toBe(true);
}

export async function expectRuntimeStopped(runtime: TestPluginRuntime): Promise<void> {
  expect(runtime.registry.getAll()).toEqual([]);
  expect(runtime.activation?.host?.state).toBe("inactive");
  expect(runtime.pid).toBeTypeOf("number");
  await expectProcessStopped(runtime.pid!);
}

export async function withNativePluginFixture(run: (fixture: NativePluginFixture) => Promise<void>): Promise<void> {
  const fixture = new NativePluginFixture(await mkdtemp(join(tmpdir(), "oh-native-authoring-")));
  const previousConfig = process.env.VYKOR_CONFIG_DIR;
  try {
    process.env.VYKOR_CONFIG_DIR = fixture.config;
    await fixture.prepare();
    await run(fixture);
  } finally {
    try {
      await fixture.closeAll();
      for (const execution of await fixture.executions()) await expectProcessStopped(execution.pid);
    } finally {
      if (previousConfig === undefined) delete process.env.VYKOR_CONFIG_DIR;
      else process.env.VYKOR_CONFIG_DIR = previousConfig;
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
}
