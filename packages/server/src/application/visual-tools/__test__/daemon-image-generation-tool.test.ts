import { afterEach, describe, expect, it, vi } from "vitest";

import { createDaemonImageGenerationTool } from "../daemon-image-generation-tool.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const settings = {
  model: "chat-model",
  apiFormat: "openai" as const,
  apiKey: "test-key",
  baseUrl: "https://images.example",
  maxTurns: 1,
  permission: { mode: "default" as const },
};

const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_BASE64 = Buffer.from(PNG_BYTES).toString("base64");

function attachmentHarness(options: { failAt?: number } = {}) {
  const imports: Array<{
    displayName: string;
    declaredMediaType?: string;
    bytes: Uint8Array;
  }> = [];
  const deleted: string[] = [];
  let attempts = 0;
  return {
    imports,
    deleted,
    service: {
      limits: { maxBytesPerFile: 1024 },
      async import(input: {
        displayName: string;
        declaredMediaType?: string;
        content: ReadableStream<Uint8Array>;
      }) {
        attempts += 1;
        if (attempts === options.failAt) throw new Error("attachment import failed");
        const bytes = new Uint8Array(await new Response(input.content).arrayBuffer());
        imports.push({
          displayName: input.displayName,
          ...(input.declaredMediaType
            ? { declaredMediaType: input.declaredMediaType }
            : {}),
          bytes,
        });
        return {
          id: `att-generated-${attempts}`,
          displayName: input.displayName,
          declaredMediaType: input.declaredMediaType,
          mediaType: input.declaredMediaType ?? "image/png",
          sizeBytes: bytes.byteLength,
          sha256: "a".repeat(64),
          status: "ready" as const,
          createdAt: 1,
          updatedAt: 1,
        };
      },
      delete(id: string) {
        deleted.push(id);
        return { id, status: "deleted" as const };
      },
    },
  };
}

function createTool() {
  return createDaemonImageGenerationTool({ attachments: attachmentHarness().service as any });
}

function captureFetch() {
  const requests: Array<{ url: string; body: Record<string, unknown>; authorization: string }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    requests.push({
      url: String(url),
      body: JSON.parse(String(init?.body)),
      authorization: String(init?.headers?.Authorization ?? init?.headers?.authorization ?? ""),
    });
    return new Response(JSON.stringify({ data: [] }));
  }));
  return requests;
}

