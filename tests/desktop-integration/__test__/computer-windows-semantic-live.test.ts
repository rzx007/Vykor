import { execFile } from "node:child_process"
import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { VykorClient } from "@rzx/client"
import type { StreamingMessageClient, ToolResultMessage } from "@vykor/agent-contracts"
import { createDefaultNodeAgent } from "@vykor/agent-runtime"
import { VykorHttpServer } from "@vykor/server"
import { expect, it, vi } from "vitest"
import { DesktopComputerBridge } from "../../../apps/desktop/src/main/features/computer/computer-bridge"
import { ComputerHost } from "../../../apps/desktop/src/main/features/computer/computer-host"
import type { WindowsAppWindow } from "../../../apps/desktop/src/main/features/computer/windows-apps"
import { createWindowsComputerPlatform } from "../../../apps/desktop/src/main/features/computer/windows-computer-platform"
import { createWindowsDriver } from "../../../apps/desktop/src/main/features/computer/windows-driver"
import cua from "../../../apps/desktop/resources/computer-windows/driver-release.json"
import { registerFixture } from "./windows-live-fixture"
import { closeNewWindow } from "./windows-live-cleanup"

const enabled = process.platform === "win32" && process.arch === "x64"
  && process.env.VYKOR_COMPUTER_WINDOWS_SEMANTIC_LIVE === "1"
