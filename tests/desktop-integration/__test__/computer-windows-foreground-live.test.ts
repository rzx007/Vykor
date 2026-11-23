import { randomBytes } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { StreamMessageParams, StreamingMessageClient, ToolResultMessage } from "@vykor/agent-contracts"
import { createDefaultNodeAgent } from "@vykor/agent-runtime"
import { VykorClient } from "@rzx/client"
import { VykorHttpServer } from "@vykor/server"
import { expect, it, vi } from "vitest"
import { DesktopComputerBridge } from "../../../apps/desktop/src/main/features/computer/computer-bridge"
import { ComputerHost } from "../../../apps/desktop/src/main/features/computer/computer-host"
import { createWindowsApps } from "../../../apps/desktop/src/main/features/computer/windows-apps"
import { createWindowsForeground, type WindowsForegroundFrame } from "../../../apps/desktop/src/main/features/computer/windows-foreground"
import { createWindowsDriver } from "../../../apps/desktop/src/main/features/computer/windows-driver"
import type { DesktopComputerActivity } from "../../../apps/desktop/src/shared/computer-types"
import { closeNewWindow } from "./windows-live-cleanup"
import { registerFixture } from "./windows-live-fixture"

const realWindows = process.platform === "win32" && process.arch === "x64"
  && process.env.VYKOR_COMPUTER_WINDOWS_FOREGROUND_LIVE === "1"

