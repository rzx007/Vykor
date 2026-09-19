import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import {
  patchSessionRuntimeMetadata,
  readRuntimeMetadata,
  readSessionRuntimeConfig,
  runtimeMetadataChanged,
  type SessionRecord,
} from "./index.js";

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
  const forbidden = JSON.parse(readFileSync(new URL("../../../scripts/forbidden-compatibility-surfaces.json", import.meta.url), "utf8"));
  it.each(forbidden.configFields as string[])("rejects the removed runtime field %s", (field) => {
    expect(() => readSessionRuntimeConfig(session({ runtime: { model: "m", [field]: "old" } })))
      .toThrow(expect.objectContaining({ name: "ProtocolDataError" }));
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
  ])("rejects invalid runtime structure before defaults can hide it: %j", (invalid) => {
    expect(() => readSessionRuntimeConfig(session({ runtime: { model: "m", ...invalid } }), { effort: "medium" }))
      .toThrow(expect.objectContaining({ name: "ProtocolDataError" }));
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
