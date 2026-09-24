import type { ToolContext } from "@vykor/core";
import { MemoryManager } from "@vykor/memory";
import { describe, expect, it } from "vitest";

import { createRememberTool } from "./remember-tool.js";

const context: ToolContext = { cwd: process.cwd() };

function resultText(result: Awaited<ReturnType<NonNullable<ReturnType<typeof createRememberTool>["execute"]>>>): string {
  const first = result.content[0];
  return first?.type === "text" ? first.text : "";
}

describe("Remember tool", () => {
  it("routes user preferences without exposing their managed file path", async () => {
    const appended: string[] = [];
    const tool = createRememberTool({
      appendUserProfile: async (content) => {
        appended.push(content);
        return "C:/private/config/USER.md";
      },
      projectMemory: new MemoryManager(),
    });

    const result = await tool.execute(
      { scope: "user", content: "  Prefer concise Chinese replies.  " },
      context,
    );

    expect(result.isError).not.toBe(true);
    expect(result.metadata).toEqual({ scope: "user" });
    expect(appended).toEqual(["Prefer concise Chinese replies."]);
    expect(resultText(result)).not.toContain("USER.md");
    expect(resultText(result)).not.toContain("C:/private");
  });

  it("writes project knowledge through the current MemoryManager", async () => {
    const manager = new MemoryManager();
    const tool = createRememberTool({
      appendUserProfile: async () => "unused",
      projectMemory: manager,
    });

    const result = await tool.execute(
      { scope: "project", content: "  Build commands use pnpm.  " },
      context,
    );

    const entries = await manager.getAll();
    expect(result.isError).not.toBe(true);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.content).toBe("Build commands use pnpm.");
    expect(result.metadata).toEqual({ scope: "project", entryId: entries[0]?.id });
  });

  it("rejects invalid input and disabled project memory without writing", async () => {
    const appended: string[] = [];
    const tool = createRememberTool({
      appendUserProfile: async (content) => {
        appended.push(content);
        return "unused";
      },
    });

    const empty = await tool.execute({ scope: "user", content: "  " }, context);
    const unknown = await tool.execute({ scope: "machine", content: "fact" }, context);
    const disabled = await tool.execute({ scope: "project", content: "fact" }, context);

    expect(empty.isError).toBe(true);
    expect(unknown.isError).toBe(true);
    expect(disabled.isError).toBe(true);
    expect(resultText(disabled)).toContain("disabled");
    expect(appended).toEqual([]);
  });

  it("returns profile persistence failures as tool errors", async () => {
    const tool = createRememberTool({
      appendUserProfile: async () => {
        throw new Error("Blocked USER.md update: unsafe_instruction");
      },
      projectMemory: new MemoryManager(),
    });

    const result = await tool.execute({ scope: "user", content: "unsafe" }, context);

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("Blocked USER.md update");
  });
});
