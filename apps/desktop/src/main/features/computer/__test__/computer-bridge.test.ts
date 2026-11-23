import { once } from "node:events"
import { createServer, type ServerResponse } from "node:http"
import { CURRENT_PROTOCOL_VERSION } from "@rzx/client"
import { afterEach, expect, it, vi } from "vitest"
import { DesktopComputerBridge } from "../computer-bridge"

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function daemon() {
  const streams: ServerResponse[] = []
  const posts: Array<{ path: string; body: unknown }> = []
  const approvalRequests: ServerResponse[] = []
  const rejectedInputs = new Set<string>()
  const server = createServer(async (request, response) => {
    if (request.url === "/capabilities") {
      response.end(JSON.stringify({
        serverVersion: "test", protocol: { version: CURRENT_PROTOCOL_VERSION }, features: {},
      }))
      return
    }
    if (request.url === "/debug/process") {
      if (request.headers.authorization !== "Bearer ordinary" ||
        request.headers["x-vykor-computer-token"] !== undefined) {
        response.writeHead(403).end()
        return
      }
      response.end(JSON.stringify({ pid: process.pid }))
      return
    }
    if (request.headers.authorization !== "Bearer ordinary" ||
      request.headers["x-vykor-computer-token"] !== "private" ||
      Object.keys(request.headers).some(header => header === "origin" || header.startsWith("sec-fetch-"))) {
      response.writeHead(401).end()
      return
    }
    if (request.url === "/computer-host/stream") {
      response.writeHead(200, { "content-type": "text/event-stream" })
      streams.push(response)
      send(response, { type: "connected", connectionId: `conn-${streams.length}` })
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    posts.push({ path: request.url!, body })
    if (request.url?.endsWith("/submit") && rejectedInputs.has(body.input?.id)) {
      response.writeHead(409).end(JSON.stringify({ error: "Not admitted" }))
      return
    }
    if (request.url?.endsWith("/approval")) {
      approvalRequests.push(response)
      return
    }
    response.end(JSON.stringify({ ok: true }))
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  cleanups.push(() => new Promise<void>((resolve) => {
    server.close(() => resolve())
    server.closeAllConnections()
  }))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("The fake daemon requires a port.")
  return { baseUrl: `http://127.0.0.1:${address.port}`, streams, posts, approvalRequests, rejectedInputs }
}

function send(response: ServerResponse, event: object) {
  response.write(`data: ${JSON.stringify(event)}\n\n`)
}

const command = (requestId: string) => ({
  type: "execute", requestId,
  run: { sessionId: "session", inputId: "input", runId: "run" },
  action: { type: "observe" }, deadlineAt: Date.now() + 10_000,
})

it("submits once on the authenticated native stream connection and returns the fake host result", async () => {
  const target = await daemon()
  const execute = vi.fn(async () => ({ text: "fake host" }))
  const bridge = new DesktopComputerBridge({
    ...target, daemonPid: process.pid, daemonToken: "ordinary", computerToken: "private", execute, authorizeDaemon: () => {},
  })
  cleanups.push(() => bridge.close())
  const authorize = vi.fn()
  const input = { id: "input", items: [] }
  await bridge.submit("session", input, authorize)
  expect(authorize).toHaveBeenCalledOnce()
  send(target.streams[0]!, command("request"))
  await vi.waitFor(() => expect(target.posts).toEqual([
    { path: "/computer-host/conn-1/submit", body: { sessionId: "session", input } },
    { path: "/computer-host/conn-1/request/result", body: { result: { text: "fake host" } } },
  ]))
  expect(execute).toHaveBeenCalledOnce()
})

it("retains a view revocation after returning to the original chat before its first tool", async () => {
  const target = await daemon()
  const execute = vi.fn(async () => ({ text: "fake host" }))
  const bridge = new DesktopComputerBridge({
    ...target, daemonPid: process.pid, daemonToken: "ordinary", computerToken: "private", execute, authorizeDaemon: () => {},
  })
  cleanups.push(() => bridge.close())
  await bridge.submit("session", { id: "input", items: [] }, () => {})
  bridge.invalidateView("other")
  bridge.invalidateView("session")
  send(target.streams[0]!, command("late"))
  await vi.waitFor(() => expect(target.posts).toContainEqual({
    path: "/computer-host/conn-1/late/result", body: expect.objectContaining({ executionState: "not_started" }),
  }))
  expect(execute).not.toHaveBeenCalled()
})

it("retains exact Stop while the submission has no run ID yet", async () => {
  const target = await daemon()
  const execute = vi.fn(async () => ({ text: "observed" }))
  const bridge = new DesktopComputerBridge({
    ...target, daemonPid: process.pid, daemonToken: "ordinary", computerToken: "private", execute, authorizeDaemon: () => {},
  })
  cleanups.push(() => bridge.close())
  await bridge.submit("session", { id: "input", items: [] }, () => {})
  bridge.revoke("session", "run")
  send(target.streams[0]!, command("late-stop"))
  await vi.waitFor(() => expect(target.posts).toContainEqual({
    path: "/computer-host/conn-1/late-stop/result", body: expect.objectContaining({ executionState: "not_started" }),
  }))
  expect(execute).not.toHaveBeenCalled()
})

it("discards a rejected submission and releases request deduplication when a run ends", async () => {
  const target = await daemon()
  const execute = vi.fn(async () => ({ text: "observed" }))
  const bridge = new DesktopComputerBridge({
    ...target, daemonPid: process.pid, daemonToken: "ordinary", computerToken: "private", execute, authorizeDaemon: () => {},
  })
  cleanups.push(() => bridge.close())
  target.rejectedInputs.add("input")
  await expect(bridge.submit("session", { id: "input", items: [] }, () => {})).rejects.toMatchObject({ status: 409 })
  send(target.streams[0]!, command("rejected"))
  await vi.waitFor(() => expect(target.posts).toContainEqual({
    path: "/computer-host/conn-1/rejected/result", body: expect.objectContaining({ executionState: "not_started" }),
  }))
  expect(execute).not.toHaveBeenCalled()

  target.rejectedInputs.clear()
  await bridge.submit("session", { id: "input", items: [] }, () => {})
  send(target.streams[0]!, command("request"))
  await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1))
  await vi.waitFor(() => expect(target.posts).toContainEqual({
    path: "/computer-host/conn-1/request/result", body: { result: { text: "observed" } },
  }))
  send(target.streams[0]!, { type: "ended", run: command("request").run })
  await bridge.submit("session", { id: "another", items: [] }, () => {})
  send(target.streams[0]!, { ...command("request"), run: { sessionId: "session", runId: "another-run", inputId: "another" } })
  await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2))
})

