import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, AgentExecutionContext, ToolResult } from "@vykor/agent-contracts";
import { createDefaultNodeAgent as sourceNodeFactory, createDefaultToolRegistry, createRunCapabilityView } from "@vykor/agent-runtime";
import { QueryEngine } from "@vykor/core";
import { ExecutionRuntimeOwner } from "@vykor/execution-node";
import { SessionStore } from "@vykor/services";
import { createProcessJobSource } from "../../../packages/agent-runtime/src/node/jobs/process-job-source.js";
import { createBrowserTool } from "../../../packages/server/src/application/browser-tools/browser-tool.js";
import { bindToolDispatchCheck } from "../../../packages/server/src/application/session/execution/tool-dispatch-check.js";

// Opt in after rebuilding to verify the same workflow through the shipping artifact.
const createDefaultNodeAgent: typeof sourceNodeFactory = process.env.VYKOR_TEST_RUNTIME_BUNDLE === "1"
  ? (await import(new URL("../../../packages/agent-runtime/dist/index.js", import.meta.url).href)).createDefaultNodeAgent
  : sourceNodeFactory;

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });

function payload(result: ToolResult): Record<string, unknown> {
  const block = result.content[0];
  if (block?.type !== "text") throw new Error("Expected a JSON tool result");
  return JSON.parse(block.text);
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "vykor-job-safety-"));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const store = new SessionStore({ path: join(directory, "session.db") });
  cleanup.push(() => store.close());
  const owner = new ExecutionRuntimeOwner();
  const processes = owner.getDetachedProcessSupervisor({ cwd: directory, sessionId: "session" });
  cleanup.push(() => owner.close());
  const source = createProcessJobSource({ sessionId: "session", cwd: directory, processes });
  const registry = createDefaultToolRegistry({ jobs: source.jobs, childEnvironment: false, backgroundShell: false });
  const effectPath = join(directory, "forbidden-effect");
  let navigations = 0;
  registry.register(createBrowserTool({ execute: async ({ action }) => {
    if (action.action === "navigate") { navigations++; throw new Error("net::ERR_ABORTED at http://localhost:5173"); }
    if (action.action !== "inspect") writeFileSync(effectPath, action.action);
    return { url: "http://localhost:5173", title: "Current page", pageText: "navigation state observed" };
  } }, async () => { throw new Error("No screenshots in this text-only regression"); }, async () => ({})), { kind: "builtin" });
  const view = createRunCapabilityView({ toolRegistry: registry });
  const lease = store.acquireApplicationOwner({ ownerId: "job-safety-owner", pid: process.pid, staleAfterMs: 60_000 });
  store.sessions.create({ id: "session", cwd: directory, model: "offline" });
  store.runs.createRun({ id: "run", sessionId: "session" });
  store.runs.updateRun("run", { status: "running" });
  const scope = { agentId: "session", sessionId: "session", runId: "run", inputId: "input", cwd: directory,
    traceId: "trace", signal: new AbortController().signal };
  const bindToolDispatch = bindToolDispatchCheck({ store, ownerLease: () => lease, accepting: () => true });
  const execution: AgentExecutionContext = { scope, tools: view.tools, checkToolDispatch: bindToolDispatch(scope, view.tools), observeInvocation() {},
    effects: { requestPermission: async () => ({ status: "approved" }) },
    children: { hasChildAgent: () => false, spawnChildAgent: async () => { throw new Error("unexpected child"); },
      sendChildInput: async () => { throw new Error("unexpected child"); }, interruptChildAgent: async () => {},
      awaitChildAgent: async () => { throw new Error("unexpected child"); } },
    emit: async () => {}, takeSteeredInputs: async () => [], closeSteering() {},
  };
  const engine = new QueryEngine({ streamMessage: async function* () { throw new Error("unexpected model call"); } }, registry,
    { checkTool: async () => ({ action: "allow" }) }, { register() {}, execute: async () => ({ blocked: false }) },
    { cwd: directory, sessionId: "session", toolTimeoutMs: 5_000 });
  let call = 0;
  const execute = (name: string, input: Record<string, unknown>) => engine.executeTool({
    type: "tool_use", id: `call-${++call}`, name, input,
  }, { execution });
  const failNavigation = async () => {
    const result = await execute("Browser", { action: "navigate", url: "http://localhost:5173" });
    expect(result).toMatchObject({ isError: true, executionState: "completed" });
    expect(JSON.stringify(result.content)).toContain("net::ERR_ABORTED");
    expect(navigations).toBe(1);

  };
  return { directory, store, source, processes, owner, bindToolDispatch, browser: registry.get("Browser")!, execute, failNavigation, effectPath, navigations: () => navigations };
}