it.runIf(realWindows)("observes and safely drives a real Calculator through the private chat bridge", async () => {
  const apps = createWindowsApps()
  const windows = () => AbortSignal.timeout(8_000)
  const [calculator] = await apps.discover("Calculator", windows())
  expect(calculator).toBeDefined()
  // This test must be the owner of every window it reads or changes.
  expect(await apps.windows(calculator!, windows())).toEqual([])
  const started = Date.now()
  const directory = mkdtempSync(join(tmpdir(), "vykor-stage5-live-"))
  const daemonToken = randomBytes(24).toString("hex")
  const computerToken = randomBytes(32).toString("hex")
  const resourcesPath = process.env.VYKOR_COMPUTER_TEST_RESOURCES
  const actions = [
    { action: "open_app", app: "Calculator" }, ...(resourcesPath ? [{ action: "observe" }] : []),
    { action: "foreground" }, { action: "capture" },
    { action: "key", key: "Tab" }, { action: "capture" },
  ]
  let results: ToolResultMessage[] = []
  let sawModelImage = false
  const modelBlocks: string[] = []
  const desktopOutcomes: string[] = []
  let activity: Omit<DesktopComputerActivity, "sessionId"> | null = null
  const model: StreamingMessageClient = {
    async *streamMessage({ messages, tools }: StreamMessageParams) {
      results = messages.filter((message): message is ToolResultMessage =>
        message.type === "tool_result" && message.toolUseId.startsWith("calculator-"))
      const latest = results.at(-1)
      if (latest?.content.some(content => content.type === "image" && content.source.type === "memory")) sawModelImage = true
      if (latest) modelBlocks.push(`${latest.toolUseId}:${latest.content.map(content => content.type).join(",")}`)
      const action = actions[results.length]
      if (action && !latest?.isError && tools?.some(tool => tool.name === "Computer")) {
        yield { type: "tool_use_start", toolUse: { type: "tool_use", id: `calculator-${results.length}`, name: "Computer", input: action } }
        yield { type: "complete", stopReason: "tool_use" }
        return
      }
      yield { type: "text_delta", delta: "已结束计算器验证。" }
      yield { type: "complete", stopReason: "end_turn" }
    },
  }
  vi.stubEnv("VYKOR_CONFIG_DIR", join(directory, "config"))
  vi.stubEnv("VYKOR_DATA_DIR", join(directory, "data"))
  vi.stubEnv("VYKOR_DISABLE_MODELS_FETCH", "1")
  const server = new VykorHttpServer({
    token: daemonToken, desktopComputerToken: computerToken, storePath: join(directory, "sessions.db"),
    settings: { model: "test-model", apiFormat: "openai", maxTurns: 7, permission: { mode: "ask" },
      plugins: { enabled: false }, memory: { enabled: false }, sandbox: { enabled: false } },
    async createAgent({ options }) {
      const agent = await createDefaultNodeAgent({ ...options, client: model, resolveModelImageSupport: async () => true })
      return { agent, host: agent.host }
    },
    logger: () => {},
  })
  let bridge: DesktopComputerBridge | undefined
  try {
    const baseUrl = (await server.listen()).url
    const client = new VykorClient({ baseUrl, token: daemonToken })
    const host = new ComputerHost(apps, {
      authorizeApp: async () => true,
      chooseTarget: async () => { throw new Error("Expected one test-owned Calculator window") },
      armEmergencyStop: () => true,
      publishActivity: (_session, state) => { activity = state },
    }, resourcesPath ? (target, signal) => createWindowsDriver(target, signal, join(resourcesPath, "computer-windows", "cua-driver.exe")) : undefined,
    createWindowsForeground())
    const desktop = new DesktopComputerBridge({ baseUrl, daemonPid: process.pid, daemonToken, computerToken, authorizeDaemon: () => {},
      async execute(...args) {
        const result = await host.execute(...args)
        desktopOutcomes.push(`${args[0].action.type}: ${"error" in result ? result.error : "ok"}`)
        return result
      },
      revoke: (session, run) => host.revoke(session, run),
      cancel: (session, run) => { host.pause(session, run) },
    })
    bridge = desktop
    const session = await client.sessions.create({ cwd: directory, model: "test-model" })
    const admitted = await desktop.submit(session.id, { id: "calculator", items: [{ type: "text", text: "打开计算器，观察窗口并按 Tab。" }] }, () => {})
    expect(admitted.run?.id).toBeTruthy()
    const pending = () => server.application.permissions.listRequests({ sessionId: session.id, toolName: "Computer", status: "pending" })
    await expect.poll(() => pending().length, { timeout: 24_000 }).toBe(1)
    await desktop.replyApproval(session.id, pending()[0]!.id, "approved")
    expect(await server.application.runControl.awaitRun(session.id, admitted.run!.id, { timeoutMs: 45_000 })).toMatchObject({ status: "completed" })
    const values = results.map(result => {
      const body = result.content.find(item => item.type === "text")
      if (body?.type !== "text" || result.isError) throw new Error(`Calculator step failed: ${desktopOutcomes.join(" | ")}`)
      return JSON.parse(body.text)
    })
    expect(values).toMatchObject([
      { status: "ready", source: "launched" }, ...(resourcesPath ? [{ status: "observed" }] : []),
      { status: "foreground" }, { status: "captured" },
      { status: "sent", inputReleased: true }, { status: "captured" },
    ])
    expect(sawModelImage, modelBlocks.join(" ")).toBe(true)
    await expect.poll(() => activity, { timeout: 8_000 }).toMatchObject({ phase: "stopped", evidence: "输入已释放，前台控制已退出。" })
    expect(await host.waitForInputRelease()).toBe(true)
  } finally {
    bridge?.close()
    await server.close()
    const targets = await apps.windows(calculator!, windows())
    for (const target of targets) {
      if (!target.applicationStartKey || target.ownerWindowId !== undefined) continue
      const appStartedAt = Number((BigInt(target.applicationStartKey) - 116_444_736_000_000_000n) / 10_000n)
      if (appStartedAt >= started) closeNewWindow(target, started)
    }
    vi.unstubAllEnvs()
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}, 95_000)

it.skipIf(!realWindows).each(["key", "click"] as const)("releases a held %s through actual chat Stop before an up is queued", async kind => {
  const directory = mkdtempSync(join(tmpdir(), "vykor-chat-stop-live-"))
  const appName = `Vykor Stop ${randomBytes(4).toString("hex")}`
  const tracePath = join(directory, "fixture.jsonl")
  const daemonToken = randomBytes(24).toString("hex")
  const computerToken = randomBytes(32).toString("hex")
  const apps = createWindowsApps()
  const down = kind === "key" ? "key-down-F7" : "mouse-down-Left"
  const up = kind === "key" ? "key-up-F7" : "mouse-up-Left"
  const held = Promise.withResolvers<boolean>()
  type Event = { kind: string; target?: number; hwnd?: number; foreground?: number; buttonX?: number; buttonY?: number }
  const events = (): Event[] => existsSync(tracePath)
    ? readFileSync(tracePath, "utf8").split(/\r?\n/u).slice(0, -1).map(line => JSON.parse(line)) : []
  const target = () => events().find(event => event.kind === "ready")
  let frame: WindowsForegroundFrame | undefined
  let bridge: DesktopComputerBridge | undefined
  let server: VykorHttpServer | undefined
  let shortcut: string | undefined
  const model: StreamingMessageClient = {
    async *streamMessage({ messages, tools }) {
      const completed = messages.filter((message): message is ToolResultMessage =>
        message.type === "tool_result" && message.toolUseId.startsWith("stop-"))
      const latest = completed.at(-1)
      const actions: Record<string, unknown>[] = [{ action: "open_app", app: appName }, { action: "foreground" }, { action: "capture" }]
      let action = actions[completed.length]
      if (completed.length === 3 && !latest?.isError) {
        if (kind === "key") action = { action: "key", key: "F7" }
        else {
          const evidence = target()!
          const text = latest?.content.find(item => item.type === "text")
          const current = frame!
          const geometry = current.geometry
          action = { action: "click", frameRef: JSON.parse(text?.type === "text" ? text.text : "{}").frame.ref,
            x: Math.round((evidence.buttonX! - geometry.left) * current.width / geometry.width),
            y: Math.round((evidence.buttonY! - geometry.top) * current.height / geometry.height) }
        }
      }
      if (action && !latest?.isError && tools?.some(tool => tool.name === "Computer")) {
        yield { type: "tool_use_start", toolUse: { type: "tool_use", id: `stop-${completed.length}`, name: "Computer", input: action } }
        yield { type: "complete", stopReason: "tool_use" }
        return
      }
      yield { type: "complete", stopReason: "end_turn" }
    },
  }
  try {
    shortcut = registerFixture(directory, appName)
    vi.stubEnv("VYKOR_CONFIG_DIR", join(directory, "config"))
    vi.stubEnv("VYKOR_DATA_DIR", join(directory, "data"))
    vi.stubEnv("VYKOR_DISABLE_MODELS_FETCH", "1")
    const daemon = new VykorHttpServer({
      token: daemonToken, desktopComputerToken: computerToken, storePath: join(directory, "sessions.db"),
      settings: { model: "test-model", apiFormat: "openai", maxTurns: 7, permission: { mode: "ask" },
        plugins: { enabled: false }, memory: { enabled: false }, sandbox: { enabled: false } },
      async createAgent({ options }) {
        const agent = await createDefaultNodeAgent({ ...options, client: model, resolveModelImageSupport: async () => true })
        return { agent, host: agent.host }
      },
      logger: () => {},
    })
    server = daemon
    const baseUrl = (await daemon.listen()).url
    const client = new VykorClient({ baseUrl, token: daemonToken })
    const discover = () => apps.discover(appName, AbortSignal.timeout(5_000))
    await expect.poll(async () => (await discover()).length, { timeout: 14_000, interval: 300 }).toBe(1)
    const [app] = await discover()
    expect(await apps.windows(app!, AbortSignal.timeout(9_000))).toEqual([])
    const native = createWindowsForeground({ fault: "hold-release", onHeld: held.resolve })
    const host = new ComputerHost({
      discover: (name, signal) => apps.discover(name, signal),
      async launch(app, signal) {
        await apps.launch(app, signal)
        await expect.poll(target, { timeout: 6_000 }).toBeDefined()
        writeFileSync(join(directory, "focus.request"), "target")
        await expect.poll(() => events().filter(event => event.kind === "activate").at(-1)?.foreground,
          { timeout: 4_000 }).toBe(target()!.target)
      },
      windows: async (app, signal) => (await apps.windows(app, signal)).filter(window => window.windowId === target()?.target),
    }, {
      authorizeApp: async () => true, chooseTarget: async () => { throw new Error("Expected the exact test window") },
      armEmergencyStop: () => true,
    }, undefined, {
      enter: native.enter,
      capture: async (...args) => { frame = await native.capture(...args); return frame },
    })
    const desktop = new DesktopComputerBridge({ baseUrl, daemonPid: process.pid, daemonToken, computerToken, authorizeDaemon: () => {},
      execute: (...args) => host.execute(...args), revoke: (session, run) => host.revoke(session, run),
      cancel: (session, run) => { host.pause(session, run) },
    })
    bridge = desktop
    const session = await client.sessions.create({ cwd: directory, model: "test-model" })
    const admitted = await desktop.submit(session.id, { id: `stop-${kind}`, items: [{ type: "text", text: "操作测试窗口。" }] }, () => {})
    const runId = admitted.run!.id
    const pending = () => daemon.application.permissions.listRequests({ sessionId: session.id, toolName: "Computer", status: "pending" })
    for (let approval = 0; approval < 2; approval++) {
      await expect.poll(() => pending().length, { timeout: 20_000 }).toBe(1)
      await desktop.replyApproval(session.id, pending()[0]!.id, "approved")
    }
    expect(await Promise.race([held.promise, new Promise<undefined>(resolve => setTimeout(resolve, 8_000).unref())])).toBe(false)
    await expect.poll(() => events().filter(event => event.kind === down), { timeout: 4_000 })
      .toMatchObject([{ hwnd: target()!.target }])
    expect(events().filter(event => event.kind === up)).toEqual([])
    // Use the same order as Electron's chat Stop IPC handler.
    desktop.revoke(session.id, runId)
    await client.sessions.interrupt(session.id, { expectedRunId: runId, source: "user" })
    expect(await daemon.application.runControl.awaitRun(session.id, runId, { timeoutMs: 10_000 })).toMatchObject({ status: "interrupted" })
    expect(await host.waitForInputRelease()).toBe(true)
    await expect.poll(() => events().filter(event => event.kind === up), { timeout: 4_000 })
      .toMatchObject([{ hwnd: target()!.target }])
    expect(events().filter(event => event.kind === down)).toMatchObject([{ hwnd: target()!.target }])
  } finally {
    bridge?.close()
    await server?.close()
    if (target()) {
      writeFileSync(join(directory, "close.request"), "")
      await expect.poll(() => events().some(event => event.kind === "closed"), { timeout: 5_000 }).toBe(true)
    }
    if (shortcut) await rm(shortcut, { force: true })
    vi.unstubAllEnvs()
    await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })
  }
}, 90_000)
