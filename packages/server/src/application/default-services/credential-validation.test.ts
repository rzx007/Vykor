import { afterEach, describe, expect, it, vi } from "vitest";
import { VYKOR_USER_AGENT } from "@vykor/api";

import { validateProviderCredential } from "./credential-validation.js";

describe("validateProviderCredential header templates", () => {
  it("checks the selected model against the real endpoint list", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: [{ id: "available-model" }] }), { status: 200 })))
    const input = { providerName: "gateway", providerDisplayName: "Gateway", backendType: "openai_compat" as const, apiKey: "fixture-key", baseUrl: "https://gateway.example/v1" }
    await expect(validateProviderCredential({ ...input, model: "missing-model" })).rejects.toThrow("模型不支持")
    await expect(validateProviderCredential({ ...input, model: "available-model" })).resolves.toBeUndefined()
  })

  it("does not echo a rejected upstream response containing credentials", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("your key fixture-secret was rejected", { status: 401 })))
    try { await validateProviderCredential({ providerName: "gateway", providerDisplayName: "Gateway", backendType: "openai_compat", apiKey: "fixture-secret", baseUrl: "https://gateway.example/v1" }) }
    catch (error) { expect(String(error)).toContain("密钥无效"); expect(String(error)).not.toContain("fixture-secret"); return }
    throw new Error("Expected authentication failure")
  })
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("expands header templates with the fixed validation context", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ data: [] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await validateProviderCredential({
      providerName: "gateway",
      providerDisplayName: "Gateway",
      backendType: "openai_compat",
      apiKey: "key",
      baseUrl: "https://gateway.example/v1",
      headers: {
        "User-Agent": "{{userAgent}}",
        "X-Session": "{{sessionId}}",
      },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://gateway.example/v1/models",
      expect.objectContaining({
        headers: expect.objectContaining({
          "User-Agent": VYKOR_USER_AGENT,
          "X-Session": "vykor-credential-validation",
        }),
      }),
    );
  });
});
