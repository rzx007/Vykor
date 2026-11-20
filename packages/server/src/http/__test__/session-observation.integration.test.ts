import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import type { StreamingMessageClient, StreamMessageParams } from "@vykor/agent-contracts";
import { createDefaultNodeAgent } from "@vykor/agent-runtime";
import { CURRENT_PROTOCOL_VERSION, PROTOCOL_VERSION_HEADER } from "@vykor/protocol";

import type { AdmitPromptResult } from "../../application/session/index.js";
import { VykorHttpServer } from "../server.js";

it.each([
  { policy: "ordinary", visible: true, deniedTools: undefined, runtime: {} },
  { policy: "custom name collision", visible: true, deniedTools: undefined, runtime: {} },
  { policy: "global deny", visible: false, deniedTools: ["SessionObserve"], runtime: {} },
  { policy: "session deny", visible: false, deniedTools: undefined, runtime: { disallowedTools: ["SessionObserve"] } },
  { policy: "session allowlist", visible: false, deniedTools: undefined, runtime: { allowedTools: ["Read"] } },
  { policy: "coordinator", visible: false, deniedTools: undefined, runtime: { sessionMode: "coordinator" } },
  { policy: "switches to plan", visible: true, deniedTools: undefined, runtime: {} },
])("limits SessionObserve to the authorized HTTP Run and its tool policy ($policy)", async ({ policy, visible, deniedTools, runtime }) => {
  const hasCustomTool = policy === "custom name collision";
  const switchesToPlan = policy === "switches to plan";
  const directory = mkdtempSync(join(tmpdir(), "vk-session-observation-"));
  const targetSessionId = "observation-target";
  const sourceSessionId = "observation-source";
  const privatePrompt = "private target prompt";
  const privateReply = "private target reply";
  let releaseTargetGate!: () => void;
  const targetAdvanced = new Promise<void>((resolve) => {
    releaseTargetGate = resolve;
  });
  const sourceRequests: StreamMessageParams[] = [];
  const sourceClient: StreamingMessageClient = {
    async *streamMessage(params) {
      sourceRequests.push({ ...params, messages: structuredClone(params.messages) });
      if (sourceRequests.length === 1 || (switchesToPlan && sourceRequests.length === 2)) {
        if (sourceRequests.length === 1) await targetAdvanced;
        const enterPlan = switchesToPlan && sourceRequests.length === 1;
        yield {
          type: "tool_use_start",
          toolUse: enterPlan
            ? { type: "tool_use", id: "plan", name: "EnterPlanMode", input: {} }
            : { type: "tool_use", id: "observe", name: "SessionObserve", input: { timeoutMs: 100 } },
        };
        yield { type: "complete", stopReason: "tool_use" };
        return;
      }
      yield { type: "text_delta", delta: "Ready." };
      yield { type: "complete", stopReason: "end_turn" };
    },
  };
  const targetClient: StreamingMessageClient = {
    async *streamMessage() {
      yield { type: "text_delta", delta: privateReply };
      yield { type: "complete", stopReason: "end_turn" };
    },
  };
  const server = new VykorHttpServer({
    storePath: join(directory, "state.db"),
    settings: {
      model: "test-model",
      apiFormat: "openai",
      maxTurns: 3,
      permission: { mode: switchesToPlan ? "full_access" : "ask", deniedTools },
      plugins: { enabled: false },
      memory: { enabled: false },
      sandbox: { enabled: false },
    },
    async createAgent(context) {
      const client = context.session.id === sourceSessionId ? sourceClient : targetClient;
      const tools = [...(context.options.tools ?? [])];
      if (hasCustomTool && context.session.id === sourceSessionId) {
        tools.push({
          name: "SessionObserve",
          description: "An existing unrelated custom tool.",
          inputSchema: { type: "object" },
          async execute() { throw new Error("The custom tool must not execute in an observation Run"); },
        });
      }
      const agent = await createDefaultNodeAgent({ ...context.options, client, tools });
      return { agent, host: agent.host };
    },
    logger: () => {},
  });

  try {
    const { url } = await server.listen();
    const post = (path: string, body: unknown) => fetch(url + path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [PROTOCOL_VERSION_HEADER]: String(CURRENT_PROTOCOL_VERSION),
      },
      body: JSON.stringify(body),
    });
    const submit = async (sessionId: string, text: string) => {
      const response = await post("/sessions/" + sessionId + "/prompts", {
        items: [{ type: "text", text }],
      });
      const body = await response.json() as AdmitPromptResult;
      expect(response.status, JSON.stringify(body)).toBe(202);
      expect(body.run).toBeDefined();
      return body.run!.id;
    };
    const awaitRun = (sessionId: string, runId: string) =>
      server.application.runControl.awaitRun(sessionId, runId, { timeoutMs: 15_000 });
    for (const id of [targetSessionId, sourceSessionId]) {
      const response = await post("/sessions", {
        id, cwd: directory, model: "test-model",
        ...(id === sourceSessionId ? { metadata: { runtime } } : {}),
      });
      expect(response.status, await response.text()).toBe(201);
    }

    const pinnedRunId = await submit(targetSessionId, privatePrompt);
    expect(await awaitRun(targetSessionId, pinnedRunId)).toMatchObject({ status: "completed", output: privateReply });
    const observingRunId = await submit(sourceSessionId, "observe-session " + targetSessionId + "\nCheck the target's progress.");

    const laterRunId = await submit(targetSessionId, "Continue working.");
    expect(laterRunId).not.toBe(pinnedRunId);
    expect(await awaitRun(targetSessionId, laterRunId)).toMatchObject({ status: "completed" });
    releaseTargetGate();
    expect(await awaitRun(sourceSessionId, observingRunId)).toMatchObject({ status: "completed" });

    const advertised = sourceRequests[0]?.tools?.some(tool => tool.name === "SessionObserve") ?? false;
    expect(advertised).toBe(visible);
    if (switchesToPlan) {
      const plan = sourceRequests[1]?.messages.find(message => message.type === "tool_result" && message.toolUseId === "plan");
      expect(plan).toBeDefined();
      expect(plan?.isError).not.toBe(true);
    }
    const result = sourceRequests[switchesToPlan ? 2 : 1]?.messages.find(message => message.type === "tool_result" && message.toolUseId === "observe");
    if (!visible || switchesToPlan) {
      expect(result).toBeDefined();
      expect(result?.isError).toBe(true);
      expect(JSON.stringify(result)).not.toContain(pinnedRunId);
      return;
    }
    expect(result).toBeDefined();
    expect(result?.isError).not.toBe(true);
    const snapshot = result?.content[0];
    if (snapshot?.type !== "text") throw new Error("SessionObserve did not return a snapshot");
    expect(JSON.parse(snapshot.text)).toEqual({
      targetSessionId,
      targetRunId: pinnedRunId,
      status: "completed",
      updatedAt: expect.any(Number),
      pending: [],
      timedOut: false,
    });
    expect(JSON.stringify(result)).not.toContain(privatePrompt);
    expect(JSON.stringify(result)).not.toContain(privateReply);

    const ordinaryRunId = await submit(sourceSessionId, "Keep working here.");
    expect(await awaitRun(sourceSessionId, ordinaryRunId)).toMatchObject({ status: "completed" });
    expect(sourceRequests).toHaveLength(3);
    const laterTool = sourceRequests[2]?.tools?.find(tool => tool.name === "SessionObserve");
    expect(laterTool?.description).toBe(hasCustomTool ? "An existing unrelated custom tool." : undefined);
  } finally {
    releaseTargetGate();
    await server.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it.each([
  { policy: "default approval", decision: "approved" },
  { policy: "default refusal", decision: "denied" },
  { policy: "explicit allow over a same-name custom tool" },
  { policy: "explicit deny" },
  { policy: "source already bound to a channel" },
  { policy: "source rebound before approval", decision: "approved" },
  { policy: "revoked at runtime" },
] as const)("applies ordinary tool permissions to SessionLookup ($policy)", async scenario => {
  const directory = mkdtempSync(join(tmpdir(), "vk-session-discovery-"));
  const sourceSessionId = "lookup-source";
  const targetSessionId = "not-returned-as-an-id";
  const privatePrompt = "private target prompt";
  const privateReply = "private target reply";
  const explicitAllow = scenario.policy === "explicit allow over a same-name custom tool";
  const explicitDeny = scenario.policy === "explicit deny";
  const switchToPlan = scenario.policy === "revoked at runtime";
  const alreadyBound = scenario.policy === "source already bound to a channel";
  const rebound = scenario.policy === "source rebound before approval";
  const decision = "decision" in scenario ? scenario.decision : undefined;
  const customDescription = "An existing unrelated custom tool.";
  const requests: StreamMessageParams[] = [];
  const server = new VykorHttpServer({
    storePath: join(directory, "state.db"),
    settings: {
      model: "test-model", apiFormat: "openai", maxTurns: 4,
      permission: {
        mode: switchToPlan ? "full_access" : "default",
        ...(explicitAllow ? { autoApproveTools: ["SessionLookup"] } : {}),
        ...(explicitDeny ? { deniedTools: ["SessionLookup"] } : {}),
      },
      plugins: { enabled: false }, memory: { enabled: false }, sandbox: { enabled: false },
    },
    async createAgent(context) {
      const client: StreamingMessageClient = {
        async *streamMessage(params) {
          if (context.session.id === sourceSessionId) {
            requests.push({ ...params, messages: structuredClone(params.messages) });
            if (switchToPlan && requests.length === 1) {
              yield { type: "tool_use_start", toolUse: { type: "tool_use", id: "plan", name: "EnterPlanMode", input: {} } };
              yield { type: "complete", stopReason: "tool_use" };
              return;
            }
            if (requests.length === (switchToPlan ? 2 : 1)) {
              yield { type: "tool_use_start", toolUse: { type: "tool_use", id: "lookup", name: "SessionLookup", input: { query: "桌面" } } };
              yield { type: "complete", stopReason: "tool_use" };
              return;
            }
          }
          yield { type: "text_delta", delta: privateReply };
          yield { type: "complete", stopReason: "end_turn" };
        },
      };
      const tools = [...(context.options.tools ?? [])];
      if (explicitAllow && context.session.id === sourceSessionId) {
        tools.push({
          name: "SessionLookup", description: customDescription, inputSchema: { type: "object" },
          async execute() { throw new Error("The custom tool must not execute in an eligible Run"); },
        });
      }
      const agent = await createDefaultNodeAgent({ ...context.options, client, tools });
      return { agent, host: agent.host };
    },
    logger: () => {},
  });

  try {
    const { url } = await server.listen();
    const post = (path: string, body: unknown) => fetch(url + path, {
      method: "POST",
      headers: { "content-type": "application/json", [PROTOCOL_VERSION_HEADER]: String(CURRENT_PROTOCOL_VERSION) },
      body: JSON.stringify(body),
    });
    const submit = async (sessionId: string, text: string, id: string) => {
      const response = await post(`/sessions/${sessionId}/prompts`, { id, items: [{ type: "text", text }] });
      const body = await response.json() as AdmitPromptResult;
      expect(response.status, JSON.stringify(body)).toBe(202);
      expect(body.run).toBeDefined();
      return body.run!;
    };
    const awaitRun = (sessionId: string, runId: string) => server.application.runControl.awaitRun(sessionId, runId, { timeoutMs: 15_000 });
    for (const [id, title] of [[targetSessionId, "桌面   打包. 保留标点"], [sourceSessionId, "Lookup"]]) {
      const response = await post("/sessions", { id, title, cwd: directory, model: "test-model" });
      expect(response.status, await response.text()).toBe(201);
    }
    const targetRun = await submit(targetSessionId, privatePrompt, "target-prompt");
    expect(await awaitRun(targetSessionId, targetRun.id)).toMatchObject({ status: "completed" });
    const bindSource = () => server.store.channels.upsertConversation({ connector: "example", accountId: "account", chatId: "chat", sessionId: sourceSessionId });
    if (alreadyBound) bindSource();
    if (scenario.policy === "default approval") {
      const previous = server.store.permissions.create({ sessionId: sourceSessionId, toolName: "SessionLookup" });
      server.store.permissions.reply({ requestId: previous.id, status: "approved", decision: "session" });
    }
    const sourceRun = await submit(sourceSessionId, "Check the progress of 桌面.", "lookup-prompt");
    expect(sourceRun.metadata).toHaveProperty("sessionLookupAllowed", true);
    expect(sourceRun.metadata).not.toHaveProperty("sessionObservationGrant");
    expect((await submit(sourceSessionId, "Check the progress of 桌面.", "lookup-prompt")).id).toBe(sourceRun.id);
    await expect.poll(() => requests.length, { timeout: 5_000 }).toBeGreaterThan(0);
    expect(requests[0]?.tools?.some(tool => tool.name === "SessionObserve")).toBe(false);
    expect(requests[0]?.tools?.some(tool => tool.name === "SessionLookup")).toBe(!explicitDeny && !alreadyBound);
    if (decision) {
      const pending = () => server.store.permissions.list({ sessionId: sourceSessionId, status: "pending" });
      await expect.poll(() => pending().map(request => request.toolName), { timeout: 5_000 }).toEqual(["SessionLookup"]);
      expect(requests).toHaveLength(1);
      expect(pending()[0]!.payload).toMatchObject({ confirmation: "once", input: { query: "桌面" } });
      expect(pending()[0]!.payload).not.toHaveProperty("reusedApprovalRequestId");
      if (rebound) bindSource();
      const approval = await post(`/permissions/${pending()[0]!.id}/reply`, { status: decision, decision: "session" });
      const reply = await approval.json();
      expect(approval.status, JSON.stringify(reply)).toBe(200);
      if (decision === "approved") expect(reply.request).toMatchObject({ decision: "once" });
    }
    expect(await awaitRun(sourceSessionId, sourceRun.id)).toMatchObject({ status: "completed" });
    if (switchToPlan) {
      expect(requests[1]?.messages.find(message => message.type === "tool_result" && message.toolUseId === "plan")?.isError).not.toBe(true);
    }
    const result = requests.at(-1)?.messages.find(message => message.type === "tool_result" && message.toolUseId === "lookup");
    expect(result).toBeDefined();
    if ((decision === "approved" && !rebound) || explicitAllow) {
      expect(result?.isError).not.toBe(true);
      const content = result?.content[0];
      if (content?.type !== "text") throw new Error("Expected a JSON SessionLookup result");
      expect(JSON.parse(content.text)).toEqual({
        matches: [{ title: "桌面 打包. 保留标点", status: "completed", updatedAt: expect.any(Number) }],
        hasMore: false,
      });
    } else {
      expect(result?.isError).toBe(true);
      expect(JSON.stringify(result)).not.toContain("保留标点");
    }
    expect(JSON.stringify(result)).not.toContain(privatePrompt);
    expect(JSON.stringify(result)).not.toContain(privateReply);
    expect(JSON.stringify(result)).not.toContain(targetSessionId);
    expect(JSON.stringify(result)).not.toContain(targetRun.id);
    if (!decision) expect(server.store.permissions.list({ sessionId: sourceSessionId })).toEqual([]);
    if (explicitAllow) {
      const expectOnlyCustomLookup = async (submit: () => Promise<AdmitPromptResult>) => {
        const previousRequests = requests.length;
        const admitted = await submit();
        expect(admitted.run).toBeDefined();
        expect(admitted.run!.metadata).not.toHaveProperty("sessionLookupAllowed");
        expect(await awaitRun(sourceSessionId, admitted.run!.id)).toMatchObject({ status: "completed" });
        expect(requests).toHaveLength(previousRequests + 1);
        expect(requests.at(-1)?.tools?.find(tool => tool.name === "SessionLookup")?.description).toBe(customDescription);
      };
      // The same-name registration remains available through ordinary runtime policy on indirect Runs.
      await expectOnlyCustomLookup(() => server.application.interactions.admitPrompt(sourceSessionId, {
        items: [{ type: "text", text: "Indirect submission." }],
      }));

      const { run: interrupted } = server.store.conversationTransactions.admitPromptWithRun({
        prompt: { sessionId: sourceSessionId, delivery: "queue", items: [{ type: "text", text: "Interrupted work." }] },
        run: { metadata: { sessionLookupAllowed: true } },
      });
      server.store.runs.updateRun(interrupted.id, { status: "interrupted" });
      await expectOnlyCustomLookup(async () => {
        const response = await post(`/sessions/${sourceSessionId}/runs/${interrupted.id}/resume`, { id: "replayed-lookup" });
        const resumed = await response.json() as AdmitPromptResult;
        expect(response.status, JSON.stringify(resumed)).toBe(202);
        expect(resumed.run?.metadata).toMatchObject({ recovery: { kind: "prompt_replay", sourceRunId: interrupted.id } });
        return resumed;
      });
    }
  } finally {
    await server.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
