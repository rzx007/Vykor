import { describe, expect, it } from "vitest";
import type { Message, StreamMessageParams, UsageSnapshot } from "@vykor/agent-contracts";
import { ContextInputMeasurement } from "../context-input-measurement.js";

const client = { async *streamMessage() {} };
const configuration = { revision: 1, model: "m", client };
const first: Message = { type: "user", content: "covered" };
const request: StreamMessageParams = { model: "m", messages: [first], system: "rules" };
function complete(inputIncludesCache: boolean): UsageSnapshot {
  return { inputTokens: inputIncludesCache ? 100 : 10, outputTokens: 2,
    cacheReadTokens: 80, cacheCreationTokens: 10, metering: { knownInputTokens: 100, knownOutputTokens: 2,
      completeness: "complete", inputIncludesCache, raw: {} } };
}
function measured() {
  const measurement = new ContextInputMeasurement();
  measurement.record(measurement.capture(request, configuration, [first]), complete(true));
  return measurement;
}

describe("context input measurement", () => {
  it.each([true, false])("uses the normalized total once when cache is included=%s", included => {
    const measurement = new ContextInputMeasurement();
    measurement.record(measurement.capture(request, configuration, [first]), complete(included));
    const next: StreamMessageParams = { ...request, messages: [first, { type: "assistant", content: "new" }] };
    expect(measurement.estimate(next, configuration, next.messages, messages => messages.length * 7)).toBe(107);
  });

  it("rejects mutated or replaced covered content even if its length remains equal", () => {
    const measurement = measured();
    const changed: Message[] = [{ type: "user", content: "changed" }];
    expect(measurement.estimate({ ...request, messages: changed }, configuration, changed, () => 7)).toBeUndefined();
  });

  it("matches original images as well as their request-only placeholders", () => {
    const measurement = new ContextInputMeasurement();
    const image: Message = { type: "user", content: [{ type: "image", source: { type: "file", mediaType: "image/png", path: "/one.png" } }] };
    const config = { ...configuration, supportsImageInput: false };
    measurement.record(measurement.capture(request, config, [image]), complete(true));
    const changed: Message = { type: "user", content: [{ type: "image", source: { type: "file", mediaType: "image/png", path: "/two.png" } }] };
    expect(measurement.estimate(request, config, [changed], () => 7)).toBeUndefined();
  });

  it("does not retain prompt or history strings in the captured boundary", () => {
    const snapshot = measured().capture(request, configuration, [first]);
    expect(JSON.stringify(snapshot)).not.toContain("covered");
    expect(JSON.stringify(snapshot)).not.toContain("rules");
  });

  it("discards the previous measurement when a later request has unknown usage", () => {
    const measurement = measured();
    measurement.record(measurement.capture(request, configuration, [first]), undefined);
    expect(measurement.estimate(request, configuration, [first], () => 7)).toBeUndefined();
  });

  it("does not carry measurements across a client replacement or an explicit reset", () => {
    const measurement = measured();
    expect(measurement.estimate(request, { ...configuration, client: { async *streamMessage() {} } }, [first], () => 7)).toBeUndefined();
    measurement.clear();
    expect(measurement.estimate(request, configuration, [first], () => 7)).toBeUndefined();
  });
});
