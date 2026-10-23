import { describe, expect, it } from "vitest";
import { assertPromptMetadataAllowed, withoutHostPluginMetadata } from "../metadata.js";
import { DomainValidationError, parseSessionInputItems } from "../validation.js";
import { parseGoalActionInput } from "../../goals/validation.js";
import { readRuntimeMetadata, readSessionRuntimeRevision } from "../../sessions/runtime-config.js";

describe("product input invariants", () => {
  it("retains structured failures and input control-character boundaries", () => {
    expect(parseSessionInputItems([{ type: "text", text: "a\nb\tc" }])).toEqual([{ type: "text", text: "a\nb\tc" }]);
    expect(() => parseSessionInputItems([{ type: "text", text: "a\u0000" }])).toThrow(expect.objectContaining({ name: "DomainValidationError", field: "items" }));
    expect(() => parseSessionInputItems([{ type: "skill", name: "s", path: "/s", source: "other" }])).toThrow(expect.objectContaining({ field: "items[0].source" }));
  });

  it("keeps host metadata reserved across input and run namespaces", () => {
    expect(withoutHostPluginMetadata({ title: "user", pluginAppSource: { appId: "forged" } })).toEqual({ title: "user" });
    expect(() => assertPromptMetadataAllowed({ runMetadata: { pluginAppAction: {} } })).toThrow(expect.objectContaining({ field: "runMetadata.pluginAppAction" }));
  });

  it("requires the objective version for an answer and validates stored runtime data", () => {
    expect(() => parseGoalActionInput({ requestId: "r", expectedRevision: 0, action: "resume", questionId: "q" })).toThrow(expect.objectContaining({ field: "objectiveVersion" }));
    expect(() => readRuntimeMetadata({ runtime: { pluginAutoSelectionEnabled: "false" } })).toThrow(expect.objectContaining({ field: "metadata.runtime.pluginAutoSelectionEnabled" }));
    expect(() => readSessionRuntimeRevision({ runtimeRevision: -1 })).toThrow(DomainValidationError);
    expect(readSessionRuntimeRevision({})).toBe(0);
  });
});
