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
            : { type: "tool_use", id: "observe", name: "SessionObserve", input: {} },
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
