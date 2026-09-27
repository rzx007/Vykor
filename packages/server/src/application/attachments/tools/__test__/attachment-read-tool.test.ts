import { describe, expect, it, vi } from "vitest";

import { createAttachmentReadTool } from "../attachment-read-tool.js";

describe("attachment Read tool", () => {
  it("uses local OCR instead of returning an image to a non-visual model", async () => {
    const defaultExecute = vi.fn(async () => ({
      content: [{ type: "image" as const, source: { type: "file" as const, mediaType: "image/png", path: "C:/work/chart.png", sizeBytes: 4 } }],
    }));
    const recognizeImageBytes = vi.fn(async () => ({ status: "completed" as const, text: "Revenue: 42", lineCount: 1 }));
    const tool = createAttachmentReadTool({
      defaultTool: { name: "Read", description: "read", inputSchema: {}, execute: defaultExecute },
      authorizationSessions: { resolve: () => undefined },
      attachmentReader: { readText: vi.fn() },
      supportsImageInput: async () => false,
      localOcr: { recognizeImageBytes },
    });
    const context = {
      cwd: "C:/work",
      environment: {
        paths: { resolve: vi.fn(async () => ({ executionPath: "C:/work/chart.png" })) },
        files: { readBytes: vi.fn(async () => new Uint8Array([1, 2, 3])) },
      },
    };

    const result = await tool.execute({ file_path: "chart.png" }, context as never);

    expect(result.content).toEqual([{ type: "text", text: expect.stringContaining("Revenue: 42") }]);
    expect(recognizeImageBytes).toHaveBeenCalledWith(expect.objectContaining({ mediaType: "image/png" }));
  });

  it("returns a controlled error when OCR is unavailable for a non-visual model", async () => {
    const tool = createAttachmentReadTool({
      defaultTool: { name: "Read", description: "read", inputSchema: {}, execute: async () => ({
        content: [{ type: "image" as const, source: { type: "file" as const, mediaType: "image/png", path: "C:/work/chart.png", sizeBytes: 4 } }],
      }) },
      authorizationSessions: { resolve: () => undefined },
      attachmentReader: { readText: vi.fn() },
      supportsImageInput: async () => false,
    });

    const result = await tool.execute({ file_path: "chart.png" }, { cwd: "C:/work" } as never);

    expect(result).toMatchObject({ isError: true, content: [{ type: "text", text: expect.stringContaining("本地 OCR 不可用") }] });
  });

  it("keeps attachment URIs on the host control plane for WSL sessions", async () => {
    const defaultExecute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "local" }] }));
    const readText = vi.fn(async () => ({
      content: "two\nthree", startLine: 2, endLine: 3, hasMore: true,
      displayName: "notes.txt", mediaType: "text/plain", encoding: "utf-8" as const,
    }));
    const tool = createAttachmentReadTool({
      defaultTool: { name: "Read", description: "read", inputSchema: {}, execute: defaultExecute },
      authorizationSessions: { resolve: (id) => id === "child" ? "root" : undefined },
      attachmentReader: { readText },
    });
    expect(tool.execution).toEqual({
      domain: "environment",
      supportedEnvironments: ["local", "wsl"],
    });

    await expect(tool.execute({ file_path: "notes.txt" }, { cwd: "C:/work", sessionId: "child" }))
      .resolves.toMatchObject({ content: [{ text: "local" }] });
    const result = await tool.execute(
      { file_path: "attachment://att-1/notes.txt", offset: 2, limit: 2 },
      { cwd: "/mnt/c/work", sessionId: "child", environment: { info: { kind: "wsl" } } } as any,
    );
    expect((result.content[0] as { text: string }).text).toBe("2: two\n3: three\nhas_more: true");
    expect(result).toMatchObject({ executionState: "completed", compactSummary: expect.stringContaining("attachment://att-1/notes.txt") });
    expect(result.compactSummary).not.toContain("two");
    expect(readText).toHaveBeenCalledWith(expect.objectContaining({
      authorizationSessionId: "root", assetId: "att-1", offset: 2, limit: 2,
    }));
    const denied = await tool.execute({ file_path: "attachment://att-1/notes.txt" }, { cwd: "/work", sessionId: "other" });
    expect(denied).toMatchObject({ isError: true, failureKind: "policy", executionState: "not_started" });
  });
});