it("does not swap the host task while a different run is still authorized", async () => {
  const target = await daemon()
  const execute = vi.fn(async () => ({ text: "fake host" }))
  const bridge = new DesktopComputerBridge({
    ...target, daemonPid: process.pid, daemonToken: "ordinary", computerToken: "private", execute, authorizeDaemon: () => {},
  })
  cleanups.push(() => bridge.close())
  await bridge.submit("session", { id: "input", items: [] }, () => {})
  await bridge.submit("other", { id: "other-input", items: [] }, () => {})
  const other = (requestId: string) => ({ ...command(requestId), run: { sessionId: "other", inputId: "other-input", runId: "other-run" } })
  send(target.streams[0]!, command("first"))
  await vi.waitFor(() => expect(target.posts).toContainEqual({ path: "/computer-host/conn-1/first/result", body: { result: { text: "fake host" } } }))
  send(target.streams[0]!, other("interleaved"))
  await vi.waitFor(() => expect(target.posts).toContainEqual({
    path: "/computer-host/conn-1/interleaved/result", body: expect.objectContaining({ executionState: "not_started" }),
  }))
  expect(execute).toHaveBeenCalledOnce()
  send(target.streams[0]!, { type: "ended", run: command("first").run })
  send(target.streams[0]!, other("after-end"))
  await vi.waitFor(() => expect(target.posts).toContainEqual({ path: "/computer-host/conn-1/after-end/result", body: { result: { text: "fake host" } } }))
  expect(execute).toHaveBeenCalledTimes(2)
})

