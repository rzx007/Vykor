import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it, vi } from "vitest"
import { VykorClient } from "@rzx/client"
import { createDefaultNodeAgent } from "@vykor/agent-runtime"
import type { ContentBlock, StreamingMessageClient } from "@vykor/agent-contracts"
import { VykorHttpServer } from "@vykor/server"
import { DesktopComputerBridge } from "../../../apps/desktop/src/main/features/computer/computer-bridge"

it.each([
  { capture: false, revokeImage: false, switchChat: false },
  { capture: true, revokeImage: false, switchChat: false },
  { capture: true, revokeImage: true, switchChat: false },
  { capture: false, revokeImage: false, switchChat: true },
])("runs a trusted Computer prompt through HTTP (capture: $capture, revoked: $revokeImage, switched: $switchChat)", async ({ capture, revokeImage, switchChat }) => {
  const directory = mkdtempSync(join(tmpdir(), "vykor-desktop-computer-"))
  const daemonToken = "desktop-smoke-token"
  const computerToken = "f1".repeat(32)
  const observed = "Independent fake Desktop window"
  const image = { mediaType: "image/png" as const, width: 1, height: 1,
    data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aHuoAAAAASUVORK5CYII=" }
  const actions = capture ? ["observe", "observe", "capture", "observe"] : ["observe"]
  const automatic = !capture
  const captureStarted = Promise.withResolvers<void>()
  const finishCapture = Promise.withResolvers<void>()
  const firstModelTurn = Promise.withResolvers<void>()
  const continueModel = Promise.withResolvers<void>()
  let toolResult: unknown
  let modelCapture: ContentBlock[] | undefined
  const model: StreamingMessageClient = {
    async *streamMessage({ messages, tools }) {
      const results = messages.filter(message => message.type === "tool_result" && message.toolUseId.startsWith("probe"))
      toolResult = results.at(-1)
      const captured = results.at(-1)
      if (captured?.type === "tool_result" && captured.toolUseId === "probe-2") {
        modelCapture = captured.content
      }
      if (switchChat && !results.length) {
        firstModelTurn.resolve()
        await continueModel.promise
      }
      if (results.length < actions.length && tools?.some(tool => tool.name === "Computer")) {
        yield { type: "tool_use_start", toolUse: { type: "tool_use", id: `probe-${results.length}`, name: "Computer", input: { action: actions[results.length] } } }
        yield { type: "complete", stopReason: "tool_use" }
        return
      }
      yield { type: "text_delta", delta: "Finished." }
      yield { type: "complete", stopReason: "end_turn" }
    },
  }
  const server = new VykorHttpServer({
    token: daemonToken, desktopComputerToken: computerToken, storePath: join(directory, "sessions.db"),
    settings: {
      model: "test-model", apiFormat: "openai", maxTurns: 6, permission: { mode: capture ? "ask" : "full_access" },
      plugins: { enabled: false }, memory: { enabled: false }, sandbox: { enabled: false },
    },
    async createAgent({ options }) {
      const agent = await createDefaultNodeAgent({ ...options, client: model,
        ...(capture ? { resolveModelImageSupport: async () => true } : {}),
      })
      return { agent, host: agent.host }
    },
    logger: () => {},
  })
  let bridge: DesktopComputerBridge | undefined
  try {
    const baseUrl = (await server.listen()).url
    const ordinary = new VykorClient({ baseUrl, token: daemonToken })
    const session = await ordinary.sessions.create({ cwd: directory, model: "test-model" })
    const execute = vi.fn<NonNullable<ConstructorParameters<typeof DesktopComputerBridge>[0]["execute"]>>(async event => {
      if (event.action.type !== "capture") return { text: observed }
      captureStarted.resolve()
      if (revokeImage) await finishCapture.promise
      return { text: observed, image }
    })
    bridge = new DesktopComputerBridge({ baseUrl, daemonPid: process.pid, daemonToken, computerToken, execute, authorizeDaemon: () => {} })
    const admitted = await bridge.submit(session.id, {
      id: "desktop-computer-input", items: [{ type: "text", text: "Read the fake window." }],
    }, () => {}, undefined, automatic ? true : undefined)
    expect(admitted.run?.id).toBeTruthy()
    if (switchChat) {
      await firstModelTurn.promise
      const other = await ordinary.sessions.create({ cwd: directory, model: "test-model" })
      bridge.invalidateView(other.id)
      bridge.invalidateView(session.id)
      continueModel.resolve()
    }
    if (revokeImage) {
      await captureStarted.promise
      expect(await bridge.invalidateCapturedImage(session.id, admitted.run!.id)).toBe(true)
      finishCapture.resolve()
    }
    expect(await server.application.runControl.awaitRun(session.id, admitted.run!.id, { timeoutMs: 10_000 }))
      .toMatchObject({ status: "completed" })
    if (switchChat) {
      expect(execute).not.toHaveBeenCalled()
      expect(toolResult).toMatchObject({ isError: true })
      return
    }
    expect(execute).toHaveBeenCalledTimes(actions.length)
    expect(execute).toHaveBeenNthCalledWith(1, expect.objectContaining({
      action: { type: "observe" },
      run: { sessionId: session.id, runId: admitted.run!.id, inputId: "desktop-computer-input" },
    }), expect.any(AbortSignal), expect.any(AbortSignal), expect.any(Function), expect.any(Function),
    ...(automatic ? [true] : []))
    expect(toolResult).toMatchObject({ content: expect.arrayContaining([{ type: "text", text: observed }]) })
    if (revokeImage) {
      expect(modelCapture).toContainEqual({ type: "text", text: observed })
      expect(modelCapture?.some(block => block.type === "image")).toBe(false)
    }
    else if (capture) expect(modelCapture).toEqual(expect.arrayContaining([{ type: "image", source: { type: "memory", ...image } }]))
    else expect(modelCapture).toBeUndefined()
  } finally {
    finishCapture.resolve()
    continueModel.resolve()
    bridge?.close()
    await server.close()
    rmSync(directory, { recursive: true, force: true })
  }
}, 30_000)
