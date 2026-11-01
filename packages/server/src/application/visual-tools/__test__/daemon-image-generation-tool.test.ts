import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AttachmentBlobStore, SessionStore } from "@vykor/services";

import { createDaemonImageGenerationTool } from "../daemon-image-generation-tool.js";
import { AttachmentService } from "../../attachments/attachment-service.js";
import { createAttachmentAuthorizationSessionResolver, createAttachmentImageReader } from "../../attachments/tools/attachment-access.js";
import { streamOf } from "../remote-image-source.js";

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

  it("resolves conversation attachment references to image bytes before sending them to the provider", async () => {
    vi.stubEnv("AGNES_API_KEY", "agnes-test-key");
    const requests = captureFetch();
    const tool = createDaemonImageGenerationTool({
      attachments: attachmentHarness().service as any,
      authorizationSessions: { resolve: (sessionId: string) => sessionId === "worker" ? "owner" : undefined },
      attachmentImages: {
        async readImage({ authorizationSessionId, assetId }: { authorizationSessionId: string; assetId: string }) {
          if (authorizationSessionId !== "owner" || assetId !== "att-original") throw new Error("attachment_resource_access_denied");
          return { assetId, displayName: "original.png", mediaType: "image/png", bytes: PNG_BYTES, path: "C:/private/blobs/original" };
        },
      },
    });

    await tool.execute({
      prompt: "crop the product screenshot",
      images: ["attachment://att-original/original.png", "https://example.com/style.png"],
    }, { cwd: "C:/work", sessionId: "worker" } as any);

    expect(requests[0]?.body).toMatchObject({
      extra_body: { image: [`data:image/png;base64,${PNG_BASE64}`, "https://example.com/style.png"] },
    });
    expect(JSON.stringify(requests)).not.toContain("attachment://");
    expect(JSON.stringify(requests)).not.toContain("C:/private");
  });

  it.each(["foreign", "missing", undefined])("rejects attachment references from %s sessions before calling the provider", async sessionId => {
    vi.stubEnv("AGNES_API_KEY", "agnes-test-key");
    const requests = captureFetch();
    const tool = createDaemonImageGenerationTool({
      attachments: attachmentHarness().service as any,
      authorizationSessions: { resolve: (id: string) => id === "foreign" ? "foreign" : undefined },
      attachmentImages: { readImage: async () => { throw new Error("Cannot open C:/private/blobs/original: attachment_resource_access_denied"); } },
    });

    const result = await tool.execute({ prompt: "crop", images: ["attachment://att-original/original.png"] }, { cwd: "C:/work", sessionId } as any);

    expect(requests).toEqual([]);
    expect(result).toMatchObject({ isError: true, failureKind: "policy", executionState: "not_started" });
    expect(JSON.stringify(result)).not.toContain("C:/private");
  });

  it.each([
    "attachment://att-original/..",
    "attachment://att-original/original.png?token=secret",
    "C:/private/blobs/original",
    "file:///C:/private/blobs/original",
  ])("rejects invalid or local reference image %s before calling the provider", async image => {
    vi.stubEnv("AGNES_API_KEY", "agnes-test-key");
    const requests = captureFetch();
    const result = await createTool().execute({ prompt: "crop", images: [image] }, { cwd: "C:/work", sessionId: "owner" } as any);

    expect(requests).toEqual([]);
    expect(result).toMatchObject({ isError: true, failureKind: "policy", executionState: "not_started" });
    expect(JSON.stringify(result)).not.toContain("C:/private");
  });

  it("does not send an authorized non-image attachment to the image provider", async () => {
    vi.stubEnv("AGNES_API_KEY", "agnes-test-key");
    const requests = captureFetch();
    const tool = createDaemonImageGenerationTool({
      attachments: attachmentHarness().service as any,
      authorizationSessions: { resolve: () => "owner" },
      attachmentImages: { readImage: async () => undefined },
    });
    const result = await tool.execute({ prompt: "crop", images: ["attachment://att-text/notes.txt"] }, { cwd: "C:/work", sessionId: "owner" } as any);

    expect(requests).toEqual([]);
    expect(result).toMatchObject({ isError: true, failureKind: "policy", executionState: "not_started" });
  });

  it("uses the original persisted bytes after reopening the conversation store and denies other conversations", async () => {
    vi.stubEnv("AGNES_API_KEY", "agnes-test-key");
    const requests = captureFetch();
    const directory = mkdtempSync(join(tmpdir(), "vykor-image-reference-"));
    const storePath = join(directory, "store.db");
    let store = new SessionStore({ path: storePath });
    const blobs = new AttachmentBlobStore({ root: join(directory, "attachments") });
    try {
      let attachments = new AttachmentService({ store: store.attachments, blobs });
      const asset = await attachments.import({
        displayName: "product.png",
        declaredMediaType: "image/png",
        content: streamOf(PNG_BYTES),
      });
      for (const id of ["owner", "other"]) store.sessions.create({ id, cwd: directory, model: "test" });
      store.conversationTransactions.admitPrompt({
        sessionId: "owner",
        content: "Use this product screenshot",
        attachments: [{ assetId: asset.id }],
      });
      store.close();
      store = new SessionStore({ path: storePath });
      attachments = new AttachmentService({ store: store.attachments, blobs });
      const tool = createDaemonImageGenerationTool({
        attachments,
        authorizationSessions: createAttachmentAuthorizationSessionResolver({
          store: { getSession: id => store.sessions.get(id) },
          liveChildren: { resolveRootSessionId: () => undefined },
        }),
        attachmentImages: createAttachmentImageReader({
          store: { listSessionInputAttachments: id => store.conversations.listSessionInputAttachments(id) },
          attachments,
        }),
      });
      const input = { prompt: "crop the uploaded screenshot", images: [`attachment://${asset.id}/product.png`] };

      await tool.execute(input, { cwd: directory, sessionId: "owner" });
      const denied = await tool.execute(input, { cwd: directory, sessionId: "other" });

      expect(requests).toHaveLength(1);
      expect(requests[0]?.body).toMatchObject({ extra_body: { image: [`data:image/png;base64,${PNG_BASE64}`] } });
      expect(denied).toMatchObject({ isError: true, failureKind: "policy", executionState: "not_started" });
      expect(JSON.stringify(denied)).not.toContain(directory);
    } finally {
      store.close();
      const withinTemp = relative(tmpdir(), directory);
      if (!withinTemp || withinTemp.startsWith("..") || isAbsolute(withinTemp)) throw new Error("Fixture escaped temporary directory");
      rmSync(directory, { recursive: true, force: true });
    }
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
    expect(result.content[0]?.text).toContain("attachment://att-generated-1/generated-image-1.png");
    expect(result.content[0]?.text).not.toMatch(/\b[A-Z]:[\\/]|\.vykor[\\/]images/i);
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
