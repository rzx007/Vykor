import { describe, expect, it, vi } from "vitest";

import { lspTool } from "../lsp.js";

function context() {
  return {
    cwd: "/workspace",
    environment: {
      workspace: {
        kind: "wsl",
        hostRoot: "D:\\repo",
        executionRoot: "/workspace",
      },
      paths: {
        resolve: vi.fn(async (path: string) => ({
          executionPath: path.startsWith("/") ? path : `/workspace/${path}`,
          mountPurpose: "workspace",
          mountMode: "rw",
        })),
      },
      files: {
        readText: vi.fn(async () => "export function review() {}\nexport const value = 1;"),
        grep: vi.fn(async () => ({ matches: ["src/review.ts:1:export function review() {}"], truncated: false })),
      },
    },
  } as any;
}

describe("Lsp execution environment", () => {
  it("reads document symbols through environment files", async () => {
    const toolContext = context();
    const result = await lspTool.execute(
      { operation: "document_symbol", filePath: "src/review.ts" },
      toolContext,
    );

    expect(toolContext.environment.files.readText).toHaveBeenCalledWith("/workspace/src/review.ts");
    expect((result.content[0] as { text: string }).text).toContain("function review - /workspace/src/review.ts:1");
  });

  it("searches workspace symbols through environment grep", async () => {
    const toolContext = context();
    toolContext.abortSignal = new AbortController().signal;
    const result = await lspTool.execute(
      { operation: "workspace_symbol", query: "review" },
      toolContext,
    );

    expect(toolContext.environment.files.grep).toHaveBeenCalledWith(
      "/workspace",
      "review",
      expect.objectContaining({ limit: 20, signal: toolContext.abortSignal }),
    );
    expect((result.content[0] as { text: string }).text).toContain("src/review.ts:1");
  });
});
