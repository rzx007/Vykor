import { describe, expect, it } from "vitest";
import { ProtocolDataError, type SessionRecord } from "@vykor/protocol";
import { isWorkMode, normalizeApprovalMode, patchSessionRuntimeMetadata, readSessionRuntimeConfig } from "./runtime-configuration.js";

function session(runtime: Record<string, unknown>): SessionRecord {
  return { id: "session-1", cwd: "/repo", title: "Session", model: "display-only", status: "idle", metadata: { runtime }, createdAt: 1, updatedAt: 1 };
}

describe("client runtime configuration projection", () => {
  it.each([
    [{ permissionMode: "default" }, { approvalMode: "ask", workMode: "execute", permissionMode: "default" }],
    [{ permissionMode: "full_auto" }, { approvalMode: "auto_review", workMode: "execute", permissionMode: "default" }],
    [{ permissionMode: "plan" }, { approvalMode: "ask", workMode: "plan", permissionMode: "plan" }],
    [{ approvalMode: "full_access", workMode: "plan" }, { approvalMode: "full_access", workMode: "plan", permissionMode: "plan" }],
    [{ approvalMode: "full_access", workMode: "execute" }, { approvalMode: "full_access", workMode: "execute", permissionMode: "full_auto" }],
  ])("preserves the displayed mode projection for %j", (runtime, expected) => {
    expect(readSessionRuntimeConfig(session({ model: "m", ...runtime }))).toEqual({ model: "m", ...expected });
  });

  it("projects defaults and explicit false, zero and cleared effort exactly", () => {
    const runtime = { model: "m", maxTurns: 0, effort: "", pluginsEnabled: false, pluginAutoSelectionEnabled: false, allowedTools: [] };
    expect(readSessionRuntimeConfig(session(runtime), {
      provider: "openai", baseUrl: "https://api.example.test", apiFormat: "openai", approvalMode: "auto_review", workMode: "execute",
      maxTurns: 50, effort: "medium", sessionMode: "direct", systemPrompt: "default", allowedTools: ["Read"], disallowedTools: ["Write"], pluginsEnabled: true, pluginAutoSelectionEnabled: true,
    })).toEqual({ model: "m", approvalMode: "auto_review", workMode: "execute", permissionMode: "default", provider: "openai", baseUrl: "https://api.example.test", apiFormat: "openai", maxTurns: 0, sessionMode: "direct", systemPrompt: "default", allowedTools: ["Read"], disallowedTools: ["Write"], pluginsEnabled: false, pluginAutoSelectionEnabled: false });
    expect(readSessionRuntimeConfig(session({ model: "m", effort: "  xhigh  " }))).toEqual({ model: "m", effort: "xhigh" });
    expect(readSessionRuntimeConfig(session({ model: "m" }))).toEqual({ model: "m" });
  });

  it("requires the persisted runtime model and rejects malformed metadata before applying defaults", () => {
    expect(() => readSessionRuntimeConfig(session({}), { model: "default" })).toThrow("metadata.runtime.model: session-1");
    expect(() => readSessionRuntimeConfig(session({ model: "m", maxTurns: "10" }), { maxTurns: 50 })).toThrow(ProtocolDataError);
    expect(() => patchSessionRuntimeMetadata({}, { pluginAutoSelectionEnabled: 0 } as never)).toThrow(ProtocolDataError);
  });

  it("constructs partial requests without discarding metadata or replacing fields with undefined", () => {
    const original = { source: "desktop", runtime: { model: "old", provider: "openai", approvalMode: "auto_review", workMode: "execute" } };
    const planned = patchSessionRuntimeMetadata(original, { model: "new", provider: undefined, workMode: "plan" });
    expect(planned).toEqual({ source: "desktop", runtime: { model: "new", provider: "openai", approvalMode: "auto_review", workMode: "plan" } });
    expect(original.runtime.model).toBe("old");
    expect(readSessionRuntimeConfig({ ...session({}), metadata: patchSessionRuntimeMetadata(planned, { workMode: "execute" }) })).toMatchObject({ approvalMode: "auto_review", workMode: "execute" });
    expect(patchSessionRuntimeMetadata({}, { workMode: "plan" })).toEqual({ runtime: { workMode: "plan" } });
  });

  it("canonicalizes legacy requests while retaining their planning state", () => {
    expect(patchSessionRuntimeMetadata({ runtime: { model: "m", permissionMode: "plan" } }, { approvalMode: "full_access" }))
      .toEqual({ runtime: { model: "m", approvalMode: "full_access", workMode: "plan" } });
    expect(patchSessionRuntimeMetadata({ runtime: { model: "m", permissionMode: "full_auto" } }, { workMode: "plan" }))
      .toEqual({ runtime: { model: "m", approvalMode: "auto_review", workMode: "plan" } });
  });

  it("keeps the existing public mode helpers for client controls", () => {
    expect(normalizeApprovalMode("full_auto")).toBe("auto_review");
    expect(normalizeApprovalMode("plan")).toBe("ask");
    expect(normalizeApprovalMode("unknown")).toBeUndefined();
    expect(isWorkMode("plan")).toBe(true);
    expect(isWorkMode("execute")).toBe(true);
    expect(isWorkMode("full_auto")).toBe(false);
  });
});
