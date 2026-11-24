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
import { createWindowsComputerPlatform } from "../../../apps/desktop/src/main/features/computer/windows-computer-platform"
import type { ComputerForegroundFrame } from "../../../apps/desktop/src/main/features/computer/computer-platform"
import { createWindowsForeground } from "../../../apps/desktop/src/main/features/computer/windows-foreground"
import { createWindowsDriver } from "../../../apps/desktop/src/main/features/computer/windows-driver"
import type { DesktopComputerActivity } from "../../../apps/desktop/src/shared/computer-types"
import { closeNewWindow } from "./windows-live-cleanup"
import { registerFixture } from "./windows-live-fixture"

const realWindows = process.platform === "win32" && process.arch === "x64"
  && process.env.VYKOR_COMPUTER_WINDOWS_FOREGROUND_LIVE === "1"

it.runIf(realWindows)("observes and safely drives a real Calculator through the private chat bridge", async context => {
  const platform = createWindowsComputerPlatform()
  const { apps } = platform
  const windows = () => AbortSignal.timeout(8_000)
  const [calculator] = await apps.discover("Calculator", windows())
  expect(calculator).toBeDefined()
  // This test must be the owner of every window it reads or changes.
  if ((await apps.windows(calculator!, windows())).length) context.skip()
  const started = Date.now()
  const directory = mkdtempSync(join(tmpdir(), "vykor-stage5-live-"))
  const daemonToken = randomBytes(24).toString("hex")
  const computerToken = randomBytes(32).toString("hex")
  const resourcesPath = process.env.VYKOR_COMPUTER_TEST_RESOURCES
  const arithmetic = [/^(?:7|七)$/u, /multiply|乘/u, /^(?:8|八)$/u, /equal|等于/u]
  const actions: (Record<string, unknown> | RegExp)[] = [
    { action: "open_app", app: "Calculator" },
    ...(resourcesPath ? [{ action: "observe" }, ...arithmetic, { action: "observe" }] : []),
    { action: "foreground" }, { action: "capture" },
    { action: "key", key: "Tab" }, { action: "capture" },
    ...(resourcesPath ? [{ action: "observe" }, { action: "capture", purpose: "result" }] : []),
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
      let action = actions[results.length]
      if (action instanceof RegExp && !latest?.isError) {
        const label = action
        const content = latest?.content.find(item => item.type === "text")
        const state = content?.type === "text" ? JSON.parse(content.text) : {}
        const control = state.observation?.elements.find((item: { label: string; actions: string[] }) =>
          item.actions.includes("invoke") && label.test(item.label.toLowerCase()))
        expect(control, state.observation?.elements.map((item: { label: string }) => item.label).join(", ")).toBeDefined()
        action = { action: "invoke", elementRef: control.ref }
      }
      if (action && !(action instanceof RegExp) && !latest?.isError && tools?.some(tool => tool.name === "Computer")) {
        yield { type: "tool_use_start", toolUse: { type: "tool_use", id: `calculator-${results.length}`, name: "Computer", input: action } }
        yield { type: "complete", stopReason: "tool_use" }
        return
      }
      yield { type: "text_delta", delta: resourcesPath ? "计算器显示 56。" : "已结束计算器验证。" }
      yield { type: "complete", stopReason: "end_turn" }
    },
  }
  vi.stubEnv("VYKOR_CONFIG_DIR", join(directory, "config"))
  vi.stubEnv("VYKOR_DATA_DIR", join(directory, "data"))
  vi.stubEnv("VYKOR_DISABLE_MODELS_FETCH", "1")
  const server = new VykorHttpServer({
    token: daemonToken, desktopComputerToken: computerToken, storePath: join(directory, "sessions.db"),
    settings: { model: "test-model", apiFormat: "openai", maxTurns: 16, permission: { mode: "ask" },
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
    const host = new ComputerHost({
      ...platform,
      openDriver: resourcesPath ?
        (target, signal) => createWindowsDriver(target, signal, join(resourcesPath, "computer-windows", "cua-driver.exe")) :
        undefined,
    }, {
      authorizeApp: async () => true,
      chooseTarget: async () => { throw new Error("Expected one test-owned Calculator window") },
      emergencyStop: () => {},
      showForeground: async () => {},
      publishActivity: (_session, state) => { activity = state },
    })
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
    const session = await client.sessions.create({ cwd: directory, model: "test-model",
      metadata: { runtime: { approvalMode: "full_access" } } })
    const request = resourcesPath ? "打开计算器，算出 7 × 8，核对结果并给我一张截图。" : "打开计算器，观察窗口并按 Tab。"
    const admitted = await desktop.submit(session.id, { id: "calculator", items: [{ type: "text", text: request }] }, () => {})
    expect(admitted.run?.id).toBeTruthy()
    expect(await server.application.runControl.awaitRun(session.id, admitted.run!.id, { timeoutMs: 70_000 })).toMatchObject({ status: "completed" })
    expect(server.application.permissions.listRequests({ sessionId: session.id, toolName: "Computer" })).toHaveLength(0)
    const values = results.map((result, index) => {
      const body = result.content.find(item => item.type === "text")
      if (body?.type !== "text" || result.isError) throw new Error(`Calculator step failed: ${desktopOutcomes.join(" | ")}`)
      if (resourcesPath && index === actions.length - 1) {
        expect(body.text).toContain("Captured the result window")
        expect(result.content.some(item => item.type === "image")).toBe(false)
        return { status: "result_captured" }
      }
      return JSON.parse(body.text)
    })
    expect(values).toMatchObject([
      { status: "ready", source: "launched" },
      ...(resourcesPath ? [{ status: "observed" }, ...arithmetic.map(() => ({ status: "observed_change" })), { status: "observed" }] : []),
      { status: "foreground" }, { status: "captured" },
      { status: "sent", inputReleased: true }, { status: "captured" },
      ...(resourcesPath ? [{ status: "observed" }, { status: "result_captured" }] : []),
    ])
    if (resourcesPath) {
      expect(values.at(-2)?.observation?.elements.some((item: { label: string; value?: string }) =>
        /(^|\D)56(\D|$)/u.test(item.value ?? item.label))).toBe(true)
      const parts = await client.sessions.listMessageParts(session.id)
      const answer = parts.find(part => part.type === "text" && part.text === "计算器显示 56。")
      expect(parts.filter(part => part.type === "attachment")).toEqual([
        expect.objectContaining({ messageId: answer?.messageId, mediaType: "image/png", assetId: expect.any(String) }),
      ])
    }
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
}, 175_000)

it.skipIf(!realWindows).each([["key", "ask"], ["click", "ask"], ["click", "full_access"], ["drag", "ask"]] as const)(
  "releases a held %s in %s mode through actual chat Stop before an up is queued", async (kind, mode) => {
  const directory = mkdtempSync(join(tmpdir(), "vykor-chat-stop-live-"))
  const appName = `Vykor Stop ${randomBytes(4).toString("hex")}`
  const tracePath = join(directory, "fixture.jsonl")
  const daemonToken = randomBytes(24).toString("hex")
  const computerToken = randomBytes(32).toString("hex")
  const platform = createWindowsComputerPlatform()
  const { apps } = platform
  const down = kind === "key" ? "key-down-F7" : "mouse-down-Left"
  const up = kind === "key" ? "key-up-F7" : "mouse-up-Left"
  const held = Promise.withResolvers<boolean>()
  const showForeground = vi.fn(async () => {})
  const outcomes: string[] = []
  type Event = { kind: string; target?: number; hwnd?: number; foreground?: number; buttonX?: number; buttonY?: number }
  const events = (): Event[] => existsSync(tracePath)
    ? readFileSync(tracePath, "utf8").split(/\r?\n/u).slice(0, -1).map(line => JSON.parse(line)) : []
  const target = () => events().find(event => event.kind === "ready")
  let frame: ComputerForegroundFrame | undefined
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
          const x = Math.round((evidence.buttonX! - geometry.left) * current.width / geometry.width)
          const y = Math.round((evidence.buttonY! - geometry.top) * current.height / geometry.height)
          action = { action: kind, frameRef: JSON.parse(text?.type === "text" ? text.text : "{}").frame.ref,
            x, y, ...(kind === "drag" ? { toX: x + 48, toY: y } : {}) }
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
      settings: { model: "test-model", apiFormat: "openai", maxTurns: 7, permission: { mode },
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
      ...platform,
      openDriver: undefined,
      apps: {
        discover: (name, signal) => apps.discover(name, signal),
        async launch(app, signal) {
          await apps.launch(app, signal)
          await expect.poll(target, { timeout: 6_000 }).toBeDefined()
          writeFileSync(join(directory, "focus.request"), "target")
          await expect.poll(() => events().filter(event => event.kind === "focus-request").at(-1)?.foreground,
            { timeout: 4_000 }).toBe(target()!.target)
        },
        windows: async (app, signal) => (await apps.windows(app, signal)).filter(window => window.windowId === target()?.target),
      },
      foreground: {
        enter: native.enter,
        capture: async (...args) => { frame = await native.capture(...args); return frame },
      },
    }, {
      authorizeApp: async () => true, chooseTarget: async () => { throw new Error("Expected the exact test window") },
      emergencyStop: () => {},
      showForeground,
    })
    const desktop = new DesktopComputerBridge({ baseUrl, daemonPid: process.pid, daemonToken, computerToken, authorizeDaemon: () => {},
      async execute(...args) {
        const result = await host.execute(...args)
        outcomes.push(args[0].action.type + " " + ("error" in result ? result.error : result.text))
        return result
      },
      revoke: (session, run) => host.revoke(session, run),
      cancel: (session, run) => { host.pause(session, run) },
    })
    bridge = desktop
    const session = await client.sessions.create({ cwd: directory, model: "test-model" })
    const admitted = await desktop.submit(session.id, { id: `stop-${kind}`, items: [{ type: "text", text: "操作测试窗口。" }] }, () => {})
    const runId = admitted.run!.id
    const pending = () => daemon.application.permissions.listRequests({ sessionId: session.id, toolName: "Computer", status: "pending" })
    if (mode === "ask") {
      for (let approval = 0; approval < 2; approval++) {
        await expect.poll(() => pending().length, { timeout: 20_000 }).toBe(1)
        await desktop.replyApproval(session.id, pending()[0]!.id, "approved")
      }
    } else {
      await expect.poll(() => showForeground.mock.calls.length, { timeout: 20_000 }).toBe(1)
    }
    expect(await Promise.race([held.promise, new Promise<undefined>(resolve => setTimeout(resolve, 8_000).unref())])).toBe(false)
    await expect.poll(() => events().filter(event => event.kind === down), { timeout: 4_000 })
      .toMatchObject([{ hwnd: target()!.target }])
    if (mode === "full_access") {
      expect(daemon.application.permissions.listRequests({ sessionId: session.id, toolName: "Computer" })).toHaveLength(0)
      expect(showForeground).toHaveBeenCalledOnce()
    }
    expect(events().filter(event => event.kind === up)).toEqual([])
    if (kind === "drag") await expect.poll(() => events().filter(event => event.kind === "mouse-drag"))
      .toMatchObject([{ hwnd: target()!.target }])
    // Use the same order as Electron's chat Stop IPC handler.
    desktop.revoke(session.id, runId)
    await client.sessions.interrupt(session.id, { expectedRunId: runId, source: "user" })
    expect(await daemon.application.runControl.awaitRun(session.id, runId, { timeoutMs: 10_000 })).toMatchObject({ status: "interrupted" })
    expect(await host.waitForInputRelease()).toBe(true)
    await expect.poll(() => events().filter(event => event.kind === up), { timeout: 4_000 })
      .toMatchObject([{ hwnd: target()!.target }])
    expect(events().filter(event => event.kind === down)).toMatchObject([{ hwnd: target()!.target }])
    if (kind === "drag") expect(events().filter(event => event.kind === "mouse-drag")).toHaveLength(1)
  } catch (error) {
    throw new Error(`Foreground fixture failed. ${outcomes.join(" | ")}`, { cause: error })
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
