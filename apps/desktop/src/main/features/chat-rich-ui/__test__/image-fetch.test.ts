import { EventEmitter } from "node:events"
import { Readable } from "node:stream"
import { beforeEach, expect, it, vi } from "vitest"
import { fetchRichImage } from "../image-fetch"

const mocks = vi.hoisted(() => ({
  lookup: vi.fn(),
  get: vi.fn(),
  getHttp: vi.fn(),
  resolveProxy: vi.fn(),
  request: vi.fn(),
}))
vi.mock("electron", () => ({
  session: { defaultSession: { resolveProxy: mocks.resolveProxy } },
  net: { request: mocks.request },
}))
vi.mock("node:dns/promises", () => ({ lookup: mocks.lookup }))
vi.mock("node:https", () => ({ get: mocks.get }))
vi.mock("node:http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:http")>()),
  get: mocks.getHttp,
}))

function response(statusCode: number, headers: Record<string, string>, body = "") {
  return Object.assign(Readable.from([Buffer.from(body)]), { statusCode, headers })
}

beforeEach(() => {
  mocks.lookup.mockReset()
  mocks.get.mockReset()
  mocks.getHttp.mockReset()
  mocks.resolveProxy.mockReset().mockResolvedValue("DIRECT")
  mocks.request.mockReset()
})

it("returns a raster data URL and pins the checked address", async () => {
  mocks.lookup.mockResolvedValue([{ address: "1.1.1.1", family: 4 }])
  mocks.get.mockImplementation((url, options, receive) => {
    const req = new EventEmitter()
    options.lookup(url.hostname, {}, (error, address, family) => {
      if (error) return req.emit("error", error)
      expect([address, family]).toEqual(["1.1.1.1", 4])
      receive(response(200, { "content-type": "image/png" }, "bytes"))
    })
    return req
  })
  await expect(fetchRichImage("https://example.test/image")).resolves.toBe(
    "data:image/png;base64,Ynl0ZXM="
  )
})

it("rejects local DNS results, including on redirects", async () => {
  mocks.lookup
    .mockResolvedValueOnce([{ address: "1.1.1.1", family: 4 }])
    .mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }])
  mocks.get.mockImplementation((url, options, receive) => {
    const req = new EventEmitter()
    options.lookup(url.hostname, {}, (error) => {
      if (error) return req.emit("error", error)
      receive(response(302, { location: "http://internal.example.test/image" }))
    })
    return req
  })
  mocks.getHttp.mockImplementation(mocks.get.getMockImplementation()!)
  await expect(fetchRichImage("https://example.test/image")).rejects.toThrow("公开网络")
  await expect(fetchRichImage("http://127.0.0.1/image")).rejects.toThrow("公开网络")
  expect(mocks.get).toHaveBeenCalledTimes(1)
  expect(mocks.getHttp).toHaveBeenCalledTimes(1)
})

it("uses HTTP for a public HTTP image", async () => {
  mocks.lookup.mockResolvedValue([{ address: "1.1.1.1", family: 4 }])
  mocks.getHttp.mockImplementation((url, options, receive) => {
    const req = new EventEmitter()
    options.lookup(url.hostname, {}, (error) => {
      if (error) return req.emit("error", error)
      receive(response(200, { "content-type": "image/png" }, "bytes"))
    })
    return req
  })
  await expect(fetchRichImage("http://example.test/image")).resolves.toBe(
    "data:image/png;base64,Ynl0ZXM="
  )
  expect(mocks.get).not.toHaveBeenCalled()
})

it("uses a configured proxy without following a redirect to a local address", async () => {
  mocks.resolveProxy.mockResolvedValue("PROXY 127.0.0.1:7890")
  const proxyRequest = Object.assign(new EventEmitter(), {
    setHeader: vi.fn(),
    end() {
      proxyRequest.emit("redirect", 302, "GET", "http://127.0.0.1/image")
    },
  })
  mocks.request.mockReturnValue(proxyRequest)
  await expect(fetchRichImage("http://images.example.test/image")).rejects.toThrow("公开网络")
  expect(mocks.request).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      url: "http://images.example.test/image",
      redirect: "manual",
      credentials: "omit",
    })
  )
  expect(mocks.lookup).not.toHaveBeenCalled()
})
