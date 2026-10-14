import { expect, it } from "vitest";
import * as protocol from "./index.js";

const instanceId = "10000000-0000-4000-8000-000000000001";
const requestId = "30000000-0000-4000-8000-000000000001";
const request = { mode: "draft", expectedRevision: 0, text: "解释", data: { count: 1 } };

it.each(["request", "http"] as const)("bounds %s conversation data at exactly 32KiB", entry => {
  // {"text":""} contributes 11 bytes; the CJK text contributes 32757 bytes.
  const data = { text: "中".repeat(10919) };
  expect(new TextEncoder().encode(JSON.stringify(data)).byteLength).toBe(32768);
  const parse = (value: typeof data) => entry === "request"
    ? protocol.parsePluginUiConversationRequest({ ...request, data: value })
    : protocol.parseSubmitPluginUiConversationInput({ requestId, expectedRevision: 0, text: "解释", data: value });
  expect(parse(data).data).toEqual(data);
  let error: unknown;
  try { parse({ text: data.text + "x" }); } catch (caught) { error = caught; }
  expect(error).toMatchObject({ code: "invalid_request", details: { field: "data", reason: "payload_too_large" } });
});

it.each(["", " \n\t"])("rejects empty conversation text even when structured data is present", text => {
  expect(() => protocol.parsePluginUiConversationRequest({ ...request, text })).toThrow();
  expect(() => protocol.parseSubmitPluginUiConversationInput({
    requestId, expectedRevision: 0, text, data: { count: 1 },
  })).toThrow();
});

it("reads exact requests and HTTP submissions without inventing host identity", () => {
  expect(protocol.parsePluginUiConversationRequest(request)).toEqual(request);
  const { mode, ...body } = request;
  expect(protocol.parseSubmitPluginUiConversationInput({ ...body, requestId })).toEqual({ ...body, requestId });
  for (const changes of [{ mode: "unknown" }, { expectedRevision: -1 }, { text: undefined },
    { data: undefined }, { data: { n: NaN } }, { requestId }, { text: "😀".repeat(4097) }])
    expect(() => protocol.parsePluginUiConversationRequest({ ...request, ...changes })).toThrow();
  expect(protocol.parsePluginUiConversationRequest({ ...request, text: "😀".repeat(4096) }).text.length).toBe(8192);
  expect(() => protocol.parseSubmitPluginUiConversationInput({ ...request, requestId })).toThrow();
});

it("bounds prepared prompts by final bytes rather than request text characters", () => {
  const prepared = { mode: "submit", instanceId, revision: 1, promptText: "中".repeat(5000) };
  expect(protocol.parsePluginUiConversationPrepared(prepared)).toEqual(prepared);
  expect(() => protocol.parsePluginUiConversationPrepared({ ...prepared, promptText: "中".repeat(22000) })).toThrow();
  expect(() => protocol.parsePluginUiConversationPrepared({ ...prepared, extra: true })).toThrow();
});

it("distinguishes draft and submit receipts and rejects incomplete receipt branches", () => {
  const draft = { kind: "conversation", mode: "draft", instanceId, revision: 1, added: true };
  const submit = { kind: "conversation", mode: "submit", instanceId, revision: 2, requestId,
    inputId: "input", runId: "run", status: "pending" };
  for (const receipt of [draft, submit])
    expect(protocol.parsePluginUiConversationReceipt(receipt)).toEqual(receipt);
  for (const receipt of [{ ...draft, added: false }, { ...draft, requestId }, { ...submit, inputId: undefined },
    { ...submit, kind: "other" }, { ...submit, status: "unknown" }])
    expect(() => protocol.parsePluginUiConversationReceipt(receipt)).toThrow();
});

it("reads only current submission records with durable identity and finite acceptance time", () => {
  const record = { schemaVersion: 2, requestId, requestFingerprint: "a".repeat(64), expectedRevision: 1,
    inputId: "input", runId: "run", pluginDigest: "b".repeat(64), componentDigest: "c".repeat(64), acceptedAt: 0 };
  expect(protocol.parsePluginUiSubmissionRecord(record)).toEqual(record);
  for (const changes of [{ schemaVersion: 1 }, { acceptedAt: -1 }, { acceptedAt: 1.5 },
    { acceptedAt: Infinity }, { requestFingerprint: "bad" }, { inputId: "" }, { extra: true }])
    expect(() => protocol.parsePluginUiSubmissionRecord({ ...record, ...changes })).toThrow();
});
