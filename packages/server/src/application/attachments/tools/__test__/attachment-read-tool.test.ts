import { describe, expect, it, vi } from "vitest";

import { createAttachmentReadTool } from "../attachment-read-tool.js";

describe("attachment Read tool", () => {
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
    expect(readText).toHaveBeenCalledWith(expect.objectContaining({
      authorizationSessionId: "root", assetId: "att-1", offset: 2, limit: 2,
    }));
  });
});