const windowsRoot = process.env.SystemRoot ?? String.raw`C:\Windows`
const powershell = join(windowsRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
const desktopPath = fileURLToPath(new URL("../../../apps/desktop/", import.meta.url))
const run = promisify(execFile)

async function launchTestDocument(path: string, signal: AbortSignal) {
  // Seed a uniquely named scratch document. The chat then uses the unmodified production provider.
  await run(powershell, ["-NoProfile", "-NonInteractive", "-STA", "-Command", String.raw`
    $ErrorActionPreference = 'Stop'
    Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
public static class VykorNotepadDraft {
  [ComImport, Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C")]
  private class Manager {}
  [ComImport, Guid("2e941141-7f97-4756-ba1d-9decde894a3d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IManager {
    void ActivateApplication([MarshalAs(UnmanagedType.LPWStr)] string app,
      [MarshalAs(UnmanagedType.LPWStr)] string args, uint flags, out uint pid);
  }
  public static void Open(string path) {
    var manager = (IManager)new Manager();
    try {
      uint pid;
      manager.ActivateApplication("Microsoft.WindowsNotepad_8wekyb3d8bbwe!App", "\"" + path + "\"", 0, out pid);
    } finally { Marshal.FinalReleaseComObject(manager); }
  }
}
'@
    [VykorNotepadDraft]::Open($env:VYKOR_SEMANTIC_TEST_DRAFT)
  `], { env: { ...process.env, VYKOR_SEMANTIC_TEST_DRAFT: path }, windowsHide: true, timeout: 8_000, signal })
}

type Observation = {
  status: string
  source?: string
  evidence?: string
  window?: { title: string; ref: string }
  observation?: { elements: Array<{ ref: string; label: string; role: string; value?: string; actions: string[] }> }
}

function result(message: ToolResultMessage | undefined): Observation {
  const content = message?.content.find(item => item.type === "text")
  if (!message || message.isError || content?.type !== "text") {
    throw new Error(`Computer action failed: ${JSON.stringify(message?.content)}`)
  }
  return JSON.parse(content.text)
}

it.skipIf(!enabled).each(["notepad", "fixture"])("accepts Windows semantic control in %s", async (scenario) => {
  const suffix = randomBytes(4).toString("hex")
  const directory = mkdtempSync(join(tmpdir(), "vykor-stage4-live-"))
  const fixtureName = `Vykor Stage4 ${suffix}`
  const tracePath = join(directory, "fixture.jsonl")
  const draftDirectory = mkdtempSync(join(tmpdir(), "vykor-stage4-draft-"))
  const draftName = `VykorStage4-${suffix}.txt`
  const draftPath = join(draftDirectory, draftName)
  const expectedText = `Vykor ${suffix}\n第二行：Windows 语义写入\nThird line.`
  const driver = join(desktopPath, "out", "computer-windows", "x64", cua.executable)
  const daemonToken = randomBytes(24).toString("hex")
  const computerToken = randomBytes(32).toString("hex")
  const platform = createWindowsComputerPlatform()
  const provider = platform.apps
  const launches: string[] = []
  const selections: number[] = []
  let shortcut: string | undefined
  let bridge: DesktopComputerBridge | undefined
  let server: VykorHttpServer | undefined
  let draftOpened = false
  let extraNotepadWindow: WindowsAppWindow | undefined
  const startedAfter = Date.now()
  let fixtureWindows: WindowsAppWindow[] = []
  const events = (): Array<{ kind: string; hwnd?: number; clicks?: number; target?: number; control?: number; foreground?: number }> => existsSync(tracePath)
    ? readFileSync(tracePath, "utf8").split(/\r?\n/u).slice(0, -1).map(line => JSON.parse(line)) : []

  const outputs = new Map<string, ToolResultMessage[]>()
  const prompts = new Map([
    [`打开记事本中已有的 ${draftName}，写入三行文字，再独立读回。`, "notepad"],
    ["再打开一个独立的记事本窗口。", "notepad-new"],
    ["打开测试窗口并触发增量按钮。", "approve"],
    ["打开测试窗口，触发延时按钮，再触发增量按钮。", "stop"],
    ["打开测试窗口并触发延时按钮，执行时暂停。", "pause"],
  ])
  const model: StreamingMessageClient = {
    async *streamMessage({ messages, tools }) {
      const user = messages.findLast(message => message.type === "user")
      const input = typeof user?.content === "string" ? user.content
        : user?.content.filter(item => item.type === "text").map(item => item.text).join("").trim() ?? ""
      const name = prompts.get(input)
      if (name) {
        const completed = messages.filter((message): message is ToolResultMessage =>
          message.type === "tool_result" && message.toolUseId.startsWith(`${name}-`))
        outputs.set(name, completed)
        const step = completed.length
        let action: Record<string, unknown> | undefined
        if (step === 0) {
          action = name === "notepad" ? { action: "open_app", app: "Notepad", windowHint: draftName }
            : name === "notepad-new" ? { action: "open_app", app: "Notepad", newWindow: true }
              : { action: "open_app", app: fixtureName }
        }
        if (name !== "notepad-new" && (step === 1 || (step === 3 && name !== "approve"))) action = { action: "observe" }
        if ((step === 2 || (step === 4 && name === "stop")) && !completed.at(-1)?.isError) {
          const elements = result(completed.at(-1)).observation?.elements ?? []
          const element = name === "notepad"
            ? elements.find(item => item.actions.includes("set_text") && item.role.toLowerCase() === "document")
            : elements.find(item => item.label === ((name === "stop" || name === "pause") && step === 2 ? "Delayed action" : "Increment once")
              && item.actions.includes("invoke"))
          if (!element) throw new Error(`Expected ${name} control is unavailable: ${JSON.stringify(elements)}`)
          action = name === "notepad" ? { action: "set_text", elementRef: element.ref, text: expectedText }
            : { action: "invoke", elementRef: element.ref }
        }
        if (action && (!completed.at(-1)?.isError || name === "notepad" && step === 3) && tools?.some(tool => tool.name === "Computer")) {
          yield { type: "tool_use_start", toolUse: { type: "tool_use", id: `${name}-${step}`, name: "Computer", input: action } }
          yield { type: "complete", stopReason: "tool_use" }
          return
        }
      }
      yield { type: "text_delta", delta: "已结束测试。" }
      yield { type: "complete", stopReason: "end_turn" }
    },
  }

  try {
    if (scenario !== "notepad") shortcut = registerFixture(directory, fixtureName)
    mkdirSync(join(directory, "profile"))
    vi.stubEnv("USERPROFILE", join(directory, "profile"))
    vi.stubEnv("HOME", join(directory, "profile"))
    vi.stubEnv("VYKOR_CONFIG_DIR", join(directory, "config"))
    vi.stubEnv("VYKOR_DATA_DIR", join(directory, "data"))
    vi.stubEnv("VYKOR_DISABLE_MODELS_FETCH", "1")

    const runningServer = new VykorHttpServer({
      token: daemonToken, desktopComputerToken: computerToken, storePath: join(directory, "sessions.db"),
      settings: {
        model: "test-model", apiFormat: "openai", maxTurns: 7, permission: { mode: "ask" },
        plugins: { enabled: false }, memory: { enabled: false }, sandbox: { enabled: false },
      },
      async createAgent({ options }) {
        const agent = await createDefaultNodeAgent({ ...options, client: model })
        return { agent, host: agent.host }
      },
      logger: () => {},
    })
    server = runningServer
    const host = new ComputerHost({
      ...platform,
      foreground: undefined,
      openDriver: (window, signal) => createWindowsDriver(window, signal, driver),
      apps: {
        ...provider,
        async windows(app, signal) {
          const windows = await provider.windows(app, signal)
          if (app.name === fixtureName) fixtureWindows = windows
          return windows
        },
        async launch(app, signal) {
          launches.push(app.name)
          await provider.launch(app, signal)
        },
      },
    }, {
      async authorizeApp() { return true },
      async chooseTarget(candidates, _signal, _session, confirmChange) {
        if (scenario === "notepad") {
          if (!confirmChange) return
          return candidates.find(candidate => candidate.label.includes(draftName))?.id
        }
        selections.push(candidates.length)
        const ready = events().find(event => event.kind === "ready")
        const target = fixtureWindows.find(window => window.windowId === ready?.target)
        if (!target?.position || ready?.foreground === ready?.target) throw new Error("The test background window is unavailable")
        const { left, top } = target.position
        return candidates.find(candidate => candidate.detail?.includes(`屏幕位置 ${left}, ${top}`))?.id
      },
    })
    const baseUrl = (await runningServer.listen()).url
    const client = new VykorClient({ baseUrl, token: daemonToken })
    const desktop = new DesktopComputerBridge({
      baseUrl, daemonPid: process.pid, daemonToken, computerToken, authorizeDaemon: () => {},
      execute: (event, signal, connectionSignal, approve, dispatch) => host.execute(event, signal, connectionSignal, approve, dispatch),
      revoke: (sessionId, runId) => host.revoke(sessionId, runId),
    })
    bridge = desktop

    const queue = async (name: string) => {
      const prompt = Array.from(prompts).find(([, id]) => id === name)?.[0]
      if (!prompt) throw new Error(`Unknown test scenario ${name}`)
      const session = await client.sessions.create({ cwd: directory, model: "test-model" })
      const admitted = await desktop.submit(session.id, { id: name, items: [{ type: "text", text: prompt }] }, () => {})
      if (!admitted.run?.id) throw new Error(`Desktop did not admit the ${name} chat run`)
      return { sessionId: session.id, runId: admitted.run.id }
    }
    const settle = ({ sessionId, runId }: Awaited<ReturnType<typeof queue>>) =>
      runningServer.application.runControl.awaitRun(sessionId, runId, { timeoutMs: 40_000 })
    const pending = (sessionId: string) =>
      runningServer.application.permissions.listRequests({ sessionId, toolName: "Computer", status: "pending" })
    const approve = async (name: string, sessionId: string, numberOfClicks: number) => {
      try {
        await expect.poll(() => pending(sessionId).length, { timeout: 18_000 }).toBe(1)
      } catch (error) {
        const [run] = (await client.sessions.getState(sessionId)).runs
        const state = run && await settle({ sessionId, runId: run.id }).catch(() => ({ status: run.status }))
        throw new Error(`No approval for ${name}. Run: ${JSON.stringify(state)}; tool output: ${JSON.stringify(outputs.get(name))}; Windows events: ${JSON.stringify(events())}`, { cause: error })
      }
      const [request] = pending(sessionId)
      expect(request).toMatchObject({ payload: { computerApproval: true } })
      expect(events().filter(event => event.kind === "click")).toHaveLength(numberOfClicks)
      await desktop.replyApproval(sessionId, request!.id, "approved")
    }

    if (scenario === "notepad") {
      const [app] = await provider.discover("Notepad", AbortSignal.timeout(8_000))
      expect(app).toBeDefined()
      writeFileSync(draftPath, "")
      await launchTestDocument(draftPath, AbortSignal.timeout(8_000))
      draftOpened = true
      const windows = () => provider.windows(app!, AbortSignal.timeout(8_000))
      await expect.poll(async () => (await windows()).find(window => window.title.includes(draftName)),
        { timeout: 12_000 }).toBeDefined()
      const notepad = await queue("notepad")
      await approve("notepad", notepad.sessionId, 0)
      expect(await settle(notepad)).toMatchObject({ status: "completed" })
      const notepadResults = outputs.get("notepad") ?? []
      expect(notepadResults).toHaveLength(4)
      const reused = result(notepadResults[0])
      expect(reused).toMatchObject({ status: "ready", source: "reused", window: { title: expect.stringContaining(draftName) } })
      expect(result(notepadResults[1])).toMatchObject({ status: "observed", window: { ref: reused.window?.ref } })
      if (notepadResults[2]?.isError) {
        expect(notepadResults[2].content).toContainEqual(expect.objectContaining({ text: expect.stringContaining("execution=unknown") }))
      } else {
        expect(result(notepadResults[2])).toMatchObject({ status: "verified", evidence: "field_value" })
      }
      const valueReadBack = result(notepadResults[3]).observation?.elements.find(item => item.role.toLowerCase() === "document")?.value
      expect(valueReadBack?.replace(/\r\n?/gu, "\n")).toBe(expectedText)
      expect(launches).toEqual([])
      console.log("Real Notepad: the production provider reused the existing scratch document and independently read back three edited lines.")

      const before = await windows()
      const requested = await queue("notepad-new")
      expect(await settle(requested)).toMatchObject({ status: "completed" })
      const [attempt] = outputs.get("notepad-new") ?? []
      const newRoots = (await windows()).filter(window => window.ownerWindowId === undefined &&
        !before.some(known => known.windowId === window.windowId))
      expect(launches).toEqual([app!.name])
      expect(attempt).toBeDefined()
      if (attempt?.isError) {
        expect(attempt.content).toContainEqual(expect.objectContaining({ text: expect.stringContaining("execution=unknown") }))
        expect(newRoots).toHaveLength(0)
        console.log("Real Notepad: the production activation returned without a separate window. The existing window was never rebound as new.")
      } else {
        const launched = result(attempt)
        expect(launched).toMatchObject({ status: "ready", source: "launched" })
        expect(newRoots).toHaveLength(1)
        expect(launched.window?.title).toBe(newRoots[0]?.title)
        const launchedWindow = newRoots[0]!
        const created = launchedWindow.applicationStartKey
        if (created && (BigInt(created) - 116_444_736_000_000_000n) / 10_000n >= BigInt(startedAfter)) {
          extraNotepadWindow = launchedWindow
        } else {
          console.log("The new window belongs to an existing Notepad process and was left open.")
        }
        console.log("Real Notepad: the production activation opened and bound a distinct new window.")
      }
      return
    }

    await expect.poll(async () => (await provider.discover(fixtureName, AbortSignal.timeout(5_000)))[0]?.name,
      { timeout: 12_000, interval: 500 }).toBe(fixtureName)
    const click = await queue("approve")
    await approve("approve", click.sessionId, 0)
    expect(await settle(click)).toMatchObject({ status: "completed" })
    expect(result(outputs.get("approve")?.[2])).toMatchObject({ status: "observed_change", evidence: "controls_changed" })
    const clicks = events().filter(event => event.kind === "click")
    const ready = events().find(event => event.kind === "ready")
    expect(ready?.target).not.toBe(ready?.control)
    expect(clicks).toMatchObject([{ clicks: 1, hwnd: ready?.target }])
    console.log(`Real Windows Forms: one approved click reached the intended window. Its handler ran ${clicks[0]?.foreground === ready?.target ? "in the foreground" : "without foreground activation"}.`)

    const stop = await queue("stop")
    await approve("stop", stop.sessionId, 1)
    await expect.poll(() => events().some(event => event.kind === "slow-begin"), { timeout: 12_000, interval: 35 }).toBe(true)
    expect(events().some(event => event.kind === "slow-done")).toBe(false)
    desktop.revoke(stop.sessionId, stop.runId)
    await client.sessions.interrupt(stop.sessionId, { expectedRunId: stop.runId, source: "user" })
    expect(await settle(stop)).toMatchObject({ status: "interrupted" })
    await expect.poll(() => events().some(event => event.kind === "slow-done"), { timeout: 4_000 }).toBe(true)
    expect(events().filter(event => event.kind === "click")).toEqual(clicks)
    expect(events().filter(event => /^(?:key|mouse)-(?:up|down)-/u.test(event.kind))).toEqual([])
    expect(pending(stop.sessionId)).toEqual([])
    console.log("Real Windows Forms: chat Stop revoked the active run while the approved delayed handler was running. The next click did not run.")

    const pause = await queue("pause")
    await approve("pause", pause.sessionId, 1)
    await expect.poll(() => events().filter(event => event.kind === "slow-begin").length, { timeout: 12_000, interval: 35 }).toBe(2)
    expect(events().filter(event => event.kind === "slow-done")).toHaveLength(1)
    expect(host.pause(pause.sessionId, pause.runId)).toBe(true)
    expect(await settle(pause)).toMatchObject({ status: "completed" })
    expect(outputs.get("pause")?.[2]).toMatchObject({
      isError: true, content: expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining("execution=unknown") })]),
    })
    await expect.poll(() => events().filter(event => event.kind === "slow-done").length, { timeout: 4_000 }).toBe(2)
    expect(events().filter(event => event.kind === "click")).toEqual(clicks)
    console.log("Real Windows Forms: pausing an in-flight semantic action reported an unknown result while Windows finished the handler.")
  } finally {
    try {
      bridge?.close()
      await server?.close()
      if (extraNotepadWindow) closeNewWindow(extraNotepadWindow, startedAfter)
      if (shortcut) await rm(shortcut, { force: true })
      if (events().some(event => event.kind === "ready")) {
        writeFileSync(join(directory, "close.request"), "")
        await expect.poll(() => events().some(event => event.kind === "closed"), { timeout: 4_000 }).toBe(true)
      }
    } finally {
      vi.unstubAllEnvs()
      if (draftOpened) console.log(`Test draft left in Notepad: ${draftPath}`)
      else await rm(draftDirectory, { recursive: true, force: true })
      try {
        await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
      } catch (error) {
        const { code } = error as NodeJS.ErrnoException
        if (code !== "EPERM" && code !== "EBUSY") throw error
        console.log(`Windows retained a handle to test-only files under ${directory}`)
      }
    }
  }
}, 100_000)
