import { describe, expect, it, vi } from "vitest"
import { MarketplaceService } from "./marketplace-service"
describe("marketplace confirmation", () => {
  it("requires explicit replacement confirmation and preserves source invalidation", async () => {
    const plugins = {
      marketplacePreview: vi
        .fn()
        .mockResolvedValue({
          candidateId: "bound",
          identity: { name: "demo" },
          requestedPermissions: ["network:manifest"],
          approvalRequired: false,
          replacementRequired: true,
        }),
      marketplaceCancel: vi.fn(),
      marketplaceInstall: vi
        .fn()
        .mockRejectedValue({
          body: { code: "marketplace_source_disabled", message: "来源已禁用" },
        }),
      marketplaceOperation: vi.fn(),
    }
    const service = new MarketplaceService(async () => ({ plugins }) as never)
    const sender = { id: 1, once: vi.fn(), isDestroyed: () => false } as never
    const preview = await service.preview(sender, {
      cwd: "/project",
      sourceId: "original",
      pluginId: "demo",
      version: "1.0.0",
    })
    expect(preview.approvalRequired).toBe(true)
    expect(plugins.marketplaceInstall).not.toHaveBeenCalled()
    const receipt = await service.confirm(sender, {
      cwd: "/project",
      selectionId: preview.selectionId,
    })
    expect(plugins.marketplaceInstall).toHaveBeenCalledWith(
      expect.objectContaining({
        candidateId: "bound",
        allowSourceChange: true,
        approvedPermissions: ["network:manifest"],
      }),
    )
    expect(receipt).toEqual(
      expect.objectContaining({
        status: "failed",
        code: "marketplace_source_disabled",
        message: "来源已禁用",
      }),
    )
    expect(plugins.marketplaceOperation).not.toHaveBeenCalled()
    await expect(
      service.confirm(sender, { cwd: "/project", selectionId: preview.selectionId }),
    ).rejects.toThrow()
  })
  it("does not regrant permissions on an approved same-source update", async () => {
    const plugins = {
      marketplacePreview: vi
        .fn()
        .mockResolvedValue({
          candidateId: "candidate",
          identity: { name: "demo" },
          requestedPermissions: ["network"],
          approvalRequired: false,
          replacementRequired: false,
        }),
      marketplaceCancel: vi.fn(),
      marketplaceInstall: vi
        .fn()
        .mockResolvedValue({ operationId: "op", status: "installed", message: "done" }),
    }
    const service = new MarketplaceService(async () => ({ plugins }) as never)
    await service.preview({ id: 1, once: vi.fn(), isDestroyed: () => false } as never, {
      cwd: "/project",
      sourceId: "s",
      pluginId: "demo",
      version: "1.0.0",
    })
    expect(plugins.marketplaceInstall).toHaveBeenCalledWith(
      expect.objectContaining({ approvedPermissions: [] }),
    )
    expect(plugins.marketplaceInstall.mock.calls[0][0]).not.toHaveProperty("allowSourceChange")
  })
  it("cleans candidates once on cancel or window destruction", async () => {
    let destroyed: (() => void) | undefined
    const plugins = {
      marketplacePreview: vi
        .fn()
        .mockResolvedValue({
          candidateId: "candidate",
          identity: { name: "demo" },
          requestedPermissions: [],
          approvalRequired: true,
          replacementRequired: false,
        }),
      marketplaceCancel: vi.fn(),
    }
    const service = new MarketplaceService(async () => ({ plugins }) as never)
    const sender = {
      id: 1,
      once: (_event: string, callback: () => void) => {
        destroyed = callback
      },
      isDestroyed: () => false,
    } as never
    const result = await service.preview(sender, {
      cwd: "/project",
      sourceId: "s",
      pluginId: "demo",
      version: "1.0.0",
    })
    await service.cancel(sender, { selectionId: result.selectionId })
    await service.cancel(sender, { selectionId: result.selectionId })
    destroyed!()
    expect(plugins.marketplaceCancel).toHaveBeenCalledTimes(1)
    await service.preview(sender, {
      cwd: "/project",
      sourceId: "s",
      pluginId: "demo",
      version: "1.0.0",
    })
    destroyed!()
    await Promise.resolve()
    expect(plugins.marketplaceCancel).toHaveBeenCalledTimes(2)
  })
  it("binds confirmation to window, project and expiry", async () => {
    let now = 0
    const plugins = {
      marketplacePreview: vi
        .fn()
        .mockResolvedValue({
          candidateId: "candidate",
          identity: { name: "demo" },
          requestedPermissions: ["network"],
          approvalRequired: true,
          replacementRequired: true,
        }),
      marketplaceCancel: vi.fn(),
      marketplaceInstall: vi.fn(),
    }
    const service = new MarketplaceService(
      async () => ({ plugins }) as never,
      () => now,
    )
    const sender = { id: 1, once: vi.fn(), isDestroyed: () => false } as never
    const result = await service.preview(sender, {
      cwd: "/project",
      sourceId: "source",
      pluginId: "demo",
      version: "1.0.0",
    })
    await expect(
      service.confirm({ id: 2 } as never, { cwd: "/project", selectionId: result.selectionId }),
    ).rejects.toThrow()
    await expect(
      service.confirm(sender, { cwd: "/other", selectionId: result.selectionId }),
    ).rejects.toThrow()
    now = 600_001
    await expect(
      service.confirm(sender, { cwd: "/project", selectionId: result.selectionId }),
    ).rejects.toThrow()
    expect(plugins.marketplaceInstall).not.toHaveBeenCalled()
  })
  it("queries the original operation after transport loss without replaying installation", async () => {
    const plugins = {
      marketplacePreview: vi
        .fn()
        .mockResolvedValue({
          candidateId: "c",
          identity: { name: "demo" },
          requestedPermissions: [],
          approvalRequired: false,
          replacementRequired: false,
        }),
      marketplaceCancel: vi.fn(),
      marketplaceInstall: vi.fn().mockRejectedValue(new Error("ECONNRESET")),
      marketplaceOperation: vi
        .fn()
        .mockImplementation(async (operationId) => ({
          operationId,
          status: "installed",
          message: "done",
        })),
    }
    const service = new MarketplaceService(async () => ({ plugins }) as never)
    const result = await service.preview(
      { id: 1, once: vi.fn(), isDestroyed: () => false } as never,
      { cwd: "/project", sourceId: "s", pluginId: "demo", version: "1.0.0" },
    )
    expect(result.operation?.status).toBe("installed")
    expect(plugins.marketplaceInstall).toHaveBeenCalledTimes(1)
    expect(plugins.marketplaceOperation).toHaveBeenCalledWith(
      plugins.marketplaceInstall.mock.calls[0][0].operationId,
    )
  })
})
