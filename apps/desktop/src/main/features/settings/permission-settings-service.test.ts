import { describe, expect, it } from "vitest"
import type { VykorClient } from "@rzx/client"
import { DesktopPermissionSettingsService } from "./permission-settings-service"

function setup() {
  let settings: Record<string, unknown> = {
    permission: { mode: "ask", deniedTools: ["Write"] },
  }
  let writes = 0
  const client = {
    system: {
      getSettings: async () => structuredClone(settings),
      patchSettings: async (patch: Record<string, unknown>) => {
        const { expectedPermission: _permission, expectedSandbox: _sandbox, ...values } = patch
        settings = { ...settings, ...values }
        writes++
        return structuredClone(settings)
      },
    },
    permissions: {
      listApprovals: async () => [],
      revokeApproval: async () => {
        throw new Error("no approval")
      },
    },
  } as unknown as Pick<VykorClient, "system" | "permissions">
  return {
    service: new DesktopPermissionSettingsService({
      daemonClient: async () => client,
      browser: { listOriginApprovals: () => [], revokeOriginApproval: () => {} },
      getDeveloperMode: () => false,
    }),
    current: () => settings,
    writes: () => writes,
    change: (value: Record<string, unknown>) => {
      settings = value
    },
  }
}

describe("DesktopPermissionSettingsService", () => {
  it("saves the default mode and preserves the submitted restrictions", async () => {
    const ctx = setup()
    const previous = await ctx.service.snapshot()
    const result = await ctx.service.update({
      expectedPermission: previous.permission,
      permission: { ...previous.permission, mode: "ask" },
    })
    expect(result.permission).toEqual({ mode: "ask", deniedTools: ["Write"] })
    expect((await ctx.service.snapshot()).permission).toEqual(result.permission)
  })
  it("rejects stale edits without overwriting other settings", async () => {
    const ctx = setup()
    const previous = await ctx.service.snapshot()
    ctx.change({ permission: { mode: "ask", deniedTools: ["Shell"] } })
    await expect(
      ctx.service.update({
        expectedPermission: previous.permission,
        permission: { mode: "auto_review" },
      })
    ).rejects.toThrow("重新读取")
    expect(ctx.writes()).toBe(0)
    expect(ctx.current().permission).toEqual({ mode: "ask", deniedTools: ["Shell"] })
  })
  it("rejects invalid rules before any write", async () => {
    const ctx = setup()
    await expect(
      ctx.service.update({
        expectedPermission: { mode: "ask" },
        permission: { mode: "ask", deniedTools: [""] },
      })
    ).rejects.toThrow()
    expect(ctx.writes()).toBe(0)
  })
  it("checks drafts with the real checker without persisting or running commands", async () => {
    const ctx = setup()
    expect(
      await ctx.service.check({
        permission: { mode: "auto_review", deniedCommands: ["rm -rf*"] },
        toolName: "Shell",
        command: "rm -rf data",
        cwd: process.cwd(),
      })
    ).toMatchObject({ action: "deny" })
    expect(ctx.writes()).toBe(0)
  })
  it("refuses WSL isolation instead of saving an unenforced combination", async () => {
    const ctx = setup()
    ctx.change({ permission: { mode: "ask" }, agentEnvironment: { kind: "wsl" } })
    const previous = await ctx.service.snapshot()
    expect(previous.isolationAvailable).toBe(false)
    await expect(
      ctx.service.updateIsolation({
        expectedSandbox: previous.sandbox,
        sandbox: { ...previous.sandbox, enabled: true, failIfUnavailable: true },
      })
    ).rejects.toThrow("WSL")
    expect(ctx.writes()).toBe(0)
  })
  it("does not fabricate a usable default snapshot after a failed read", async () => {
    const service = new DesktopPermissionSettingsService({
      daemonClient: async () => {
        throw new Error("offline")
      },
      browser: { listOriginApprovals: () => [], revokeOriginApproval: () => {} },
      getDeveloperMode: () => false,
    })
    await expect(service.snapshot()).rejects.toThrow("offline")
  })
})
