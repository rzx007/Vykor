import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { expect, it, vi } from "vitest"
import { VykorClient } from "@rzx/client"
import { createDefaultNodeAgent } from "@vykor/agent-runtime"
import type { StreamingMessageClient, ToolResultMessage } from "@vykor/agent-contracts"
import { VykorHttpServer } from "@vykor/server"
import { closeNewWindow } from "./windows-live-cleanup"
import { registerFixture } from "./windows-live-fixture"
import { DesktopComputerBridge } from "../../../apps/desktop/src/main/features/computer/computer-bridge"
import { ComputerHost } from "../../../apps/desktop/src/main/features/computer/computer-host"
import type { ComputerApp } from "../../../apps/desktop/src/main/features/computer/computer-platform"
import { createWindowsComputerPlatform } from "../../../apps/desktop/src/main/features/computer/windows-computer-platform"
import {
  createWindowsApps,
  type WindowsAppWindow,
} from "../../../apps/desktop/src/main/features/computer/windows-apps"

const realWindows = process.platform === "win32" && process.arch === "x64"
  && process.env.VYKOR_COMPUTER_WINDOWS_LIVE === "1"

type Ready = {
  status: "ready"
  source: "launched" | "reused"
  app: { name: string; ref: string }
  window: { title: string; ref: string; kind: "window" | "dialog" }
}

function result(message: ToolResultMessage): Ready {
  const content = message.content.find(item => item.type === "text")
  if (message.isError || content?.type !== "text") throw new Error(`Computer action failed: ${JSON.stringify(message.content)}`)
  const ready: Ready = JSON.parse(content.text)
  expect(ready).toMatchObject({ status: "ready", window: { ref: expect.any(String) } })
  return ready
}

function fixtureEvent(path: string, kind: string): { hwnd?: number; owner?: number; pid?: number; targetTitle?: string } | undefined {
  if (!existsSync(path)) return
  const text = readFileSync(path, "utf8")
  return text.slice(0, text.lastIndexOf("\n") + 1).split(/\r?\n/).filter(Boolean)
    .map(line => JSON.parse(line)).find(line => line.kind === kind)
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false
    throw error
  }
}