describe("daemon ImageGeneration tool", () => {
  it("uses dedicated Agnes environment configuration instead of chat settings", async () => {
    vi.stubEnv("AGNES_API_KEY", "agnes-test-key");
    vi.stubEnv("AGNES_IMAGE_BASE_URL", "https://agnes-images.example");
    vi.stubEnv("AGNES_IMAGE_MODEL", "agnes-image-test-model");
    const requests = captureFetch();

    await createTool().execute(
      { prompt: "a quiet terminal" },
      { cwd: "C:/work", settings } as any,
    );

    expect(requests).toEqual([{
      url: "https://agnes-images.example/v1/images/generations",
      authorization: "Bearer agnes-test-key",
      body: {
        model: "agnes-image-test-model",
        prompt: "a quiet terminal",
        size: "1K",
        ratio: "1:1",
        return_base64: true,
      },
    }]);
  });

  it("does not duplicate /v1 when baseUrl already includes it", async () => {
    vi.stubEnv("AGNES_API_KEY", "agnes-test-key");
    vi.stubEnv("AGNES_IMAGE_BASE_URL", "https://api.agnes-ai.cn/v1");
    const requests = captureFetch();

    await createTool().execute(
      { prompt: "a quiet terminal", size: "2K", ratio: "16:9" },
      { cwd: "C:/work", settings } as any,
    );

    expect(requests[0]?.url).toBe("https://api.agnes-ai.cn/v1/images/generations");
    expect(requests[0]?.body).toMatchObject({ size: "2K", ratio: "16:9", return_base64: true });
    expect(requests[0]?.body).not.toHaveProperty("response_format");
    expect(requests[0]?.body).not.toHaveProperty("quality");
    expect(requests[0]?.body).not.toHaveProperty("n");
  });

  it("puts reference images and img2img output format under extra_body", async () => {
    vi.stubEnv("AGNES_API_KEY", "agnes-test-key");
    const requests = captureFetch();

    await createTool().execute(
      {
        prompt: "make it cyberpunk",
        images: ["https://example.com/input.png", "data:image/png;base64,abcd"],
      },
      { cwd: "C:/work", settings } as any,
    );

    expect(requests[0]?.body).toEqual({
      model: "agnes-image-2.5-flash",
      prompt: "make it cyberpunk",
      size: "1K",
      ratio: "1:1",
      extra_body: {
        image: ["https://example.com/input.png", "data:image/png;base64,abcd"],
        response_format: "b64_json",
      },
    });
    expect(requests[0]?.body).not.toHaveProperty("return_base64");
  });

  it("rejects a missing API key without calling the provider", async () => {
    vi.stubEnv("AGNES_API_KEY", "");
    const requests = captureFetch();

    const result = await createTool().execute(
      { prompt: "a quiet terminal" },
      { cwd: "C:/work", settings } as any,
    );

    expect(requests).toEqual([]);
    expect(result).toMatchObject({ isError: true, failureKind: "policy" });
  });

  it.each([401, 403])("identifies HTTP %s as rejected Agnes credentials", async (status) => {
    vi.stubEnv("AGNES_API_KEY", "agnes-test-key");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ error: { message: "credential rejected" } }),
      { status },
    )));

    const result = await createTool().execute(
      { prompt: "a quiet terminal" },
      { cwd: "C:/work", settings } as any,
    );

    expect(result).toMatchObject({ isError: true, failureKind: "provider" });
    expect(result.content[0]?.text).toContain(`credentials rejected (HTTP ${status})`);
  });

  it("reports rate limiting and the provider retry delay", async () => {
    vi.stubEnv("AGNES_API_KEY", "agnes-test-key");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ error: { message: "4K tier allows 1 request per minute" } }),
      { status: 429, headers: { "Retry-After": "60" } },
    )));

    const result = await createTool().execute(
      { prompt: "a quiet terminal", size: "4K" },
      { cwd: "C:/work", settings } as any,
    );

    expect(result).toMatchObject({ isError: true, failureKind: "provider" });
    expect(result.content[0]?.text).toContain("rate limited (HTTP 429)");
    expect(result.content[0]?.text).toContain("Retry after 60 seconds");
  });

  it("returns a redacted fetch failure instead of hiding its cause", async () => {
    vi.stubEnv("AGNES_API_KEY", "agnes-test-key");
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("TLS failure while using agnes-test-key");
    }));

    const result = await createTool().execute(
      { prompt: "a quiet terminal" },
      { cwd: "C:/work", settings } as any,
    );

    expect(result).toMatchObject({ isError: true, failureKind: "provider" });
    expect(result.content[0]?.text).toContain("Error: TLS failure while using [redacted]");
    expect(result.content[0]?.text).not.toContain("agnes-test-key");
  });

  it("imports base64 output as a durable attachment result", async () => {
    vi.stubEnv("AGNES_API_KEY", "agnes-test-key");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      data: [{ b64_json: PNG_BASE64, revised_prompt: "a revised prompt" }],
    }))));
    const attachments = attachmentHarness();

    const result = await createDaemonImageGenerationTool({
      attachments: attachments.service as any,
    }).execute(
      { prompt: "a quiet terminal" },
      { cwd: "C:/work", sessionId: "session-1", toolCallId: "call-1" } as any,
    );

    expect(attachments.imports).toEqual([{
      displayName: "generated-image-1.png",
      declaredMediaType: "image/png",
      bytes: PNG_BYTES,
    }]);
    expect(result.content[0]?.text).toContain("att-generated-1");
    expect(result.content[0]?.text).not.toMatch(/[A-Z]:[\\/]|\.vykor[\\/]images/i);
    expect(result.metadata).toEqual({
      generatedImages: [{
        assetId: "att-generated-1",
        displayName: "generated-image-1.png",
        mediaType: "image/png",
        sizeBytes: 8,
      }],
    });
  });

  it("downloads URL output through the safe image downloader before importing", async () => {
    vi.stubEnv("AGNES_API_KEY", "agnes-test-key");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      data: [{ url: "https://cdn.example/generated.webp" }],
    }))));
    const attachments = attachmentHarness();
    const downloads: string[] = [];

    const result = await createDaemonImageGenerationTool({
      attachments: attachments.service as any,
      downloadRemoteImage: async (url) => {
        downloads.push(url.href);
        return {
          displayName: "generated.webp",
          declaredMediaType: "image/webp",
          content: new ReadableStream({
            start(controller) {
              controller.enqueue(Uint8Array.from([
                0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
              ]));
              controller.close();
            },
          }),
        };
      },
    }).execute(
      { prompt: "a quiet terminal" },
      { cwd: "C:/work" } as any,
    );

    expect(downloads).toEqual(["https://cdn.example/generated.webp"]);
    expect(attachments.imports[0]).toMatchObject({
      displayName: "generated-image-1.webp",
      declaredMediaType: "image/webp",
    });
    expect(result.metadata).toMatchObject({
      generatedImages: [{ assetId: "att-generated-1", mediaType: "image/webp" }],
    });
  });

  it("soft-deletes assets imported before a later image fails", async () => {
    vi.stubEnv("AGNES_API_KEY", "agnes-test-key");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      data: [{ b64_json: PNG_BASE64 }, { b64_json: PNG_BASE64 }],
    }))));
    const attachments = attachmentHarness({ failAt: 2 });

    const result = await createDaemonImageGenerationTool({
      attachments: attachments.service as any,
    }).execute(
      { prompt: "a quiet terminal" },
      { cwd: "C:/work" } as any,
    );

    expect(result).toMatchObject({ isError: true, failureKind: "provider" });
    expect(attachments.deleted).toEqual(["att-generated-1"]);
  });
});
