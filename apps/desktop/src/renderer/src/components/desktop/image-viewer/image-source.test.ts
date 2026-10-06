import { expect, it } from "vitest"
import { imageSourceKey, readImageSource } from "./image-source"

it("keeps attachment, workspace and byte-only images distinct without treating their name as identity", () => {
  const bytes = new ArrayBuffer(1)
  expect(imageSourceKey({ kind: "attachment", assetId: "one", name: "image.png" })).not.toBe(
    imageSourceKey({ kind: "attachment", assetId: "two", name: "image.png" })
  )
  expect(
    imageSourceKey({
      kind: "file",
      path: "D:/a/image.png",
      name: "image.png",
      bytes,
      mediaType: "image/png",
    })
  ).not.toBe(
    imageSourceKey({
      kind: "file",
      path: "D:/b/image.png",
      name: "image.png",
      bytes,
      mediaType: "image/png",
    })
  )
  expect(
    imageSourceKey({ kind: "memory", id: "one", name: "image.png", bytes, mediaType: "image/png" })
  ).not.toBe(imageSourceKey({ kind: "attachment", assetId: "one", name: "image.png" }))
})

it("opens raw image bytes without requiring a project path or uploaded attachment", async () => {
  const bytes = new Uint8Array([1, 2, 3]).buffer
  const image = await readImageSource({
    kind: "memory",
    id: "capture-1",
    name: "页面截图.png",
    bytes,
    mediaType: "image/png",
  })
  expect(image).toEqual({ bytes, mediaType: "image/png" })
})
