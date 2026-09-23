import { describe, expect, it, vi } from "vitest";

import { createBrowserTool, isBrowserPermissionApproved } from "../browser-tool.js";

describe("isBrowserPermissionApproved", () => {
  it("accepts a plain yes answer", () => {
    expect(isBrowserPermissionApproved("yes")).toBe(true);
  });

  it("accepts yes submitted through the AskUser answer card", () => {
    expect(
      isBrowserPermissionApproved(JSON.stringify({ selected: {}, custom: { 0: "yes" } })),
    ).toBe(true);
  });

  it("does not approve unrelated structured answers", () => {
    expect(
      isBrowserPermissionApproved(JSON.stringify({ selected: {}, custom: { 0: "no" } })),
    ).toBe(false);
  });

  it("uses the runtime permission callback instead of a text answer", async () => {
    const requestPermission = vi.fn(async () => ({ status: "approved" as const }));
    const tool = createBrowserTool({
      execute: async ({ approve }) => {
        expect(await approve("Allow localhost?")).toBe(true);
        return { url: "http://127.0.0.1:8000", title: "Test", pageText: "" };
      },
    }, async () => "unused.png");

    const result = await tool.execute({ action: "inspect" }, {
      cwd: ".",
      sessionId: "session-1",
      requestPermission,
    });

    expect(result.isError).toBeUndefined();
    expect(requestPermission).toHaveBeenCalledWith({
      toolName: "Browser",
      reason: "Allow localhost?",
      input: { action: "inspect" },
    });
  });
});
