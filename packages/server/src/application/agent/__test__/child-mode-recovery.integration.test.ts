import {hostedAgentFactory} from "../../../../test-helpers/hosted-agent.js";
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentChildInvocation, AgentEvent, StreamMessageParams, StreamingMessageClient } from "@vykor/agent-contracts";
import type { PermissionMode, Settings } from "@vykor/host-config";
import { createDefaultNodeAgent, type VykorAgentOptions } from "@vykor/agent-runtime";
import { SessionStore } from "@vykor/services";
import { patchSessionRuntimeMetadata, readSessionRuntimeConfig } from "../../session/configuration/runtime-configuration.js";
import { DaemonAgentEventProjector } from "../daemon-agent-event-projector.js";
import { LiveChildAgentDirectory } from "../live-child-agent-directory.js";
import { AgentPool } from "../agent-pool.js";
import { SessionEventPublisher } from "../../session/transcript/session-event-publisher.js";
import { SessionExecutionProjector } from "../../session/transcript/session-execution-projector.js";
import { SessionTranscriptProjection } from "../../session/transcript/transcript-projection.js";
import { createDaemonAgentLoader } from "../../../daemon/daemon-agent.js";

const directories: string[] = [];
const previousConfig = process.env.VYKOR_CONFIG_DIR;
afterEach(() => {
  if (previousConfig === undefined) delete process.env.VYKOR_CONFIG_DIR;
  else process.env.VYKOR_CONFIG_DIR = previousConfig;
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
const disabled = { terminal: false, backgroundShell: false, schedules: false, memory: false } as const;
const completeClient: StreamingMessageClient = { async *streamMessage() { yield { type: "text_delta", delta: "Child inspected the assigned scope." }; yield { type: "complete", stopReason: "end_turn" }; } };

describe("resolved-child-mode survives event persistence and cold daemon recovery", () => {
  it.each([
    { parentMode: "default", requestedMode: "full_auto", persistedParentMode: "default" },
    { parentMode: "plan", requestedMode: "full_auto", persistedParentMode: "plan" },
    { parentMode: "plan", requestedMode: undefined, persistedParentMode: "default" },
  ] as const)("keeps effective $parentMode when child requested $requestedMode and durable parent is $persistedParentMode", async ({ parentMode, requestedMode, persistedParentMode }) => {
    const cwd = mkdtempSync(join(tmpdir(), "oh-child-mode-recovery-")); directories.push(cwd);
    process.env.VYKOR_CONFIG_DIR = join(cwd, "config");
    const settings: Settings = { model: "offline", apiFormat: "openai", maxTurns: 5, permission: { mode: "default" }, plugins: { enabled: false }, memory: { enabled: false }, sandbox: { enabled: false } };
    const path = join(cwd, "sessions.db");
    let store = new SessionStore({ path });
    const parent = store.sessions.create({ cwd, model: "offline", metadata: { runtime: { model: "offline", permissionMode: persistedParentMode } } });
    let projector:DaemonAgentEventProjector;
    let created:Extract<AgentEvent,{type:"child.created"}>|undefined;
    const parentLoader = createDaemonAgentLoader({ settings, getSession: id => store.sessions.get(id),
      createEventSink:()=>async event=>{if(event.type==="child.created")created=event;await projector?.apply(event);},
      createAgent: hostedAgentFactory(({ options }) => { return createDefaultNodeAgent({ ...options, permissionMode: parentMode, client: completeClient, capabilityOverrides: disabled }); }),
    })!;
    const {agent:root} = await parentLoader({ session: parent, history: [], parts: [] });
    const rootInput=store.conversationTransactions.admitPrompt({id:"parent-input",sessionId:parent.id,content:"delegate"});
    store.runs.createRun({id:"parent-run",inputId:rootInput.id,sessionId:parent.id});
    store.runs.updateRun("parent-run",{status:"completed"});
    const publisher = new SessionEventPublisher(store.conversations, { broadcastSince: () => {}, broadcastEvent: () => {} });
    const liveChildren = new LiveChildAgentDirectory();
    projector = new DaemonAgentEventProjector({ projectorId: `daemon-agent:${root.id}`, rootSessionId: parent.id, rootAgent: root, store, liveChildren, events: publisher, log: () => {},
      transcriptProjection: new SessionTranscriptProjection(store),
    });
    let pool: AgentPool | undefined;
    try {
      const input = { description: "inspect assigned file", prompt: "Inspect only; no implementation authorized", agent: "worker", cwd, permissionMode: requestedMode };
      const {invocation}=await root.runChildForCompletedRun(input,{runId:"parent-run",inputId:"parent-input",traceId:"trace",signal:new AbortController().signal},input.prompt);
      await invocation.result;
      const initialChild = store.sessions.get(invocation.sessionId)!;
      store.sessions.update(initialChild.id, { metadata: patchSessionRuntimeMetadata(initialChild.metadata, { model: "offline-updated" }) });

      await root.close();
      const childId = invocation.sessionId;
      store.close(); store = new SessionStore({ path });
      const persisted = store.sessions.get(childId)!;
      const permissions: string[] = [];
      const requests: StreamMessageParams[] = [];
      const client: StreamingMessageClient = { async *streamMessage(params) {
        requests.push({ ...params, messages: structuredClone(params.messages) });
        if (requests.length === 1) yield { type: "tool_use_start", toolUse: { type: "tool_use", id: "cold-write", name: "Write", input: { file_path: "unauthorized-cold-child.txt", content: "forbidden" } } };
        yield { type: "complete", stopReason: requests.length === 1 ? "tool_use" : "end_turn" };
      } };
      const loader = createDaemonAgentLoader({ settings, getSession: id => store.sessions.get(id),
        requestPermission: async request => { permissions.push(request.toolName); return { status: "denied" }; },
        createAgent: hostedAgentFactory(({ options }) => createDefaultNodeAgent({ ...options, client, capabilityOverrides: { ...options.capabilityOverrides, ...disabled } })),
      })!;
      pool = new AgentPool({ sessionQueries: { getSession: id => store.sessions.get(id), listSessions: options => store.sessions.list(options), listMessages: id => store.conversations.listMessages(id), listMessageParts: id => store.conversations.listMessageParts(id) }, loadAgent: hostedAgentFactory(loader),
        isSessionExternallyOwned: id => liveChildren.has(id),
      });
      const cold = await pool.acquireSession(childId);
      await cold.runMessage("Resume the assigned child scope; keep the existing permissions.");
      const persistedMode = readSessionRuntimeConfig(persisted).permissionMode;
      console.info("CHILD RECOVERY: initial=%s event=%s persisted=%s parent=%s approvals=%s fileWritten=%s", created?.data.spawn.permissionMode, created?.data.spawn.permissionMode, persistedMode, parentMode, permissions.join(","), existsSync(join(cwd, "unauthorized-cold-child.txt")));

      expect(created?.data.spawn.permissionMode).toBe(parentMode);
      expect(persistedMode).toBe(parentMode);
      expect(input.permissionMode).toBe(requestedMode); // The caller's request was not rewritten.
      expect(requests[0]!.system).toContain(parentMode === "plan" ? "Plan mode is enabled" : "Default permission mode");
      expect(permissions).toEqual(parentMode === "default" ? ["Write"] : []);
      expect(existsSync(join(cwd, "unauthorized-cold-child.txt"))).toBe(false);
      expect(requests[0]?.model).toBe("offline-updated");
    } finally { await pool?.closeAll(); await root.close(); store.close(); }
  });

  it.each([
    { requestedMode: undefined, expectedApproval: "full_access", expectedPermission: "full_auto", approvalsPerRun: 0, writes: true },
    { requestedMode: "default", expectedApproval: "ask", expectedPermission: "default", approvalsPerRun: 1, writes: false },
    { requestedMode: "plan", expectedApproval: "full_access", expectedPermission: "plan", approvalsPerRun: 0, writes: false },
  ] as const)("keeps full-access child authorization across live execution and cold recovery (requested=$requestedMode)", async ({ requestedMode, expectedApproval, expectedPermission, approvalsPerRun, writes }) => {
    // Sandboxed Windows permits atomic file replacement within the writable workspace.
    const cwd = mkdtempSync(join(process.cwd(), ".test-full-access-child-recovery-")); directories.push(cwd);
    process.env.VYKOR_CONFIG_DIR = join(cwd, "config");
    writeFileSync(join(cwd, "live.txt"), "before");
    writeFileSync(join(cwd, "cold.txt"), "before");
    // The conversation override must win over the host's ordinary approval default.
    const settings: Settings = { model: "offline", apiFormat: "openai", maxTurns: 4, permission: { mode: "ask" },
      plugins: { enabled: false }, memory: { enabled: false }, sandbox: { enabled: false } };
    const database = join(cwd, "sessions.db");
    let store = new SessionStore({ path: database });
    const parent = store.sessions.create({ cwd, model: "offline", metadata: {
      runtime: { model: "offline", approvalMode: "full_access", workMode: "execute" },
    } });
    const approvals: string[] = [];
    const toolErrors: unknown[] = [];
    let invocation: AgentChildInvocation | undefined;
    const writer = (phase: "live" | "cold"): StreamingMessageClient => {
      return { async *streamMessage({ messages }) {
        const userIndex = messages.map(message => message.type).lastIndexOf("user");
        const rootRequest = messages[userIndex]?.content === "delegate a file write";
        const hasResult = messages.slice(userIndex + 1).some(message => message.type === "tool_result");
        if (!hasResult && rootRequest) {
          yield { type: "tool_use_start", toolUse: { type: "tool_use", id: "spawn-writer", name: "SpawnWriter", input: {} } };
          yield { type: "complete", stopReason: "tool_use" };
        } else if (!hasResult) {
          yield { type: "tool_use_start", toolUse: { type: "tool_use", id: `${phase}-write`, name: "Write",
            input: { file_path: join(cwd, `${phase}.txt`), content: phase } } };
          yield { type: "complete", stopReason: "tool_use" };
        } else {
          yield { type: "text_delta", delta: `${phase} child finished` };
          yield { type: "complete", stopReason: "end_turn" };
        }
      } };
    };
    const denyUnexpectedApproval = async (request: { toolName: string }) => {
      approvals.push(request.toolName);
      return { status: "denied" as const };
    };
    let projector: DaemonAgentEventProjector | undefined;
    const loader = createDaemonAgentLoader({ settings, getSession: id => store.sessions.get(id),
      requestPermission: denyUnexpectedApproval,
      createEventSink: () => async event => {
        if (event.type === "tool.completed" && event.data.result.isError) toolErrors.push(event.data.result);
        await projector?.apply(event);
      },
      createAgent: hostedAgentFactory(({ options }) => createDefaultNodeAgent({ ...options, client: writer("live"), capabilityOverrides: disabled,
        tools: [{ name: "SpawnWriter", description: "Start the assigned child", inputSchema: { type: "object" },
          execute: async (_input, context) => {
            invocation = await context.agent!.children.spawnChildAgent({ description: "write assigned file", prompt: "Write the assigned file",
              agent: "worker", cwd, ...(requestedMode ? { permissionMode: requestedMode } : {}) });
            return { content: [{ type: "text", text: "Child started" }] };
          },
        }],
      })),
    })!;
    const { agent: root } = await loader({ session: parent, history: [], parts: [] });
    const publisher = new SessionEventPublisher(store.conversations, { broadcastSince: () => {}, broadcastEvent: () => {} });
    const liveChildren = new LiveChildAgentDirectory();
    projector = new DaemonAgentEventProjector({ projectorId: `daemon-agent:${root.id}`, rootSessionId: parent.id,
      rootAgent: root, store, liveChildren, events: publisher, log: () => {}, transcriptProjection: new SessionTranscriptProjection(store) });
    const input = store.conversationTransactions.admitPrompt({ id: "parent-input", sessionId: parent.id, content: "delegate a file write" });
    store.runs.createRun({ id: "parent-run", sessionId: parent.id, inputId: input.id });
    let pool: AgentPool | undefined;
    try {
      expect((await root.runMessage("delegate a file write", { ids: { runId: "parent-run", inputId: input.id, traceId: "full-access-child" } })).status).toBe("completed");
      expect(invocation).toBeDefined();
      expect((await invocation!.result).status).toBe("completed");
      expect(approvals).toHaveLength(approvalsPerRun);
      if (writes) expect(toolErrors).toEqual([]);
      expect(readFileSync(join(cwd, "live.txt"), "utf8")).toBe(writes ? "live" : "before");
      const childId = invocation!.sessionId;
      await root.close();
      store.close();
      store = new SessionStore({ path: database });
      const persisted = store.sessions.get(childId)!;
      expect(readSessionRuntimeConfig(persisted)).toMatchObject({
        approvalMode: expectedApproval, permissionMode: expectedPermission,
      });
      const coldLoader = createDaemonAgentLoader({ settings, getSession: id => store.sessions.get(id),
        requestPermission: denyUnexpectedApproval,
        createAgent: hostedAgentFactory(({ options }) => createDefaultNodeAgent({ ...options, client: writer("cold"), capabilityOverrides: disabled })),
      })!;
      pool = new AgentPool({ sessionQueries: { getSession: id => store.sessions.get(id), listSessions: options => store.sessions.list(options),
        listMessages: id => store.conversations.listMessages(id), listMessageParts: id => store.conversations.listMessageParts(id) },
        loadAgent: hostedAgentFactory(coldLoader) });
      const cold = await pool.acquireSession(childId);
      expect((await cold.runMessage("Resume the child and write its next assigned file")).status).toBe("completed");
      expect(approvals).toHaveLength(2 * approvalsPerRun);
      expect(readFileSync(join(cwd, "cold.txt"), "utf8")).toBe(writes ? "cold" : "before");
    } finally { await pool?.closeAll(); await root.close(); store.close(); }
  });
});
