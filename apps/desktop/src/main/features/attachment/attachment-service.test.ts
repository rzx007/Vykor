import { rm } from "node:fs/promises"

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"

import type {
  AttachmentStorageGcResult,
  AttachmentStorageRepairResult,
  AttachmentStorageReport,
} from "@openharness/client"

import {
  cleanupTemporaryDirectories,
  consumeBytes,
  createService,
  loadPngFixture,
  pngBytes,
  readyAsset,
  temporaryFile,
  toArrayBuffer,
} from "./__test__/attachment-test-fixtures"

beforeAll(async () => {
  await loadPngFixture()
})

afterEach(async () => {
  await cleanupTemporaryDirectories()
})

describe("DesktopAttachmentService", () => {
  it("reads the daemon copy after the original source file has been deleted", async () => {
    const sourcePath = await temporaryFile("durable.png", pngBytes())
    let storedBytes = new Uint8Array(new ArrayBuffer(0))
    let storedAsset = readyAsset("asset-durable", "durable.png", 0, "image/png")
    const service = createService({
      uploadAttachment: async (input) => {
        storedBytes = await consumeBytes(input.body)
        storedAsset = readyAsset(
          "asset-durable",
          input.displayName,
          storedBytes.byteLength,
          "image/png"
        )
        return storedAsset
      },
      getAttachment: async () => storedAsset,
      downloadAttachment: async () => new Response(toArrayBuffer(storedBytes)),
    })
    const [candidate] = await service.stagePaths(17, [sourcePath])
    await service.startUpload(17, {
      draftId: candidate!.draftId,
      sourceToken: candidate!.sourceToken,
    })
    await service.whenIdle()
    await rm(sourcePath, { force: true })

    await expect(service.readPreview("asset-durable")).resolves.toEqual({
      bytes: toArrayBuffer(pngBytes()),
      mediaType: "image/png",
    })
  })

  it("treats attachment_in_use as an idempotent unreferenced cleanup result", async () => {
    const service = createService({
      deleteAttachment: async () => {
        throw { body: { error: { code: "attachment_in_use" } } }
      },
    })

    await expect(service.deleteUnreferenced("asset-used")).resolves.toEqual({
      deleted: false,
      inUse: true,
    })
  })

  it("delegates storage scan, repair, and gc to the remote client", async () => {
    const report: AttachmentStorageReport = {
      summary: {
        assets: { importing: 0, ready: 1, failed: 0, deleted: 0 },
        uniqueBlobs: 1,
        physicalBytes: 4,
        logicalBytes: 4,
        deduplicatedBytes: 0,
        activeLeases: 0,
        expiredLeases: 0,
        reclaimableBytes: 0,
      },
      issues: [],
    }
    const repaired: AttachmentStorageRepairResult = {
      expiredLeases: 0,
      deletedOrphanBlobs: 0,
      releasedBytes: 0,
    }
    const collected: AttachmentStorageGcResult = {
      scannedAssets: 0,
      expiredLeases: 0,
      deletedAssets: 0,
      deletedBlobs: 0,
      releasedBytes: 0,
      skipped: {
        notDeleted: 0,
        gracePeriod: 0,
        missingHash: 0,
        referenced: 0,
        activeLease: 0,
        sharedBlob: 0,
      },
      errors: [],
    }
    const scanStorage = vi.fn(async () => report)
    const repairStorage = vi.fn(async () => repaired)
    const gcStorage = vi.fn(async () => collected)
    const service = createService({ scanStorage, repairStorage, gcStorage })

    await expect(service.scanStorage()).resolves.toEqual(report)
    await expect(service.repairStorage()).resolves.toEqual(repaired)
    await expect(service.gcStorage()).resolves.toEqual(collected)
    expect(scanStorage).toHaveBeenCalledTimes(1)
    expect(repairStorage).toHaveBeenCalledTimes(1)
    expect(gcStorage).toHaveBeenCalledTimes(1)
  })
})
