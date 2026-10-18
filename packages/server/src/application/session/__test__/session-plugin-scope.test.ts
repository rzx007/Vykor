import { describe, expect, it, vi } from "vitest";
import type { SessionInputRecord, SessionRecord, SessionRunRecord } from "@vykor/protocol";
import { resolveRunPluginSelection } from "../session-plugin-selection.js";

const candidates = ["P", "Q"].map(pluginId => ({ pluginId, displayName: pluginId,
  description: pluginId, version: "1", behaviorDigest: `${pluginId}-digest` }));
const scope = { scopeVersion: 2, source: "auto", pluginIds: ["P", "Q"], candidates };

function resolve(options: { inputMetadata?: Record<string, unknown>; runMetadata?: Record<string, unknown>;
  sessionMetadata?: Record<string, unknown>; invalid?: string } = {}) {
  const selectPluginForRun = vi.fn(() => { throw new Error("selection model must not run"); });
  const validatePluginScope = vi.fn(async (selected: typeof candidates) => {
    if (selected.some(candidate => candidate.pluginId === options.invalid)) throw new Error("Plugin changed");
  });
  const result = resolveRunPluginSelection({
    session: { metadata: options.sessionMetadata ?? {} } as SessionRecord,
    run: { id: "run", metadata: options.runMetadata ?? {} } as SessionRunRecord,
    input: { id: "input", items: [], attachments: [], metadata: options.inputMetadata ?? { pluginScope: scope } } as unknown as SessionInputRecord,
    agent: { getPluginCandidates: () => candidates, validatePluginScope, selectPluginForRun } as never,
    signal: new AbortController().signal, traceId: "trace",
  });
  return { result, selectPluginForRun, validatePluginScope };
}

describe("host-owned plugin scope", () => {
  it("exposes all captured plugins without a selector model request", async () => {
    const f = resolve();
    await expect(f.result).resolves.toMatchObject({ status: "resolved", source: "auto", scopeVersion: 2,
      pluginId: null, pluginIds: ["P", "Q"], candidates });
    expect(f.selectPluginForRun).not.toHaveBeenCalled();
  });

  it("isolates a changed plugin before the first automatic execution", async () => {
    await expect(resolve({ invalid: "P" }).result).resolves.toMatchObject({ pluginIds: ["Q"], candidates: [candidates[1]] });
  });

  it("rejects a changed plugin in an already resolved scope", async () => {
    await expect(resolve({ invalid: "P", runMetadata: { pluginSelection: { ...scope,
      status: "resolved", pluginId: null, reason: "matched" } } }).result).rejects.toThrow("Plugin changed");
  });

  it("does not widen unresolved legacy automatic inputs", async () => {
    await expect(resolve({ inputMetadata: { pluginSelectionPolicy: "auto" } }).result).rejects.toThrow(/重新发送|resubmit/i);
  });

  it("validates a legacy resolved automatic singleton without selecting again", async () => {
    const f = resolve({ runMetadata: { pluginSelection: { status: "resolved", source: "auto", pluginId: "P",
      version: "1", behaviorDigest: "P-digest", reason: "matched" } } });
    await expect(f.result).resolves.toMatchObject({ pluginId: "P" });
    expect(f.validatePluginScope).toHaveBeenCalledWith([candidates[0]], expect.any(AbortSignal));
    expect(f.selectPluginForRun).not.toHaveBeenCalled();
  });

  it("retains a legacy resolved empty scope", async () => {
    await expect(resolve({ runMetadata: { pluginSelection: { status: "resolved", source: "auto",
      pluginId: null, reason: "no_match" } } }).result).resolves.toMatchObject({ pluginId: null });
  });

  it("keeps the captured automatic scope when the automatic preference later changes", async () => {
    await expect(resolve({ sessionMetadata: { runtime: { pluginAutoSelectionEnabled: false } } }).result)
      .resolves.toMatchObject({ source: "auto", pluginId: null, pluginIds: ["P", "Q"] });
  });

  it("fails a disabled recovered scope instead of replacing it with baseline", async () => {
    await expect(resolve({ sessionMetadata: { runtime: { pluginsEnabled: false } }, runMetadata: {
      pluginSelection: { ...scope, status: "resolved", pluginId: null, reason: "matched" },
    } }).result).rejects.toThrow(/disabled/i);
  });

  it.each([
    { ...scope, scopeVersion: 3 },
    { ...scope, source: "forged" },
    { ...scope, pluginIds: ["P"] },
    { ...scope, source: "explicit" },
  ])("rejects malformed recovered scope metadata %#", async saved => {
    await expect(resolve({ runMetadata: { pluginSelection: { ...saved,
      status: "resolved", pluginId: null, reason: "matched" } } }).result).rejects.toThrow(/scope|范围/i);
  });
});
