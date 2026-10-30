import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "@vykor/services";

import {
  patchSessionRuntimeMetadata,
  readSessionRuntimeConfig,
  runtimeMetadataChanged,
  changedSessionRuntimeKeys,
} from "../runtime-configuration.js";
import type { SessionRecord } from "@vykor/domain-contracts/sessions";
import { readRuntimeMetadata, readSessionRuntimeRevision } from "@vykor/domain-contracts/sessions/runtime-config";

function session(metadata: Record<string, unknown>): SessionRecord {
  return {
    id: "session-1",
    cwd: "/repo",
    title: "Session",
    model: "display-only-model",
    status: "idle",
    metadata,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("session runtime metadata", () => {
  it("persists a reply style override and an explicit reset that resolves current defaults", () => {
    const original = { runtime: { model: "m" } };
    const override = patchSessionRuntimeMetadata(original, { replyStyle: "direct" });
    expect(readSessionRuntimeConfig(session(override), { replyStyle: "explanatory" }).replyStyle).toBe("direct");
    const reset = patchSessionRuntimeMetadata(override, { replyStyle: "inherit" });
    expect(reset).toMatchObject({ runtime: { replyStyle: "inherit" } });
    expect(readSessionRuntimeConfig(session(reset)).replyStyle).toBe("inherit");
    expect(readSessionRuntimeConfig(session(reset), { replyStyle: "explanatory" }).replyStyle).toBe("explanatory");
    expect(readSessionRuntimeConfig(session(reset), { replyStyle: "collaborative" }).replyStyle).toBe("collaborative");
    expect(changedSessionRuntimeKeys(readSessionRuntimeConfig(session(override)), readSessionRuntimeConfig(session(reset)))).toEqual(["replyStyle"]);
    for (const replyStyle of ["chatty", "", null, 1]) {
      expect(() => patchSessionRuntimeMetadata(original, { replyStyle } as never)).toThrow();
    }
  });
  it("keeps a reply style choice and reset when the durable session store reopens", () => {
    const directory = mkdtempSync(join(tmpdir(), "vykor-session-reply-style-"));
    const path = join(directory, "sessions.db");
    let store = new SessionStore({ path });
    try {
      store.sessions.create({ id: "style", cwd: directory, model: "m",
        metadata: patchSessionRuntimeMetadata({}, { model: "m", replyStyle: "direct" }) });
      store.close();
      store = new SessionStore({ path });
      expect(readSessionRuntimeConfig(store.sessions.get("style")!, { replyStyle: "explanatory" }).replyStyle).toBe("direct");
      store.sessions.update("style", { metadata: patchSessionRuntimeMetadata(store.sessions.get("style")!.metadata, { replyStyle: "inherit" }) });
      store.close();
      store = new SessionStore({ path });
      expect(store.sessions.get("style")!.metadata).toMatchObject({ runtime: { replyStyle: "inherit" } });
      expect(readSessionRuntimeConfig(store.sessions.get("style")!, { replyStyle: "explanatory" }).replyStyle).toBe("explanatory");
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("preserves explicit unlimited limits instead of dropping zero or inheriting a positive default", () => {
    expect(readSessionRuntimeConfig(session({ runtime: { model: "m", maxTurns: 0 } }), { maxTurns: 50 }).maxTurns).toBe(0);
    expect(readSessionRuntimeConfig(session({ runtime: { model: "m" } }), { maxTurns: 0 }).maxTurns).toBe(0);
  });
  const forbidden = JSON.parse(readFileSync(new URL("../../../../../../../scripts/forbidden-compatibility-surfaces.json", import.meta.url), "utf8"));
  it.each(forbidden.configFields as string[])("rejects the removed runtime field %s", (field) => {
    expect(() => readSessionRuntimeConfig(session({ runtime: { model: "m", [field]: "old" } })))
      .toThrow(expect.objectContaining({ name: "DomainValidationError" }));
  });

  it.each([
    { permission: { mode: "default" } },
    { apiFormat: "old-format" },
    { permissionMode: "old-mode" },
    { effort: 123 },
    { sessionMode: "old-mode" },
    { maxTurns: "10" },
    { allowedTools: ["read", 42] },
    { pluginsEnabled: "false" },
    { pluginAutoSelectionEnabled: "false" },
    { pluginAutoSelectionEnabled: null },
  ])("rejects invalid runtime structure before defaults can hide it: %j", (invalid) => {
    expect(() => readSessionRuntimeConfig(session({ runtime: { model: "m", ...invalid } }), { effort: "medium" }))
      .toThrow(expect.objectContaining({ name: "DomainValidationError" }));
  });

  it("accepts any non-empty effort string and trims it", () => {
    expect(
      readSessionRuntimeConfig(session({ runtime: { model: "m", effort: "  xhigh  " } })),
    ).toEqual({ model: "m", effort: "xhigh" });
  });

  it("treats an empty effort as a cleared sentinel without falling back", () => {
    expect(
      readSessionRuntimeConfig(session({ runtime: { model: "m", effort: "" } }), { effort: "medium" }),
    ).toEqual({ model: "m" });
  });

  it("accepts a cleared effort through the metadata validator", () => {
    expect(() => readRuntimeMetadata({ runtime: { effort: "" } })).not.toThrow();
  });

  it("defaults a missing runtime revision to zero and validates stored revisions", () => {
    expect(readSessionRuntimeRevision({ runtime: { model: "m" } })).toBe(0);
    expect(readSessionRuntimeRevision({ runtimeRevision: 3 })).toBe(3);
    expect(() => readSessionRuntimeRevision({ runtimeRevision: -1 })).toThrow(
      /runtimeRevision/,
    );
    expect(() => readSessionRuntimeRevision({ runtimeRevision: 1.5 })).toThrow(
      /runtimeRevision/,
    );
  });

  it("reports only effective request configuration changes", () => {
    const before = readSessionRuntimeConfig(session({
      runtime: { model: "m", provider: "openai", effort: "low" },
    }));
    const unchanged = readSessionRuntimeConfig(session({
      runtime: { model: "m", provider: "openai", effort: "low" },
    }));
    const changed = readSessionRuntimeConfig(session({
      runtime: { model: "m", provider: "openai", effort: "" },
    }));

    expect(changedSessionRuntimeKeys(before, unchanged)).toEqual([]);
    expect(changedSessionRuntimeKeys(before, changed)).toEqual(["effort"]);
  });

  it("rejects a non-object runtime and invalid patches", () => {
    expect(() => readRuntimeMetadata({ runtime: "old" })).toThrow();
    expect(() => patchSessionRuntimeMetadata({}, { maxTurns: "10" } as never)).toThrow();
  });
  it("reads the model only from metadata.runtime", () => {
    expect(() => readSessionRuntimeConfig(session({}))).toThrow(
      /metadata\.runtime\.model/,
    );
    expect(
      readSessionRuntimeConfig(
        session({ runtime: { model: "runtime-model", apiFormat: "openai" } }),
      ),
    ).toEqual({ model: "runtime-model", apiFormat: "openai" });
  });

  it("preserves an explicit false plugin runtime override", () => {
    expect(readSessionRuntimeConfig(
      session({ runtime: { model: "runtime-model", pluginsEnabled: false } }),
      { pluginsEnabled: true },
    )).toMatchObject({ model: "runtime-model", pluginsEnabled: false });
  });

  it("reads and patches the automatic plugin selection flag without losing false", () => {
    const metadata = patchSessionRuntimeMetadata(
      { activePluginId: "dev.quality", runtime: { model: "m", effort: "high" } },
      { pluginAutoSelectionEnabled: false },
    );
    expect(metadata).toEqual({
      activePluginId: "dev.quality",
      runtime: { model: "m", effort: "high", pluginAutoSelectionEnabled: false },
    });
    const disabled = readSessionRuntimeConfig(session(metadata), { pluginAutoSelectionEnabled: true });
    expect(disabled.pluginAutoSelectionEnabled).toBe(false);
    const enabled = readSessionRuntimeConfig(session({ runtime: { model: "m", pluginAutoSelectionEnabled: true } }));
    expect(enabled.pluginAutoSelectionEnabled).toBe(true);
    expect(changedSessionRuntimeKeys(disabled, enabled)).toEqual(["effort", "pluginAutoSelectionEnabled"]);
    expect(() => patchSessionRuntimeMetadata(metadata, { pluginAutoSelectionEnabled: 0 } as never)).toThrow();
  });

  it("patches runtime fields without discarding unrelated metadata", () => {
    expect(
      patchSessionRuntimeMetadata(
        { source: "desktop", runtime: { model: "old", provider: "openai" } },
        { model: "new", provider: undefined },
      ),
    ).toEqual({
      source: "desktop",
      runtime: { model: "new", provider: "openai" },
    });
  });

  it("compares runtime metadata without treating other metadata as a restart", () => {
    expect(
      runtimeMetadataChanged(
        { runtime: { model: "m" }, titleSource: "a" },
        { runtime: { model: "m" }, titleSource: "b" },
      ),
    ).toBe(false);
    expect(
      runtimeMetadataChanged(
        { runtime: { model: "m" } },
        { runtime: { model: "next" } },
      ),
    ).toBe(true);
    expect(readRuntimeMetadata(undefined)).toEqual({});
  });
});
