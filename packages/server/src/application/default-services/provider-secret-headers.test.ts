import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CredentialStorage } from "@vykor/auth";
import type { Settings } from "@vykor/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultProviderService } from "./provider-service.js";
import { sanitizeSettings } from "./shared.js";

let root = "";
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "vykor-provider-headers-")); vi.stubEnv("VYKOR_CONFIG_DIR", root) });
afterEach(async () => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); await rm(root, { recursive: true, force: true }) });

describe("provider secret headers", () => {
  it("never returns values of headers explicitly declared secret even for inconsistent hand-edited configuration", () => {
    expect(JSON.stringify(sanitizeSettings({ model: "chat", apiFormat: "openai", maxTurns: 50, permission: { mode: "default" }, customProviders: [{ id: "gateway", displayName: "Gateway", baseUrl: "http://localhost/v1", apiFormat: "openai", models: [], headers: { "X-Token": "fixture-secret", "X-Session": "safe" }, secretHeaderNames: ["x-token"] }] }))).not.toContain("fixture-secret")
  })
  it("stores only names in settings, keeps values in host credentials, and preserves them during ordinary edits", async () => {
    const ref = { current: { model: "chat", apiFormat: "openai", maxTurns: 50, permission: { mode: "default" } } as Settings };
    const service = createDefaultProviderService(ref);
    const input = { id: "gateway", displayName: "Gateway", baseUrl: "http://localhost:8800/v1", apiFormat: "openai" as const, models: [{ id: "chat", displayName: "Chat" }], secretHeaders: { "X-Token": "fixture-secret" } };
    await service.create!(input);
    expect(ref.current.customProviders![0]).toMatchObject({ secretHeaderNames: ["X-Token"] });
    expect(await readFile(join(root, "settings.json"), "utf8")).not.toContain("fixture-secret");
    expect(await new CredentialStorage().loadCredential("gateway", "header:x-token")).toBe("fixture-secret");
    await service.update!("gateway", { ...input, secretHeaders: undefined, displayName: "Renamed" });
    expect(ref.current.customProviders![0].secretHeaderNames).toEqual(["X-Token"]);
    await service.update!("gateway", { ...input, secretHeaders: { "X-Token": null } });
    expect(ref.current.customProviders![0].secretHeaderNames).toBeUndefined();
    expect(await new CredentialStorage().loadCredential("gateway", "header:x-token")).toBeUndefined();
  });

  it("rejects CRLF in secret headers before changing settings or credentials", async () => {
    const ref = { current: { model: "chat", apiFormat: "openai", maxTurns: 50, permission: { mode: "default" } } as Settings };
    const service = createDefaultProviderService(ref);
    await expect(service.create!({ id: "gateway", displayName: "Gateway", baseUrl: "http://localhost:8800/v1", apiFormat: "openai", models: [{ id: "chat", displayName: "Chat" }], secretHeaders: { "X-Token": "a\r\nInjected: b" } })).rejects.toThrow("无效");
    expect(ref.current.customProviders).toBeUndefined();
    expect(await new CredentialStorage().loadCredential("gateway", "header:x-token")).toBeUndefined();
  });
});
