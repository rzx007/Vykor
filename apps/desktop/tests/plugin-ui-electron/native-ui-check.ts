import { BrowserWindow, ipcMain } from "electron"
import { spawn } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import assert from "node:assert/strict"
import { VykorClient } from "@vykor/client"
import { DesktopPluginUiService } from "../../src/main/features/plugin-ui/plugin-ui-service"
import { createPluginUiIpcContribution } from "../../src/main/features/plugin-ui/ipc"
import { SessionSubscriptionService } from "../../src/main/features/session/session-subscription-service"
import type { PluginUiDocumentStore } from "../../src/main/features/plugin-ui/document-store"
import { IpcEvents } from "../../src/shared/ipc-channels"
import { attachPluginUiWindowPolicy } from "../../src/main/features/plugin-ui/window-policy"
import { checkReferenceUi } from "./reference-ui-check"

export async function checkNativeUi(
  owner: BrowserWindow,
  store: PluginUiDocumentStore,
  root: string,
  reference = false
) {
  const child = spawn(
    process.env.VYKOR_UI_TEST_NODE!,
    [
      "--import",
      pathToFileURL(join(root, "apps/cli/node_modules/tsx/dist/loader.mjs")).href,
      join(root, "packages/server/test-helpers/native-ui-electron.mts"),
    ],
    {
      cwd: root,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: { ...process.env, VYKOR_UI_TEST_REFERENCE: reference ? "1" : "0" },
    }
  )
  let stderr = ""
  let stage = "module loading"
  child.stderr?.on("data", (data) => {
    stderr += data
  })
  const ready = await new Promise<{
    baseUrl: string
    token: string
    root: string
    sessionId: string
    instanceId: string
  }>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill()
      reject(new Error("Native backend startup timeout at " + stage + ": " + stderr))
    }, 45000)
    child.once("error", reject)
    child.once("exit", (code) => {
      clearTimeout(timeout)
      reject(new Error("Native backend exited: " + code + " " + stderr))
    })
    child.on("message", (message: any) => {
      if (message.stage) stage = message.stage
      if (message.baseUrl) {
        clearTimeout(timeout)
        resolve(message)
      }
    })
  })
  const client = new VykorClient({ baseUrl: ready.baseUrl, token: ready.token })
  const second = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      contextIsolation: true,
      sandbox: false,
      backgroundThrottling: false,
    },
  })
  attachPluginUiWindowPolicy(second.webContents, store)
  const subscriptions = new SessionSubscriptionService({ sessionUpdateIntervalMs: 10 })
  const service = new DesktopPluginUiService({
    documents: store,
    getClient: async () => client,
    getOwnerSessionId: (id) => subscriptions.getOwnerSessionId(id),
    localAvailable: () => true,
  })
  subscriptions.onOwnerSnapshot((id, view) => service.observeSession(id, view))
  subscriptions.onOwnerInvalidated((id) => service.invalidateOwner(id))
  const page = join(
    root,
    ".superpowers/sdd/2026-10-03-native-plugin-ui-a3/electron-build/renderer/tests/plugin-ui-electron/ui-host.html"
  )
  const handlers = createPluginUiIpcContribution(() => service).register({} as never)
  let pendingIpc = 0
  for (const { channel, handler } of handlers)
    ipcMain.handle(channel, async (event, ...args) => {
      pendingIpc++
      try {
        return await handler(event, ...args)
      } finally {
        pendingIpc--
      }
    })
  const effects = () =>
    existsSync(join(ready.root, "effects"))
      ? Number(readFileSync(join(ready.root, "effects"), "utf8"))
      : 0
  const evaluate = (window: BrowserWindow, source: string) =>
    window.webContents.executeJavaScript(source)
  const wait = async (predicate: () => Promise<boolean>) => {
    const until = Date.now() + 8000
    while (Date.now() < until) {
      if (await predicate()) return
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    throw new Error("Native UI assertion deadline")
  }
  const click = (window: BrowserWindow, label: string) =>
    evaluate(
      window,
      "Array.from(document.querySelectorAll('button')).find(b=>b.textContent===" +
        JSON.stringify(label) +
        ").click()"
    )
  const confirmVisible = (window: BrowserWindow) =>
    evaluate(window, "document.querySelector('[role=alertdialog]')!==null")
  const request = async (window: BrowserWindow) => {
    await wait(async () => {
      const frame = window.webContents.mainFrame.frames[0]
      return (
        !!frame &&
        (await frame.executeJavaScript(
          "document.querySelector('#status')!==null&&document.querySelector('#status').textContent!=='waiting'"
        ))
      )
    })
    const frame = window.webContents.mainFrame.frames[0]!
    await frame.executeJavaScript("document.querySelector('#apply').click()")
    await wait(() => confirmVisible(window))
  }
  try {
    const baseline = await client.sessions.getState(ready.sessionId)
    for (const window of reference ? [owner] : [owner, second]) {
      service.registerOwner(window.webContents, pathToFileURL(page).href)
      await window.loadFile(page)
      const snapshot = await subscriptions.openSession(client, window.webContents, ready.sessionId)
      window.webContents.send(IpcEvents.sessionUpdated, snapshot)
      await wait(() =>
        evaluate(
          window,
          "document.body.textContent.includes(" +
            JSON.stringify(reference ? "example.text-inspector" : "test.ui-electron") +
            ")&&document.body.textContent.includes('打开交互')"
        )
      )
      await click(window, "打开交互")
      await wait(() => evaluate(window, "document.querySelector('iframe')!==null"))
    }
    if (reference) {
      await checkReferenceUi(owner, client, ready, baseline.attempts.length, root)
      console.log(JSON.stringify({ stage: "reference interactions passed" }))
      await wait(async () => pendingIpc === 0)
    } else {
      await request(owner)
      assert.equal(effects(), 0)
      const author = owner.webContents.mainFrame.frames[0]!
      await author.executeJavaScript(
        "for(const [id,method,extra] of [['attack1','Execute',{}],['attack2','getSnapshot',{html:'x'}],['attack3','getSnapshot',{mountId:'40000000-0000-4000-8000-000000000001'}]])" +
          "testPort.postMessage(JSON.stringify({version:1,mountId:testMount,id,method,params:{},...extra}));"
      )
      await wait(() => author.executeJavaScript("window.testReplies.length===3"))
      assert.deepEqual(await author.executeJavaScript("window.testReplies.map(r=>r.error.code)"), [
        "plugin_ui_method_not_supported",
        "plugin_ui_invalid_message",
        "plugin_ui_mount_closed",
      ])
      assert.equal(effects(), 0)
      await click(owner, "返回")
      await wait(() =>
        owner.webContents.mainFrame.frames[0]!.executeJavaScript(
          "document.querySelector('#result')?.textContent==='plugin_ui_user_cancelled'"
        )
      )
      assert.equal(effects(), 0)
      await request(owner)
      await request(second)
      assert.equal(effects(), 0)
      await click(owner, "确认执行")
      await wait(async () => effects() === 1)
      await wait(() =>
        second.webContents.mainFrame.frames[0]!.executeJavaScript(
          "document.querySelector('#status')?.textContent==='0'"
        )
      )
      await click(second, "确认执行")
      await wait(() =>
        second.webContents.mainFrame.frames[0]!.executeJavaScript(
          "document.querySelector('#result')?.textContent?.startsWith('plugin_ui_')"
        )
      )
      assert.equal(effects(), 1, "two old-revision confirmations must invoke Native once")
      const persisted = await client.sessions.getState(ready.sessionId)
      assert.equal(persisted.inputs.length, 1)
      assert.equal(persisted.runs.filter((run) => run.metadata.uiAction).length, 1)
      assert.equal(
        persisted.attempts.length,
        baseline.attempts.length,
        "UI must not add model attempts"
      )
      await click(owner, "关闭显示")
      assert.equal(effects(), 1)
      await click(owner, "打开交互")
      await request(owner)
      await wait(async () => pendingIpc === 0)
      await client.plugins.disable("test.ui-electron", { cwd: ready.root })
      await wait(() =>
        evaluate(
          owner,
          "document.querySelector('iframe')===null&&document.querySelector('[role=alertdialog]')===null"
        )
      )
      await wait(() => evaluate(second, "document.querySelector('iframe')===null"))
      assert.equal(effects(), 1, "revoked confirmation must not invoke Native")
      assert.equal(
        (await client.pluginUi.get(ready.sessionId, ready.instanceId)).availability.canRender,
        false
      )
      assert.equal(
        await evaluate(owner, "document.body.textContent.includes('原始结果，不应消失')"),
        true
      )
      await wait(async () => pendingIpc === 0)
    }
  } finally {
    owner.hide()
    if (owner.webContents.debugger.isAttached()) owner.webContents.debugger.detach()
    if (reference) console.log(JSON.stringify({ stage: "reference page cleanup" }))
    // Dispose React frames while IPC handlers still exist, including failed assertions.
    await owner.loadURL("about:blank")
    if (reference) console.log(JSON.stringify({ stage: "reference page unloaded" }))
    await wait(async () => pendingIpc === 0)
    subscriptions.clearAll()
    service.dispose()
    second.destroy()
    for (const { channel } of handlers) ipcMain.removeHandler(channel)
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()))
    if (child.connected) child.send("close")
    if (reference) console.log(JSON.stringify({ stage: "reference backend closing" }))
    const rescue = setTimeout(() => child.kill(), 5000)
    await exited
    clearTimeout(rescue)
  }
  assert.equal(stderr.includes(ready.token), false)
  assert.equal(stderr.includes("<script>"), false)
  if (reference) {
    assert.equal(stderr.includes("ok  "), false)
    assert.equal(stderr.includes("1:trailing-whitespace"), false)
    assert.equal(stderr.includes(join(ready.root, "config/plugins/cache")), false)
  }
  const audits = stderr
    .split(/\r?\n/)
    .filter((line) => line.startsWith("[native-tool:audit] "))
    .map((line) => JSON.parse(line.slice(20)))
  assert.equal(audits.length, 2)
  assert.deepEqual(
    audits.map((event) => event.toolName),
    reference ? ["TextInspectorCheck", "TextInspectorPreview"] : ["NativeInspect", "NativeAction"]
  )
  for (const event of audits) {
    assert.deepEqual(
      Object.keys(event).sort(),
      [
        "cwd",
        "durationMs",
        "inputSummary",
        "pluginId",
        "sessionId",
        "status",
        "toolName",
        "type",
      ].sort()
    )
    assert.equal(event.pluginId, reference ? "example.text-inspector" : "test.ui-electron")
    assert.equal(event.cwd, ready.root)
    assert.equal(event.sessionId, ready.sessionId)
    assert.equal(event.status, "completed")
    assert.equal(typeof event.durationMs, "number")
    assert.equal(
      event.inputSummary,
      reference
        ? event.toolName === "TextInspectorCheck"
          ? "{text:string(11)}"
          : "{selected:array(1),text:string(11)}"
        : event.toolName === "NativeInspect"
          ? "{}"
          : "{value:string(25)}"
    )
  }
  const unexpected = stderr
    .split(/\r?\n/)
    .filter(
      (line) =>
        line.trim() &&
        !line.startsWith("[native-tool:audit] ") &&
        !/^\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature and might change at any time$/.test(
          line
        ) &&
        !/^\(Use .node --trace-warnings \.\.\.. to show where the warning was created\)$/.test(
          line
        ) &&
        !/^\(node:\d+\) \[DEP0040\] DeprecationWarning: The .punycode. module is deprecated\. Please use a userland alternative instead\.$/.test(
          line
        ) &&
        !/^\(Use .node --trace-deprecation \.\.\.. to show where the warning was created\)$/.test(
          line
        )
    )
  assert.deepEqual(unexpected, [])
  return reference
    ? {
        officialReferencePlugin: true,
        keyboardCancelAndConfirm: true,
        samplePreviewNoFileWrites: true,
      }
    : {
        nativeExecutions: effects(),
        realSqlite: true,
        dualWindowRevisionConflict: true,
        revokedConfirmation: true,
      }
}
