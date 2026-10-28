import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createDefaultNodeAgent, type DefaultNodeAgent, type DefaultNodeAgentOptions } from "@vykor/agent-runtime";
import type { AgentChildInvocation, AgentEventListener, ToolExecutionResult } from "@vykor/agent-contracts";
import type { Settings } from "@vykor/host-config";
import { createExecutionEnvironment, resolveExecutionEnvironmentConfig } from "@vykor/sandbox";
import { createEnvironmentFileSystem } from "@vykor/tools";
import { SessionStore } from "@vykor/services";
import { createDaemonAgentLoader } from "../../../packages/server/src/daemon/daemon-agent.js";

// Reusing the parent's bound environment would execute both descendants in rootCwd.
it.each(["sdk", "daemon"] as const)("%s binds actual child and nested child Shell processes to their own session directories", async mode => {
  const rootCwd = mkdtempSync(join(tmpdir(), "vk-session-environment-"));
  const childCwd = join(rootCwd, "child");
  const nestedCwd = join(rootCwd, "nested");
  mkdirSync(childCwd);
  mkdirSync(nestedCwd);
  const settings: Settings = {
    model: "offline",
    apiFormat: "openai",
    maxTurns: 4,
    permission: { mode: "full_access" },
    sandbox: { enabled: false },
    plugins: { enabled: false },
    memory: { enabled: false },
  };
  const leases: Array<{ sessionId: string; cwd: string; releases: number }> = [];
  const receipts: AgentChildInvocation[] = [];
  const outputs = new Map<string, ToolExecutionResult>();
  const snapshots = new Map<string, string>();
  let resumedRunId: string | undefined;
  let store: SessionStore | undefined;
  let agent: DefaultNodeAgent | undefined;
  const executionEnvironment: NonNullable<DefaultNodeAgentOptions["executionEnvironment"]> = async scope => {
    const base = await createExecutionEnvironment({
      config: resolveExecutionEnvironmentConfig({ surface: "desktop_managed", settings: scope.settings, cwd: scope.cwd }),
      settings: scope.settings,
      binding: { kind: "local", hostRoot: scope.cwd, executionRoot: scope.cwd },
      sessionId: scope.sessionId,
      userSkillsRoot: rootCwd,
    });
    const lease = { sessionId: scope.sessionId, cwd: scope.cwd, releases: 0 };
    leases.push(lease);
    return { ...base, files: createEnvironmentFileSystem(base), release: async () => {
      lease.releases++;
      await base.release();
    } };
  };
  const onEvent: AgentEventListener = event => {
    if (event.type === "child.created" && store) {
      store.sessions.create({ id: event.data.sessionId, parentId: event.context.agentId,
        cwd: event.data.cwd, model: "offline", metadata: { runtime: { model: "offline", approvalMode: "full_access" } } });
    }
    if (event.type === "tool.completed" && event.data.toolUseId.endsWith("-shell")) {
      outputs.set(event.data.toolUseId, event.data.result as ToolExecutionResult);
    }
  };
  const common: DefaultNodeAgentOptions = {
    ownsExecutionEnvironment: true,
    extensions: [],
    capabilityOverrides: { terminal: false, backgroundShell: false },
    tools: [{
      name: "SpawnChild",
      description: "Create the next test worker",
      inputSchema: { type: "object", properties: { depth: { type: "number" } } },
      execute: async (input, context) => {
        const depth = (input as { depth: number }).depth;
        if (depth === 3) {
          const receipt = await agent!.children.get(receipts[1]!.id)!.send({ content: "nested-resumed" }, context.agent!.tools);
          resumedRunId = receipt.runId;
          return { content: [{ type: "text", text: "resumed" }] };
        }
        const receipt = await context.agent!.children.spawnChildAgent({
          prompt: depth === 1 ? "child" : "nested",
          description: "session environment regression",
          agent: "worker",
          cwd: depth === 1 ? childCwd : nestedCwd,
          allowedTools: depth === 1 ? ["Shell", "SpawnChild"] : ["Shell"],
        });
        receipts.push(receipt);
        return { content: [{ type: "text", text: "spawned" }] };
      },
    }],
    effects: { requestPermission: async () => ({ status: "approved" }) },
    onRunCapabilities: snapshot => {
      snapshots.set(snapshot.scope.sessionId, snapshot.executionEnvironment!.workspace.hostRoot);
    },
    client: {
      async *streamMessage({ messages }) {
        const userIndex = messages.map(message => message.type).lastIndexOf("user");
        const user = messages[userIndex];
        const label = typeof user?.content === "string" ? user.content : "";
        const toolResults = messages.slice(userIndex + 1).filter(message => message.type === "tool_result");
        if (toolResults.length === 0 || (label === "child" && toolResults.length === 1)) {
          const shell = label !== "root" && label !== "resume" && toolResults.length === 0;
          const command = process.platform === "win32"
            ? `& '${process.execPath.replaceAll("'", "''")}' -e "process.stdout.write(process.cwd())"`
            : `'${process.execPath.replaceAll("'", "'\\''")}' -e 'process.stdout.write(process.cwd())'`;
          yield {
            type: "tool_use_start",
            toolUse: {
              type: "tool_use",
              id: shell ? `${label}-shell` : `${label}-spawn`,
              name: shell ? "Shell" : "SpawnChild",
              input: shell ? { command, timeout: 10000 } : { depth: label === "root" ? 1 : label === "resume" ? 3 : 2 },
            },
          };
          yield { type: "complete", stopReason: "tool_use" };
        } else {
          yield { type: "complete", stopReason: "end_turn" };
        }
      },
    },
  };
  try {
    if (mode === "daemon") {
      store = new SessionStore({ path: join(rootCwd, "sessions.db") });
      const session = store.sessions.create({ id: "environment-root", cwd: rootCwd, model: "offline", metadata: { runtime: { model: "offline", approvalMode: "full_access" } } });
      const loader = createDaemonAgentLoader({
        settings,
        getSession: id => store!.sessions.get(id),
        acquireEnvironment: (owner, effectiveSettings) => executionEnvironment({ sessionId: owner.id, cwd: owner.cwd, settings: effectiveSettings }),
        createEventSink: () => onEvent,
        createAgent: async ({ options }) => {
          const node = await createDefaultNodeAgent({ ...options, ...common });
          return { agent: node, host: node.host };
        },
      })!;
      agent = (await loader({ session, history: [], parts: [] })).agent as DefaultNodeAgent;
    } else {
      agent = await createDefaultNodeAgent({ ...common, cwd: rootCwd, sessionId: "environment-root", settings, executionEnvironment, onEvent });
    }
    await agent.runMessage("root");
    for (const receipt of receipts) await agent.children.get(receipt.id)!.waitRun(receipt.runId);
    expect(receipts).toHaveLength(2);
    expect(outputs.get("child-shell")?.isError).not.toBe(true);
    expect(outputs.get("nested-shell")?.isError).not.toBe(true);
    expect(outputs.get("child-shell")?.content).toEqual([{ type: "text", text: childCwd }]);
    expect(outputs.get("nested-shell")?.content).toEqual([{ type: "text", text: nestedCwd }]);
    expect(snapshots.get(agent.children.get(receipts[0]!.id)!.sessionId)).toBe(childCwd);
    expect(snapshots.get(agent.children.get(receipts[1]!.id)!.sessionId)).toBe(nestedCwd);
    expect(leases.map(lease => lease.cwd)).toEqual([rootCwd, childCwd, nestedCwd]);
    const nested = agent.children.get(receipts[1]!.id)!;
    expect(await nested.requestSuspend!(receipts[1]!.runId)).toBe(true);
    expect(leases.map(lease => lease.releases)).toEqual([0, 0, 1]);
    await agent.runMessage("resume");
    await nested.waitRun(resumedRunId!);
    expect(outputs.get("nested-resumed-shell")?.content).toEqual([{ type: "text", text: nestedCwd }]);
    expect(leases.map(lease => lease.cwd)).toEqual([rootCwd, childCwd, nestedCwd, nestedCwd]);
    expect(leases[3]!.sessionId).toBe(leases[2]!.sessionId);
  } finally {
    await agent?.close();
    store?.close();
    rmSync(rootCwd, { recursive: true, force: true });
  }
  expect(leases.map(lease => lease.releases)).toEqual([1, 1, 1, 1]);
});
