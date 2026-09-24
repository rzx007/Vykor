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
    }, async () => "unused.png", {});

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

describe("Browser screenshot capability", () => {
  it("does not capture or persist a screenshot when the request model is not visual", async () => {
    const execute = vi.fn(async ({ includeScreenshot }: { includeScreenshot: boolean }) => ({
      url: "http://127.0.0.1:8000",
      title: "Test",
      pageText: "Page text",
      ...(includeScreenshot ? { screenshotBytes: new Uint8Array([1, 2, 3]) } : {}),
    }));
    const storeScreenshot = vi.fn(async () => "screenshot.png");
    const tool = createBrowserTool({ execute }, storeScreenshot, {});

    const result = await tool.execute({ action: "inspect" }, {
      cwd: ".",
      sessionId: "session-1",
      settings: {
        provider: "custom-local",
        customProviders: [{
          id: "custom-local",
          displayName: "Local",
          baseUrl: "http://localhost",
          apiFormat: "openai",
          models: [{ id: "text-model", displayName: "Text", imageInputSupport: "unsupported" }],
        }],
      } as never,
      requestConfiguration: { model: "text-model", provider: "custom-local", apiFormat: "openai" },
      requestPermission: async () => ({ status: "approved" }),
    });

    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ includeScreenshot: false }));
    expect(storeScreenshot).not.toHaveBeenCalled();
    expect(result.content).toEqual([{ type: "text", text: expect.stringContaining("Page text") }]);
  });

  it("captures and returns a screenshot when the request model has native image input", async () => {
    const execute = vi.fn(async ({ includeScreenshot }: { includeScreenshot: boolean }) => ({
      url: "http://127.0.0.1:8000",
      title: "Test",
      pageText: "Page text",
      ...(includeScreenshot ? { screenshotBytes: new Uint8Array([1, 2, 3]) } : {}),
    }));
    const storeScreenshot = vi.fn(async () => "screenshot.png");
    const tool = createBrowserTool({ execute }, storeScreenshot, {});

    const result = await tool.execute({ action: "inspect" }, {
      cwd: ".",
      sessionId: "session-1",
      settings: {
        provider: "custom-local",
        customProviders: [{
          id: "custom-local",
          displayName: "Local",
          baseUrl: "http://localhost",
          apiFormat: "openai",
          models: [{ id: "vision-model", displayName: "Vision", imageInputSupport: "native" }],
        }],
      } as never,
      requestConfiguration: { model: "vision-model", provider: "custom-local", apiFormat: "openai" },
      requestPermission: async () => ({ status: "approved" }),
    });

    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ includeScreenshot: true }));
    expect(storeScreenshot).toHaveBeenCalledOnce();
    expect(result.content.map((block) => block.type)).toEqual(["text", "image"]);
  });
});
