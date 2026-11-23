import type { ChildProcess } from "node:child_process"
import { EventEmitter } from "node:events"
import { resolve } from "node:path"
import { resolveUserDataPaths } from "@vykor/host-config/paths"
import { describe, expect, it, vi } from "vitest"
import { pairDesktopComputerDaemon } from "../computer-pairing"

const dataRoot = resolve("pairing-test-root")
const paths = resolveUserDataPaths(dataRoot)
const endpoint = {
  file: paths.daemonRegistryFilePath,
  storePath: paths.sessionsDatabasePath,
  pid: 100,
  startedAt: 1000,
  url: "http://127.0.0.1:10000",
  token: "ordinary",
  version: "test",
}
const token = "a".repeat(64)

function makeChild() {
  const transport = new EventEmitter()
  const send = vi.fn<(message: unknown) => boolean>(() => true)
  const child = Object.assign(transport, {
    connected: true,
    pid: endpoint.pid,
    send,
  }) as unknown as ChildProcess
  return { child, send, transport }
}

describe("Desktop private daemon pairing", () => {
  it.each([
    ["another pid", { ...endpoint, pid: 101 }],
    ["another store", { ...endpoint, storePath: resolve("different.db") }],
    ["another registry", { ...endpoint, file: resolve("different.json") }],
  ] as const)("does not send a challenge to %s", async (_description, wrongEndpoint) => {
    const { child, send } = makeChild()
    await expect(
      pairDesktopComputerDaemon(child, wrongEndpoint, dataRoot, new AbortController().signal)
    ).resolves.toBeUndefined()
    expect(send).not.toHaveBeenCalled()
  })

  it.each([
    ["a matched reply", {}, token],
    ["an old challenge", { nonce: "old" }, undefined],
    ["a different registration", { startedAt: 2000 }, undefined],
    ["a different root", { dataRoot: resolve("different") }, undefined],
    ["an ordinary credential", { token: "ordinary" }, undefined],
  ] as const)("accepts the credential only from %s", async (_description, change, expected) => {
    const { child, send, transport } = makeChild()
    const result = pairDesktopComputerDaemon(
      child,
      endpoint,
      dataRoot,
      new AbortController().signal
    )
    const request = send.mock.calls[0][0] as object
    expect(request).not.toHaveProperty("token")
    transport.emit("message", { ...request, type: "vykor-computer-paired", token, ...change })
    await expect(result).resolves.toBe(expected)
    expect(transport.listenerCount("message")).toBe(0)
    expect(transport.listenerCount("disconnect")).toBe(0)
  })

  it("drops a disconnected startup channel immediately", async () => {
    const { child, transport } = makeChild()
    const result = pairDesktopComputerDaemon(
      child,
      endpoint,
      dataRoot,
      new AbortController().signal
    )
    transport.emit("disconnect")
    await expect(result).resolves.toBeUndefined()
    expect(transport.listenerCount("message")).toBe(0)
  })
})
