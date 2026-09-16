import { afterEach, describe, expect, it, vi } from "vitest";
import { OPENHARNESS_USER_AGENT } from "@openharness/api";

import { validateProviderCredential } from "./credential-validation.js";

describe("validateProviderCredential header templates", () => {
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
          "User-Agent": OPENHARNESS_USER_AGENT,
          "X-Session": "openharness-credential-validation",
        }),
      }),
    );
  });
});
