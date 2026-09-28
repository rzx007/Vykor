import { describe, expect, it, vi } from "vitest";

import type { BrowserDeveloperExecuteInput, BrowserHost } from "../browser-host.js";
import { BROWSER_DEVELOPER_MAX_RESULT_BYTES, createBrowserDeveloperTool } from "../browser-developer-tool.js";

type Approval = { toolName: string; reason: string; input: Record<string, unknown> };

function context(overrides: Record<string, unknown> = {}) {
  return {
    cwd: "D:/workspace",
    sessionId: "session-1",
    requestPermission: vi.fn(async () => ({ status: "approved" as const })),
    ...overrides,
  };
}

describe("createBrowserDeveloperTool", () => {
  it("fails closed when no desktop browser host is connected", async () => {
    const tool = createBrowserDeveloperTool(undefined);
    const result = await tool.execute({ action: "inspect_dom" }, context());

    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining("unavailable") });
  });

  it("fails closed when the host cannot execute developer inspections", async () => {
    const host = { execute: vi.fn() } as unknown as BrowserHost;
    const tool = createBrowserDeveloperTool(host);
    const result = await tool.execute({ action: "inspect_dom" }, context());

    expect(result.isError).toBe(true);
  });

  it("rejects unknown actions and missing selectors before calling the host", async () => {
    const executeDeveloper = vi.fn();
    const tool = createBrowserDeveloperTool({ executeDeveloper } as unknown as BrowserHost);

    const unknown = await tool.execute({ action: "run_cdp" }, context());
    const missingSelector = await tool.execute({ action: "inspect_styles" }, context());

    expect(unknown.isError).toBe(true);
    expect(missingSelector.isError).toBe(true);
    expect(executeDeveloper).not.toHaveBeenCalled();
  });

  it("bridges the ordinary origin approval and the once-only developer approval", async () => {
    const approvals: Approval[] = [];
    const requestPermission = vi.fn(async (request: Approval) => {
      approvals.push(request);
      return { status: "approved" as const };
    });
    const executeDeveloper = vi.fn(async (input: BrowserDeveloperExecuteInput) => {
      expect(await input.approveOrigin("allow https://example.org")).toBe(true);
      expect(await input.approveDeveloper("inspect DOM on https://example.org")).toBe(true);
      return { action: input.action.action, url: "https://example.org", data: { nodes: 3 } };
    });

    const tool = createBrowserDeveloperTool({ executeDeveloper } as unknown as BrowserHost);
    const result = await tool.execute({ action: "inspect_dom" }, context({ requestPermission }));

    expect(result.isError).toBeUndefined();
    expect(approvals).toEqual([
      { toolName: "Browser", reason: "allow https://example.org", input: { action: "inspect_dom" } },
      {
        toolName: "BrowserDeveloper",
        reason: "inspect DOM on https://example.org",
        input: { action: "inspect_dom" },
      },
    ]);
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining('"nodes":3') });
  });

  it("stops when either approval is denied", async () => {
    const executeDeveloper = vi.fn(async (input: BrowserDeveloperExecuteInput) => {
      const origin = await input.approveOrigin("origin");
      if (!origin) throw new Error("origin denied");
      return { action: input.action.action, url: "https://example.org", data: {} };
    });
    const tool = createBrowserDeveloperTool({ executeDeveloper } as unknown as BrowserHost);

    const result = await tool.execute(
      { action: "inspect_dom" },
      context({ requestPermission: vi.fn(async () => ({ status: "denied" as const })) }),
    );

    expect(result.isError).toBe(true);
  });

  it("never asks for a new approval when reading or stopping diagnostics", async () => {
    const requestPermission = vi.fn(async () => ({ status: "approved" as const }));
    const executeDeveloper = vi.fn(
      async (input: BrowserDeveloperExecuteInput) => ({
        action: input.action.action,
        url: "https://example.org",
        data: { events: [] },
      }),
    );
    const tool = createBrowserDeveloperTool({ executeDeveloper } as unknown as BrowserHost);

    await tool.execute({ action: "read_diagnostics" }, context({ requestPermission }));
    await tool.execute({ action: "stop_diagnostics" }, context({ requestPermission }));

    expect(requestPermission).not.toHaveBeenCalled();
  });

  it("rejects a host result that exceeds the 48 KiB tool boundary", async () => {
    const huge = "x".repeat(BROWSER_DEVELOPER_MAX_RESULT_BYTES + 1);
    const executeDeveloper = vi.fn(async (input: BrowserDeveloperExecuteInput) => ({
      action: input.action.action,
      url: "https://example.org",
      data: { html: huge },
    }));
    const tool = createBrowserDeveloperTool({ executeDeveloper } as unknown as BrowserHost);

    const result = await tool.execute({ action: "inspect_dom" }, context());

    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining("limit") });
  });
});
