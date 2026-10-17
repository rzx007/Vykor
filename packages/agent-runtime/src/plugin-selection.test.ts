import { describe, expect, it } from "vitest";
import type { AgentEventInput, StreamMessageParams, StreamingMessageClient } from "@vykor/core";
import { selectPlugin } from "./plugin-selection.js";

const candidates = [
  { pluginId: "knowledge", displayName: "研究与写作", description: "核验来源和写作", version: "1", behaviorDigest: "a" },
  { pluginId: "office", displayName: "办公文档", description: "编辑 DOCX XLSX PPTX", version: "2", behaviorDigest: "b" },
];
function fixture(output = '{"pluginId":"office"}') {
  const requests: StreamMessageParams[] = [];
  const events: AgentEventInput[] = [];
  const client: StreamingMessageClient = { async *streamMessage(params) {
    requests.push(params);
    yield { type: "text_delta", delta: output };
    yield { type: "usage", usage: { inputTokens: 42, outputTokens: 7 } };
    yield { type: "complete", stopReason: "end_turn" };
  } };
  return { requests, events, options: { client, model: "current-model", candidates, text: "将报告做成 PPT", signal: new AbortController().signal,
    emit: async (event: AgentEventInput) => { events.push(event); } } };
}
describe("plugin selection", () => {
  it("makes one tool-free request and returns the exact catalog identity without exposing full skills", async () => {
    const f = fixture();
    expect(await selectPlugin(f.options)).toMatchObject({ pluginId: "office", version: "2", behaviorDigest: "b", reason: "matched" });
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0]).toMatchObject({ model: "current-model", tools: [], maxTokens: 256 });
    expect(JSON.stringify(f.requests[0].messages)).toContain("核验来源和写作");
    expect(f.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "model.attempt.started", data: expect.objectContaining({ purpose: "plugin_selection" }) }),
      expect.objectContaining({ type: "model.attempt.finished", data: expect.objectContaining({ usage: { inputTokens: 42, outputTokens: 7 } }) }),
    ]));
  });
  it.each(['{"pluginId":null}', '{"pluginId":"uninstalled"}', '{"pluginId":["office","knowledge"]}', '```json\n{"pluginId":"office"}\n```', '{broken'])
    ("does not grant a plugin for invalid or empty output %s", async output => {
      const f = fixture(output);
      expect((await selectPlugin(f.options)).pluginId).toBeNull();
      expect(f.requests).toHaveLength(1);
    });
  it("does not call a model when no candidates exist", async () => {
    const f = fixture();
    expect((await selectPlugin({ ...f.options, candidates: [] })).pluginId).toBeNull();
    expect(f.requests).toHaveLength(0);
  });
  it("falls back once on model failure and records the failed attempt", async () => {
    const f = fixture();
    let calls = 0;
    const client: StreamingMessageClient = { async *streamMessage() { calls++; throw new Error("offline"); } };
    expect(await selectPlugin({ ...f.options, client })).toMatchObject({ pluginId: null, reason: "selection_failed" });
    expect(calls).toBe(1);
    expect(f.events).toContainEqual(expect.objectContaining({ type: "model.attempt.finished", data: expect.objectContaining({ status: "failed" }) }));
  });
  it("honors cancellation without falling back into the main execution", async () => {
    const f = fixture();
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(selectPlugin({ ...f.options, signal: controller.signal })).rejects.toThrow("cancelled");
    expect(f.requests).toHaveLength(0);
  });
  it("settles a cancelled in-flight selection and propagates cancellation", async () => {
    const f = fixture();
    const controller = new AbortController();
    let calls = 0;
    const client: StreamingMessageClient = { async *streamMessage() {
      calls++;
      yield { type: "usage", usage: { inputTokens: 4, outputTokens: 1 } };
      controller.abort(new Error("stopped during selection"));
      throw controller.signal.reason;
    } };
    await expect(selectPlugin({ ...f.options, client, signal: controller.signal })).rejects.toThrow("stopped during selection");
    expect(calls).toBe(1);
    expect(f.events).toContainEqual(expect.objectContaining({ type: "model.attempt.finished", data: expect.objectContaining({ status: "interrupted" }) }));
  });
  it("rejects a model tool call even when it also returns a valid plugin ID", async () => {
    const f = fixture();
    const client: StreamingMessageClient = { async *streamMessage() {
      yield { type: "text_delta", delta: '{"pluginId":"office"}' };
      yield { type: "tool_use_start", toolUse: { type: "tool_use", id: "forged", name: "InstallPlugin", input: {} } };
      yield { type: "complete", stopReason: "tool_use" };
    } };
    expect(await selectPlugin({ ...f.options, client })).toMatchObject({ pluginId: null, reason: "selection_failed" });
  });
  it("checks the model budget before dispatch", async () => {
    const f = fixture();
    const { AgentExecutionLimitError } = await import("@vykor/core");
    await expect(selectPlugin({ ...f.options, limits: { check: () => { throw new AgentExecutionLimitError("budget exhausted"); } } }))
      .rejects.toThrow("budget exhausted");
    expect(f.requests).toHaveLength(0);
  });
});
