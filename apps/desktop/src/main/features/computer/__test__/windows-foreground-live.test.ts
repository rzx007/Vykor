import { execFileSync, spawn } from "node:child_process"
import { once } from "node:events"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"
import type { WindowsAppWindow } from "../windows-apps"
import { createWindowsForeground, type WindowsForegroundLease } from "../windows-foreground"
import { windowsSemanticQuery } from "../windows-semantic-query"
import { windowsWindowQuery } from "../windows-window-query"

type Evidence = {
  kind: string; pid?: number; target?: number; control?: number; window?: string;
  hwnd?: number; foreground?: number; buttonX?: number; buttonY?: number
}

it.runIf(process.env.VYKOR_WINDOWS_FOREGROUND_LIVE === "1" && process.platform === "win32" && process.arch === "x64")(
  "captures the exact WinForms window and releases input on focus change, takeover, and Stop", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vykor-foreground-native-"))
    const fixtureExe = join(dir, "Fixture.exe")
    const logfile = join(dir, "fixture.jsonl")
    const root = process.env.SystemRoot ?? "C:\\Windows"
    const source = fileURLToPath(new URL("../../../../../tests/computer-windows/fixtures/Fixture.cs", import.meta.url))
    const events = (): Evidence[] => existsSync(logfile) ? readFileSync(logfile, "utf8").split(/\r?\n/u).slice(0, -1).map(line => JSON.parse(line)) : []
    const signal = AbortSignal.timeout(50_000)
    execFileSync(join(root, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"), [
      "/nologo", "/target:winexe", "/platform:x64", "/r:System.Drawing.dll", "/r:System.Windows.Forms.dll",
      "/r:System.Web.Extensions.dll", `/out:${fixtureExe}`, source,
    ], { windowsHide: true, timeout: 8_000 })
    const fixture = spawn(fixtureExe, [logfile, dir.slice(-6)], { stdio: "ignore" })
    const exited = once(fixture, "exit")
    const foreground = createWindowsForeground()
    let lease: WindowsForegroundLease | undefined
    try {
      await expect.poll(() => events().find(row => row.kind === "ready"), { timeout: 5_000 }).toBeDefined()
      const ready = events().find(row => row.kind === "ready")!
      expect(ready.pid).toBe(fixture.pid)
      const raw = execFileSync(join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), [
        "-NoProfile", "-NonInteractive", "-Command",
        "$ErrorActionPreference='Stop'; Add-Type -TypeDefinition $env:VYKOR_TEST_WINDOW_CODE; ConvertTo-Json -InputObject ([VykorWindowsWindowQuery]::Scan('', $env:VYKOR_TEST_WINDOW_PATH, '', $false)).windows -Compress",
      ], { windowsHide: true, encoding: "utf8", timeout: 8_000,
        env: { ...process.env, VYKOR_TEST_WINDOW_CODE: windowsWindowQuery, VYKOR_TEST_WINDOW_PATH: fixtureExe } })
      const windows = ([] as WindowsAppWindow[]).concat(JSON.parse(raw))
      const target = windows.find(item => item.windowId === ready.target && item.pid === fixture.pid)!
      const control = windows.find(item => item.windowId === ready.control && item.pid === fixture.pid)!
      expect(target?.title).toBe(control?.title)
      expect(target?.windowId).not.toBe(control?.windowId)
      writeFileSync(join(dir, "focus.request"), "target")
      await expect.poll(() => events().find(row => row.kind === "activate" && row.window === "target" && row.foreground === ready.target), { timeout: 5_000 }).toBeDefined()

      const reasons: string[] = []
      lease = await foreground.enter(target, reason => reasons.push(reason), signal)
      const focusIdentity = async (window: WindowsAppWindow) => {
        const current = (await foreground.capture(window, signal)).focusIdentity
        expect(current).toBeTruthy()
        return current
      }
      const frame = await foreground.capture(target, signal)
      expect(Buffer.from(frame.data, "base64").subarray(1, 4).toString()).toBe("PNG")
      expect(frame.width).toBeLessThanOrEqual(frame.geometry.width)
      const x = Math.round((ready.buttonX! - frame.geometry.left) * frame.width / frame.geometry.width)
      const y = Math.round((ready.buttonY! - frame.geometry.top) * frame.height / frame.geometry.height)
      const click = await lease.perform({ type: "click", x, y }, frame, signal)
      expect({ click, reasons, events: events().filter(row => ["click", "mouse-down-Left", "mouse-up-Left"].includes(row.kind)) })
        .toMatchObject({ click: { state: "sent", released: true }, reasons: [] })
      writeFileSync(join(dir, "focus.request"), "target-button")
      await expect.poll(() => events().find(row => row.kind === "focus-button")).toBeDefined()
      const previousFocus = await focusIdentity(target)
      writeFileSync(join(dir, "focus.request"), "target-editor")
      await expect.poll(() => events().find(row => row.kind === "focus-editor")).toBeDefined()
      const firstFocus = await focusIdentity(target)
      expect(firstFocus).not.toBe(previousFocus)
      expect(await lease.perform({ type: "key", key: "F6", focusIdentity: previousFocus }, undefined, signal)).toEqual({ state: "refused", released: true })
      expect(events().filter(row => row.kind === "key-down-F6")).toEqual([])
      expect(await lease.perform({ type: "key", key: "F8", focusIdentity: firstFocus }, undefined, signal)).toEqual({ state: "sent", released: true })
      await expect.poll(() => events().filter(row => row.kind === "key-up-F8"), { timeout: 3_000 }).toHaveLength(1)
      for (const kind of ["click", "mouse-down-Left", "mouse-up-Left", "key-down-F8", "key-up-F8"]) {
        expect(events().filter(row => row.kind === kind)).toEqual([expect.objectContaining({ window: "target", hwnd: target.windowId })])
      }
      const evidence = events().filter(row => row.kind.includes("-down-") || row.kind.includes("-up-")).length
      writeFileSync(join(dir, "focus.request"), "control")
      await expect.poll(() => reasons, { timeout: 3_000 }).toEqual(["focus_lost"])
      expect(await lease.perform({ type: "key", key: "F8", focusIdentity: firstFocus }, undefined, signal)).toEqual({ state: "refused", released: true })
      expect(await lease.release()).toEqual({ released: true, exited: true })
      expect(events().filter(row => row.kind.includes("-down-") || row.kind.includes("-up-")).length).toBe(evidence)

      lease = await foreground.enter(control, reason => reasons.push(reason), signal)
      writeFileSync(join(dir, "external.request"), "control")
      await expect.poll(() => reasons, { timeout: 3_000 }).toEqual(["focus_lost", "physical_input"])
      expect(await lease.release()).toEqual({ released: true, exited: true })
      await expect.poll(() => events().filter(row => row.kind === "key-up-F9"), { timeout: 3_000 }).toEqual([expect.objectContaining({ window: "control" })])

      lease = await foreground.enter(control, reason => reasons.push(reason), signal)
      writeFileSync(join(dir, "external.request"), "control-esc")
      await expect.poll(() => reasons.at(-1), { timeout: 3_000 }).toBe("emergency_stop")
      expect(await lease.release()).toEqual({ released: true, exited: true })
      expect(events().filter(row => row.kind === "key-down-Escape")).toHaveLength(0)

      lease = await foreground.enter(control, reason => reasons.push(reason), signal)
      const controlFocus = await focusIdentity(control)
      expect(await lease.perform({ type: "key", key: "Tab", focusIdentity: controlFocus }, undefined, signal)).toEqual({ state: "sent", released: true })
      expect(await lease.release()).toEqual({ released: true, exited: true })
      expect(await lease.perform({ type: "key", key: "F8", focusIdentity: controlFocus }, undefined, signal)).toEqual({ state: "refused", released: true })
      await expect.poll(() => events().filter(row => row.kind === "key-up-Tab"), { timeout: 3_000 }).toEqual([expect.objectContaining({ window: "control" })])
      expect(events().filter(row => row.kind === "key-down-Tab")).toHaveLength(1)
      expect(events().filter(row => row.kind === "key-down-F8")).toHaveLength(1)

      const beforeFailure = events().filter(row => row.kind.includes("-down-"))
      const failed = createWindowsForeground({ fault: "lost-keyboard" })
      lease = await failed.enter(control, reason => reasons.push(reason), signal)
      expect(await lease.perform({ type: "key", key: "F7", focusIdentity: await focusIdentity(control) }, undefined, signal)).toEqual({ state: "refused", released: true })
      await expect.poll(() => reasons.at(-1)).toBe("driver_lost")
      expect(await lease.release()).toEqual({ released: true, exited: true })
      expect(events().filter(row => row.kind.includes("-down-"))).toEqual(beforeFailure)

      const waiting = Promise.withResolvers<void>()
      const startup = new AbortController()
      const activations = events().filter(row => row.kind === "activate")
      const pending = createWindowsForeground({ fault: "hold-activate", onPrepared: waiting.resolve })
        .enter(target, () => {}, AbortSignal.any([signal, startup.signal]))
      await waiting.promise
      startup.abort()
      await expect(pending).rejects.toMatchObject({ name: "AbortError" })
      expect(events().filter(row => row.kind === "activate")).toEqual(activations)

      const keyDown = Promise.withResolvers<boolean>()
      lease = await createWindowsForeground({ fault: "hold-release", onHeld: keyDown.resolve })
        .enter(control, reason => reasons.push(reason), signal)
      const key = lease.perform({ type: "key", key: "F7", focusIdentity: await focusIdentity(control) }, undefined, signal)
      expect(await keyDown.promise).toBe(false)
      await expect.poll(() => events().filter(row => row.kind === "key-down-F7"), { timeout: 3_000, interval: 20 }).toHaveLength(1)
      expect(events().filter(row => row.kind === "key-up-F7")).toHaveLength(0)
      expect(await lease.release()).toEqual({ released: true, exited: true })
      expect((await key).released).toBe(true)
      await expect.poll(() => events().filter(row => row.kind === "key-up-F7"), { timeout: 3_000 })
        .toEqual([expect.objectContaining({ window: "control", hwnd: control.windowId })])

      const targetActivations = () => events().filter(row => row.kind === "activate" && row.window === "target" && row.foreground === ready.target)
      const previousActivations = targetActivations().length
      writeFileSync(join(dir, "focus.request"), "target")
      await expect.poll(targetActivations, { timeout: 3_000 }).toHaveLength(previousActivations + 1)
      const mouseDown = Promise.withResolvers<boolean>()
      lease = await createWindowsForeground({ fault: "hold-release", onHeld: mouseDown.resolve })
        .enter(target, reason => reasons.push(reason), signal)
      const mouseFrame = await foreground.capture(target, signal)
      const mouse = lease.perform({ type: "click", x, y }, mouseFrame, signal)
      expect(await mouseDown.promise).toBe(false)
      await expect.poll(() => events().filter(row => row.kind === "mouse-down-Left"), { timeout: 3_000, interval: 20 }).toHaveLength(2)
      expect(events().filter(row => row.kind === "mouse-up-Left")).toHaveLength(1)
      expect(await lease.release()).toEqual({ released: true, exited: true })
      expect((await mouse).released).toBe(true)
      await expect.poll(() => events().filter(row => row.kind === "mouse-up-Left"), { timeout: 3_000 })
        .toEqual([expect.objectContaining({ hwnd: target.windowId }), expect.objectContaining({ hwnd: target.windowId })])

      writeFileSync(join(dir, "auth.request"), "")
      await expect.poll(() => events().find(row => row.kind === "authentication")).toBeDefined()
      await expect(foreground.capture(target, signal)).rejects.toThrow()
      const source = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes,WindowsBase
$refs = @([System.Windows.Automation.AutomationElement].Assembly.Location,
  [System.Windows.Automation.AutomationElementIdentifiers].Assembly.Location, [System.Windows.Point].Assembly.Location)
Add-Type -ReferencedAssemblies $refs -TypeDefinition $env:VYKOR_TEST_SEMANTIC
$q = $env:VYKOR_TEST_WINDOW_IDENTITY | ConvertFrom-Json
foreach ($action in "observe", "invoke") {
  [VykorWindowsSemanticQuery]::Run($q.windowId, 0, $q.pid, $q.threadId, $q.sessionId, $q.processStartKey,
    $q.applicationPid, $q.applicationStartKey, $action, "", "Button", "Increment once", "", "", 1, "", "", $q.title)
}
[VykorWindowsSemanticQuery]::Run($q.windowId, $q.windowId, $q.pid, $q.threadId, $q.sessionId, $q.processStartKey,
  $q.applicationPid, $q.applicationStartKey, "observe", "", "", "", "", "", 1, "", "", $q.title)
`
      const gated = execFileSync(join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
        ["-NoProfile", "-NonInteractive", "-Command", source], {
          windowsHide: true, encoding: "utf8", timeout: 8_000,
          env: { ...process.env, VYKOR_TEST_SEMANTIC: windowsSemanticQuery, VYKOR_TEST_WINDOW_IDENTITY: JSON.stringify(target) },
        })
      expect(gated.trim().split(/\r?\n/u)).toEqual(["handoff", "handoff", "refused"])
    } finally {
      await lease?.release()
      writeFileSync(join(dir, "close.request"), "")
      await exited
      await rm(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 })
    }
  }, 60_000,
)
