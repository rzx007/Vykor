import { expect, it, vi } from "vitest"
import { PluginIconLoader } from "./icon-loader"

it("deduplicates remote requests and returns image data without cookies", async () => {
  const fetchImage = vi.fn(
    async () => new Response("image", { headers: { "content-type": "image/png" } })
  )
  const loader = new PluginIconLoader(fetchImage)
  const input = { src: "https://example.test/icon.png" }
  expect(await Promise.all([loader.load(input), loader.load(input)])).toEqual([
    "data:image/png;base64,aW1hZ2U=",
    "data:image/png;base64,aW1hZ2U=",
  ])
  expect(fetchImage).toHaveBeenCalledOnce()
  expect(fetchImage).toHaveBeenCalledWith(
    input.src,
    expect.objectContaining({ credentials: "omit", signal: expect.any(AbortSignal) })
  )
})

it("uses a base64 image without making a network request", async () => {
  const fetchImage = vi.fn()
  const src = "data:image/png;base64,aW1hZ2U="
  expect(await new PluginIconLoader(fetchImage).load({ src })).toBe(src)
  expect(fetchImage).not.toHaveBeenCalled()
})

it.each(["file:///tmp/private.png", "javascript:alert(1)", "data:text/html;base64,aW1hZ2U="])(
  "rejects non-image input %s",
  async (src) => {
    const fetchImage = vi.fn()
    expect(await new PluginIconLoader(fetchImage).load({ src })).toBeNull()
    expect(fetchImage).not.toHaveBeenCalled()
  }
)

it.each([
  () => new Response("<html>error</html>", { headers: { "content-type": "text/html" } }),
  () => new Response("bad", { status: 404, headers: { "content-type": "image/png" } }),
  () => new Response(new Uint8Array(512 * 1024 + 1), { headers: { "content-type": "image/png" } }),
  () =>
    new Response("image", {
      headers: { "content-type": "image/png", "content-length": "1048576" },
    }),
])("falls back for wrong types, errors and oversized images", async (response) => {
  expect(
    await new PluginIconLoader(vi.fn(async () => response())).load({
      src: "https://example.test/icon.png",
    })
  ).toBeNull()
})

it("falls back for network failures", async () => {
  expect(
    await new PluginIconLoader(
      vi.fn(async () => {
        throw new Error("timeout")
      })
    ).load({ src: "https://example.test/icon.png" })
  ).toBeNull()
})