it("aborts fake host work on disconnect and sends no old result or repeated submit", async () => {
  const target = await daemon()
  let signal: AbortSignal | undefined
  let finish!: (result: { text: string }) => void
  const execute = vi.fn((_request, requestSignal: AbortSignal) => {
    signal = requestSignal
    return new Promise<{ text: string }>(resolve => { finish = resolve })
  })
  const bridge = new DesktopComputerBridge({
    ...target, daemonPid: process.pid, daemonToken: "ordinary", computerToken: "private", execute, authorizeDaemon: () => {},
  })
  cleanups.push(() => bridge.close())
  await bridge.submit("session", { id: "input", items: [] }, () => {})
  send(target.streams[0]!, command("old"))
  await vi.waitFor(() => expect(signal?.aborted).toBe(false))
  target.streams[0]!.destroy()
  await vi.waitFor(() => expect(signal?.aborted).toBe(true))
  finish({ text: "late result" })
  await vi.waitFor(() => expect(target.streams).toHaveLength(2), { timeout: 2_500 })
  expect(target.posts.map(post => post.path)).toEqual(["/computer-host/conn-1/submit"])
  await bridge.submit("session", { id: "new-input", items: [] }, () => {})
  expect(target.posts.map(post => post.path)).toEqual(["/computer-host/conn-1/submit", "/computer-host/conn-2/submit"])
  expect(execute).toHaveBeenCalledOnce()
})

it("rejects a different process behind the endpoint before sending the private credential", async () => {
  const target = await daemon()
  const mismatch = vi.fn()
  const bridge = new DesktopComputerBridge({
    ...target, daemonPid: process.pid + 1, daemonToken: "ordinary", computerToken: "private",
    authorizeDaemon: () => {}, onDaemonIdentityMismatch: mismatch,
  })
  cleanups.push(() => bridge.close())
  await expect(bridge.submit("session", { id: "input", items: [] }, () => {})).rejects.toThrow(/暂时无法连接/)
  expect(mismatch).toHaveBeenCalledOnce()
  expect(target.streams).toHaveLength(0)
  expect(target.posts).toHaveLength(0)
})

it("revokes the targeted run locally and rejects late events while allowing a new input", async () => {
  const target = await daemon()
  let signal: AbortSignal | undefined
  let finish!: () => void
  const execute = vi.fn(async (_request, requestSignal: AbortSignal) => {
    if (!signal) {
      signal = requestSignal
      await new Promise<void>(resolve => { finish = resolve })
    }
    return { text: "finished" }
  })
  const revoke = vi.fn()
  const bridge = new DesktopComputerBridge({
    ...target, daemonPid: process.pid, daemonToken: "ordinary", computerToken: "private",
    execute, revoke, authorizeDaemon: () => {},
  })
  cleanups.push(() => bridge.close())
  await bridge.submit("session", { id: "input", items: [] }, () => {})
  send(target.streams[0]!, command("active"))
  await vi.waitFor(() => expect(signal?.aborted).toBe(false))

  bridge.revoke("other-session", "run")
  bridge.revoke("session", "other-run")
  expect(signal?.aborted).toBe(false)
  bridge.revoke("session", "run")
  expect(signal?.aborted).toBe(true)
  expect(revoke).toHaveBeenCalledWith("session", "run")

  send(target.streams[0]!, command("stale"))
  finish()
  send(target.streams[0]!, command("active"))
  await vi.waitFor(() => expect(target.posts).toEqual(expect.arrayContaining([
    { path: "/computer-host/conn-1/active/result", body: expect.objectContaining({ executionState: "unknown" }) },
    { path: "/computer-host/conn-1/stale/result", body: expect.objectContaining({ executionState: "not_started" }) },
  ])))
  expect(execute).toHaveBeenCalledTimes(1)
  expect(target.posts.filter(post => /\/active\/result$/.test(post.path))).toEqual([
    { path: "/computer-host/conn-1/active/result", body: expect.objectContaining({ executionState: "unknown" }) },
  ])

  await bridge.submit("session", { id: "new-input", items: [] }, () => {})
  send(target.streams[0]!, { ...command("fresh"), run: { sessionId: "session", inputId: "new-input", runId: "new-run" } })
  await vi.waitFor(() => expect(target.posts).toContainEqual({
    path: "/computer-host/conn-1/fresh/result", body: { result: { text: "finished" } },
  }))
  expect(execute).toHaveBeenCalledTimes(2)
})