describe("Browser errors and real background job continuity", () => {
  it("waits and reads a real Node process after a returned navigation error", async () => {
    const f = fixture();
    const releasePath = join(f.directory, "release-job"), scriptPath = join(f.directory, "job.cjs");
    writeFileSync(scriptPath, `const fs=require('node:fs'); console.log('job started'); const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(releasePath)})){clearInterval(timer);console.log('job finished')}},10)`);
    const job = await f.processes.startShellExecution({ argv: [process.execPath, scriptPath], cwd: f.directory, sessionId: "session", description: "background verification" });
    const target = { kind: "shell", jobId: job.id } as const;
    await vi.waitFor(async () => expect((await f.source.jobs.read({ sessionId: "session", target })).text).toContain("job started"));
    await f.failNavigation();
    let returned = false;
    const waiting = f.execute("JobWait", { targets: [{ target }], timeoutSeconds: 3 }).then(result => { returned = true; return result; });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(returned).toBe(false);
    writeFileSync(releasePath, "finish");
    const waited = await waiting;
    expect(waited.isError).not.toBe(true);
    expect(payload(waited)).toMatchObject({ results: [{ timedOut: false, snapshot: { status: "completed", exitCode: 0 } }] });
    const read = await f.execute("JobRead", { target });
    expect(payload(read)).toMatchObject({ text: "job started\njob finished\n", snapshot: { status: "completed" } });
    const listed = await f.execute("JobList", {});
    expect(payload(listed).jobs).toEqual([expect.objectContaining({ id: job.id, status: "completed" })]);
    expect(f.navigations()).toBe(1);
  });
  it.each([false, true])("runs Browser → real Jobs → Shell → final report in one Node Run (denyShell=%s)", async denyShell => {
    const f = fixture(), release = join(f.directory, "finish-job"), effect = join(f.directory, "built.txt");
    writeFileSync(join(f.directory, "worker.cjs"), `const fs=require('node:fs');console.log('job started');const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(timer);console.log('job finished')}},10)`);
    writeFileSync(join(f.directory, "build.cjs"), "require('node:fs').writeFileSync('built.txt','built once')");
    const job = await f.processes.startShellExecution({ argv: [process.execPath, join(f.directory, "worker.cjs")], cwd: f.directory, sessionId: "session" });
    const target = { kind: "shell", jobId: job.id } as const;
    await vi.waitFor(async () => expect((await f.source.jobs.read({ sessionId: "session", target })).text).toContain("job started"));
    const calls = [
      { id: "browser", name: "Browser", input: { action: "navigate", url: "http://localhost:5173" } },
      { id: "list", name: "JobList", input: {} },
      { id: "read", name: "JobRead", input: { target } },
      { id: "wait", name: "JobWait", input: { targets: [{ target }], timeoutSeconds: 3 } },
      { id: "shell", name: "Shell", input: { command: "node build.cjs", timeout: 2000 } },
    ];
    let turn = 0, finalContext = "";
    const events: AgentEvent[] = [];
    const node = await createDefaultNodeAgent({ cwd: f.directory, sessionId: "session", executionOwner: f.owner,
      tools: [f.browser], bindToolDispatch: f.bindToolDispatch,
      settings: { model: "offline", maxTurns: 8, apiFormat: "openai", permission: { mode: "full_access", ...(denyShell ? { deniedTools: ["Shell"] } : {}) }, sandbox: { enabled: false }, memory: { enabled: false }, plugins: { enabled: false } },
      onEvent: async event => {
        events.push(event);
        if (event.type === "run.started") { f.store.runs.createRun({ id: event.context.runId!, sessionId: "session" }); f.store.runs.updateRun(event.context.runId!, { status: "running" }); }
        if (event.type === "domain.event" && event.data.name === "tool.lifecycle" && event.data.payload?.toolUseId === "wait" && event.data.payload.phase === "running") {
          const timer = setTimeout(() => writeFileSync(release, "finish"), 100); cleanup.push(() => clearTimeout(timer));
        }
      },
      client: { async *streamMessage(params) {
        const call = calls[turn++];
        if (call) yield { type: "tool_use_start", toolUse: { type: "tool_use", ...call } };
        else { finalContext = JSON.stringify(params.messages); yield { type: "text_delta", delta: denyShell ? "Job completed; Shell denied." : "Job completed; build verified." }; }
        yield { type: "complete", stopReason: call ? "tool_use" : "end_turn" };
      } },
    });
    cleanup.push(() => node.close());
    const result = await node.runMessage("Navigate, inspect and wait for the job, then build and report.");
    expect(result.output).toBe(denyShell ? "Job completed; Shell denied." : "Job completed; build verified.");
    expect(events.filter(event => event.type === "run.started")).toHaveLength(1);
    const completed = events.filter((event): event is Extract<AgentEvent, { type: "tool.completed" }> => event.type === "tool.completed");
    expect(completed.map(event => event.data.toolUseId)).toEqual(calls.map(call => call.id));
    expect(completed[0]!.data.result).toMatchObject({ isError: true, executionState: "completed" });
    expect(payload(completed[1]!.data.result).jobs).toEqual([expect.objectContaining({ id: job.id })]);
    expect(payload(completed[2]!.data.result).text).toContain("job started");
    expect(payload(completed[3]!.data.result)).toMatchObject({ results: [{ timedOut: false, snapshot: { status: "completed", exitCode: 0 } }] });
    expect(completed[4]!.data.result.executionState).toBe(denyShell ? "not_started" : "completed");
    expect(finalContext).toContain("job finished"); expect(f.navigations()).toBe(1);
    expect(existsSync(effect)).toBe(!denyShell);
    if (!denyShell) expect(readFileSync(effect, "utf8")).toBe("built once");
  });

});