it.runIf(realWindows)("preserves arguments from a real registered Windows shortcut", async () => {
  const directory = mkdtempSync(join(tmpdir(), "vykor shortcut "))
  const fixtureName = "Vykor Launch " + randomBytes(4).toString("hex")
  const tracePath = join(directory, "registered arguments.jsonl")
  const label = "Profile A & B"
  const provider = createWindowsApps()
  let shortcut: string | undefined
  let app: ComputerApp | undefined
  try {
    shortcut = registerFixture(directory, fixtureName, `"${tracePath}" "${label}"`)
    await expect.poll(async () => {
      app = (await provider.discover(fixtureName, AbortSignal.timeout(6_000)))[0]
      return app?.name
    }, { timeout: 18_000 }).toBe(fixtureName)
    expect(app?.confirmExistingWindow).toBe(true)
    await provider.launch(app!, AbortSignal.timeout(8_000))
    await expect.poll(() => fixtureEvent(tracePath, "ready"), { timeout: 10_000 })
      .toMatchObject({ targetTitle: "Vykor Cua probe " + label })
    expect(await provider.windows(app!, AbortSignal.timeout(8_000)))
      .toContainEqual(expect.objectContaining({ title: "Vykor Cua probe " + label }))
  } finally {
    if (shortcut) await rm(shortcut, { force: true })
    writeFileSync(join(directory, "close.request"), "")
    const pid = fixtureEvent(tracePath, "ready")?.pid
    if (pid) await expect.poll(() => processExists(pid), { timeout: 5_000 }).toBe(false)
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}, 55_000)

it.runIf(realWindows)("opens and hands off real Windows applications from a trusted chat run", async () => {
  const directory = mkdtempSync(join(tmpdir(), "vykor-stage3-live-"))
  const fixtureName = "Vykor Stage3 " + randomBytes(4).toString("hex")
  const tracePath = join(directory, "fixture.jsonl")
  const daemonToken = randomBytes(24).toString("hex")
  const computerToken = randomBytes(32).toString("hex")
  const platform = createWindowsComputerPlatform()
  const provider = platform.apps
  const waitSignal = () => AbortSignal.timeout(10_000)
  const permissions: string[] = []
  const selections: string[][] = []
  const launches: ComputerApp[] = []
  const startedAfter = Date.now()
  let firstCalculator: WindowsAppWindow | undefined
  let calculator: ComputerApp | undefined
  let paint: ComputerApp | undefined
  let fixtureApp: ComputerApp | undefined
  let modal: { hwnd?: number; owner?: number } | undefined
  let fixtureCandidates: WindowsAppWindow[] = []
  let pickedWindowId: number | undefined
  let shortcut: string | undefined
  let bridge: DesktopComputerBridge | undefined
  let server: VykorHttpServer | undefined

  const open = (app: string, windowHint?: string) =>
    ({ action: "open_app", app, ...(windowHint ? { windowHint } : {}) })
  const builtinPrompt = "打开计算器并确认就绪，然后切换到画图，最后回到最初的计算器。"
  const fixturePrompt = `打开 ${fixtureName} 的 Meeting notes.txt，选定同名文档后接续到新弹出的对话框。`
  const programs = new Map([
    [builtinPrompt, { id: "builtin", steps: [open("Calculator"), open("Paint"), open("Calculator")] }],
    [fixturePrompt, { id: "fixture", steps: [open(fixtureName, "Meeting notes.txt"), open(fixtureName, "Meeting notes.txt"), { action: "observe" }] }],
  ])
  const outputs = new Map<string, ToolResultMessage[]>()
  const model: StreamingMessageClient = {
    async *streamMessage({ messages, tools }) {
      const user = messages.findLast(message => message.type === "user")
      const text = typeof user?.content === "string" ? user.content
        : user?.content.filter(item => item.type === "text").map(item => item.text).join("") ?? ""
      const program = programs.get(text.trim())
      if (program) {
        const completed = messages.filter((message): message is ToolResultMessage =>
          message.type === "tool_result" && message.toolUseId.startsWith(program.id + "-"))
        outputs.set(program.id, completed)
        if (program.id === "fixture" && !completed.at(-1)?.isError && pickedWindowId) {
          if (completed.length === 1) {
            writeFileSync(join(directory, "unique.request"), String(pickedWindowId))
            await expect.poll(() => fixtureEvent(tracePath, "unique"), { timeout: 8_000 }).toBeDefined()
          }
          if (completed.length === 2) {
            writeFileSync(join(directory, "modal.request"), String(pickedWindowId))
            await expect.poll(() => (modal = fixtureEvent(tracePath, "modal")), { timeout: 8_000 }).toBeDefined()
          }
        }
        const action = program.steps[completed.length]
        if (action && !completed.at(-1)?.isError && tools?.some(tool => tool.name === "Computer")) {
          yield {
            type: "tool_use_start", toolUse: {
              type: "tool_use", id: program.id + "-" + completed.length, name: "Computer", input: action,
            },
          }
          yield { type: "complete", stopReason: "tool_use" }
          return
        }
      }
      yield { type: "text_delta", delta: "Windows verification completed." }
      yield { type: "complete", stopReason: "end_turn" }
    },
  }
  try {
    const profile = join(directory, "profile")
    mkdirSync(profile)
    vi.stubEnv("USERPROFILE", profile)
    vi.stubEnv("HOME", profile)
    vi.stubEnv("VYKOR_CONFIG_DIR", join(directory, "config"))
    vi.stubEnv("VYKOR_DATA_DIR", join(directory, "data"))
    vi.stubEnv("VYKOR_DISABLE_MODELS_FETCH", "1")
    const runningServer = new VykorHttpServer({
      token: daemonToken, desktopComputerToken: computerToken, storePath: join(directory, "sessions.db"),
      settings: {
        model: "test-model", apiFormat: "openai", maxTurns: 6, permission: { mode: "ask" },
        plugins: { enabled: false }, memory: { enabled: false }, sandbox: { enabled: false },
      },
      async createAgent({ options }) {
        const agent = await createDefaultNodeAgent({ ...options, client: model })
        return { agent, host: agent.host }
      },
      logger: () => {},
    })
    server = runningServer
    const calculatorApps = await provider.discover("Calculator", waitSignal())
    const paintApps = await provider.discover("Paint", waitSignal())
    expect(calculatorApps).toHaveLength(1)
    expect(paintApps).toHaveLength(1)
    calculator = calculatorApps[0]!
    paint = paintApps[0]!
    const calculatorBefore = await provider.windows(calculator, waitSignal())
    const paintBefore = await provider.windows(paint, waitSignal())
    expect(calculatorBefore.length).toBeLessThanOrEqual(1)
    expect(paintBefore.length).toBeLessThanOrEqual(1)
    const coldApps = [calculatorBefore.length ? undefined : calculator, paintBefore.length ? undefined : paint]
      .filter(app => app !== undefined)

    const host = new ComputerHost({
      ...platform,
      openDriver: undefined,
      foreground: undefined,
      apps: {
        ...provider,
        async windows(app, signal) {
          const windows = await provider.windows(app, signal)
          if (app.id === fixtureApp?.id) fixtureCandidates = windows
          return windows
        },
        launch: async (app, signal) => { launches.push(app); await provider.launch(app, signal) },
      },
    }, {
      async authorizeApp(app, signal) {
        permissions.push(app.name)
        if (app.id === paint?.id && calculator) {
          const windows = await provider.windows(calculator, signal)
          expect(windows).toHaveLength(1)
          firstCalculator = windows[0]
        }
        return true
      },
      async chooseTarget(candidates) {
        selections.push(candidates.map(candidate => candidate.label))
        const selected = candidates[0]
        if (selected && selections.length === 1) {
          pickedWindowId = fixtureCandidates.find(window => window.title === selected.label)?.windowId
        }
        return selected?.id
      },
    })
    const baseUrl = (await runningServer.listen()).url
    const ordinary = new VykorClient({ baseUrl, token: daemonToken })
    bridge = new DesktopComputerBridge({
      baseUrl, daemonPid: process.pid, daemonToken, computerToken, authorizeDaemon: () => {},
      execute: (...args) => host.execute(...args),
      revoke: (sessionId, runId) => host.revoke(sessionId, runId),
    })
    async function send(text: string, id: string) {
      const session = await ordinary.sessions.create({ cwd: directory, model: "test-model" })
      const admitted = await bridge!.submit(session.id, { id, items: [{ type: "text", text }] }, () => {})
      expect(admitted.run?.id).toBeTruthy()
      expect(await runningServer.application.runControl.awaitRun(session.id, admitted.run!.id, { timeoutMs: 52_000 }))
        .toMatchObject({ status: "completed" })
      expect(runningServer.application.permissions.listRequests({ sessionId: session.id, toolName: "Computer" })).toEqual([])
      return (outputs.get(id) ?? []).map(result)
    }
    const builtins = await send(builtinPrompt, "builtin")
    expect(builtins.map(ready => ready.source)).toEqual([
      calculatorBefore.length ? "reused" : "launched", paintBefore.length ? "reused" : "launched", "reused",
    ])
    expect(builtins.map(ready => ready.app.name)).toEqual([calculator.name, paint.name, calculator.name])
    const calculatorAfter = await provider.windows(calculator, waitSignal())
    expect(calculatorAfter).toHaveLength(1)
    expect(calculatorAfter[0]).toMatchObject({
      pid: firstCalculator?.pid, windowId: firstCalculator?.windowId, processStartedAt: firstCalculator?.processStartedAt,
    })
    expect(selections).toEqual([])
    expect(permissions).toEqual([calculator.name, paint.name])
    console.log("Windows verification: Calculator and Paint launched or reused as appropriate. The same Calculator window was then reused without a picker.")

    shortcut = registerFixture(directory, fixtureName)
    await expect.poll(async () => {
      fixtureApp = (await provider.discover(fixtureName, waitSignal()))[0]
      return fixtureApp?.name
    }, { timeout: 18_000, interval: 500 }).toBe(fixtureName)
    expect(await provider.windows(fixtureApp!, waitSignal()), "Fixture must start without an open window").toEqual([])
    const fixtureResults = await send(fixturePrompt, "fixture")
    expect(fixtureResults.slice(0, 2).map(ready => ready.source)).toEqual(["launched", "reused"])
    expect(fixtureResults[0]?.window.title).toContain("Meeting notes.txt")
    expect(fixtureResults[1]?.window.ref).toBe(fixtureResults[0]?.window.ref)
    expect(fixtureResults[2]?.window).toMatchObject({ title: "Vykor Stage 3 owned dialog", kind: "dialog" })
    expect(fixtureResults[2]?.window.ref).not.toBe(fixtureResults[1]?.window.ref)
    expect(selections).toHaveLength(1)
    expect(selections[0]).toHaveLength(2)
    expect(new Set(selections[0]).size).toBe(1)
    expect(permissions).toEqual([calculator.name, paint.name, fixtureName])
    expect(launches.map(app => app.name)).toEqual([...coldApps.map(app => app.name), fixtureName])
    const nativeModal = (await provider.windows(fixtureApp!, waitSignal())).find(window => window.windowId === modal?.hwnd)
    expect(modal?.owner).toBe(pickedWindowId)
    expect(nativeModal).toMatchObject({ ownerWindowId: pickedWindowId })
    console.log("Windows verification: one picker for two same-title documents, then the unique document and owned modal were reused without another picker or permission.")
  } finally {
    try {
      bridge?.close()
      await server?.close()
      if (shortcut) rmSync(shortcut, { force: true })
      for (const app of launches.filter(app => app.id === calculator?.id || app.id === paint?.id)) {
        const current = await provider.windows(app, waitSignal())
        if (current.length > 1) throw new Error("Cannot establish ownership of all live application windows")
        if (current.length === 1) closeNewWindow(current[0]!, startedAfter)
      }
      if (existsSync(tracePath)) {
        const pid = fixtureEvent(tracePath, "ready")?.pid
        writeFileSync(join(directory, "close.request"), "")
        if (pid) {
          await expect.poll(() => processExists(pid), { timeout: 4_000, interval: 50 }).toBe(false)
        } else {
          await expect.poll(() => fixtureEvent(tracePath, "closed"), { timeout: 4_000, interval: 50 }).toBeDefined()
        }
      }
    } finally {
      vi.unstubAllEnvs()
      try {
        await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      } catch (error) {
        const { code } = error as NodeJS.ErrnoException
        if (code !== "EPERM" && code !== "EBUSY") throw error
        console.log("Windows has retained files in this test-only scratch directory: " + directory)
      }
    }
  }
}, 110_000)