it("returns a trusted approval only for the current action and exact primary session", async () => {
  const target = await daemon()
  const proposal = { proposalId: "7100b740-d0bf-4e95-863f-2d8781451ff1", reason: "保存到现有文件" }
  const execute = vi.fn<NonNullable<ConstructorParameters<typeof DesktopComputerBridge>[0]["execute"]>>(
    async (_event, _signal, _connection, approve) => {
      const accepted = await approve(proposal)
      expect(await approve(proposal)).toBe(false)
      return { text: accepted ? "approved" : "not approved" }
    }
  )
  const bridge = new DesktopComputerBridge({
    ...target, daemonPid: process.pid, daemonToken: "ordinary", computerToken: "private", execute, authorizeDaemon: () => {},
  })
  cleanups.push(() => bridge.close())
  await bridge.submit("session", { id: "input", items: [] }, () => {})
  send(target.streams[0]!, command("request"))
  await vi.waitFor(() => expect(target.approvalRequests).toHaveLength(1))
  await expect(bridge.replyApproval("other-session", "permission", "approved")).rejects.toThrow(/失效/)
  await bridge.replyApproval("session", "permission", "approved")
  target.approvalRequests[0]!.end(JSON.stringify({ approved: true, proposalId: proposal.proposalId }))
  await vi.waitFor(() => expect(target.posts).toEqual([
    { path: "/computer-host/conn-1/submit", body: { sessionId: "session", input: { id: "input", items: [] } } },
    { path: "/computer-host/conn-1/request/approval", body: proposal },
    { path: "/computer-host/conn-1/approval-reply", body: { sessionId: "session", requestId: "permission", status: "approved" } },
    { path: "/computer-host/conn-1/request/result", body: { result: { text: "approved" } } },
  ]))
  await expect(bridge.replyApproval("session", "permission", "approved")).rejects.toThrow(/失效/)
})

it("closes a pending approval on Stop and never dispatches its late decision", async () => {
  const target = await daemon()
  const dispatch = vi.fn()
  const execute = vi.fn<NonNullable<ConstructorParameters<typeof DesktopComputerBridge>[0]["execute"]>>(
    async (_event, _signal, _connection, approve) => {
      if (await approve({ proposalId: "7100b740-d0bf-4e95-863f-2d8781451ff1", reason: "删除条目" })) dispatch()
      return { text: "finished" }
    }
  )
  const bridge = new DesktopComputerBridge({
    ...target, daemonPid: process.pid, daemonToken: "ordinary", computerToken: "private", execute, authorizeDaemon: () => {},
  })
  cleanups.push(() => bridge.close())
  await bridge.submit("session", { id: "input", items: [] }, () => {})
  send(target.streams[0]!, command("waiting"))
  await vi.waitFor(() => expect(target.approvalRequests).toHaveLength(1))
  const request = target.approvalRequests[0]!
  const disconnected = once(request, "close")
  bridge.revoke("session")
  await disconnected
  await expect(bridge.replyApproval("session", "permission", "approved")).rejects.toThrow(/失效/)
  send(target.streams[0]!, command("late"))
  await vi.waitFor(() => expect(target.posts).toEqual(expect.arrayContaining([
    { path: "/computer-host/conn-1/waiting/result", body: expect.objectContaining({ executionState: "not_started" }) },
    { path: "/computer-host/conn-1/late/result", body: expect.objectContaining({ executionState: "not_started" }) },
  ])))
  expect(dispatch).not.toHaveBeenCalled()
  expect(execute).toHaveBeenCalledTimes(1)
})
