import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { BrowserWindow, ipcMain } from "electron"
import { VykorApiError, VykorClient } from "@vykor/application-client"
import { DesktopPluginAppService } from "../../src/main/features/plugin-apps/plugin-app-service"
import { createPluginAppsIpcContribution } from "../../src/main/features/plugin-apps/ipc"
import { pluginAppMessageReady } from "../../src/main/features/plugin-apps/message-ready"
import type { PluginAppDocumentStore } from "../../src/main/features/plugin-apps/document-store"
import { attachPluginAppWindowPolicy } from "../../src/main/features/plugin-apps/window-policy"

interface Ready { baseUrl: string; token: string; root: string; sessionId: string; pluginId: string }
/** Functional assertions only: actual installed package, production IPC/Provider, stdio, SQLite and receipts. */
export async function checkExcalidrawApp(root: string, documents: PluginAppDocumentStore, probeUrl: string, probeRequests: () => number) {
  const child = spawn(process.env.VYKOR_UI_TEST_NODE!, [join(__dirname, "../backend/plugin-app-backend.mjs")], {
    cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: { ...process.env, VYKOR_APP_BACKEND: "excalidraw", VYKOR_APP_PAGE_BUNDLE: join(__dirname, "../plugin-app-page.js") },
  })
  let stderr = "", modelCalls: number | undefined
  child.stdout?.resume(); child.stderr?.on("data", data => { stderr += data })
  child.on("message", value => {
    if (value && typeof value === "object" && "modelCalls" in value) modelCalls = Number(value.modelCalls)
    if (value && typeof value === "object" && "setupPhase" in value) console.log(JSON.stringify({ scenario: "excalidraw-backend-timing", ...value }))
  })
  const ready = await new Promise<Ready>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error("Excalidraw backend startup: " + stderr)) }, 90_000)
    child.once("error", reject)
    child.once("exit", code => { clearTimeout(timer); reject(new Error(`Excalidraw backend exited ${code}: ${stderr}`)) })
    child.on("message", value => { if (value && typeof value === "object" && "baseUrl" in value) { clearTimeout(timer); resolve(value as Ready) } })
  })
  const client = new VykorClient({ baseUrl: ready.baseUrl, token: ready.token })
  const traceCalls = process.env.VYKOR_UI_TEST_EXCALIDRAW_TRACE === "1"
  const startedAt = Date.now(), timings: Array<{ method: string; label: string; startedMs: number; durationMs?: number }> = []
  let activeCalls = 0, peakCalls = 0
  async function timed<T>(method: string, label: string, operation: () => Promise<T>): Promise<T> {
    const started = Date.now(), timing = { method, label, startedMs: started - startedAt, durationMs: undefined as number | undefined }
    timings.push(timing); activeCalls++; peakCalls = Math.max(peakCalls, activeCalls)
    try { return await operation() }
    finally {
      timing.durationMs = Date.now() - started; activeCalls--
      if (traceCalls && timing.durationMs >= 750) console.log(JSON.stringify({ scenario: "excalidraw-call-timing", ...timing, activeCalls, peakCalls }))
    }
  }
  const rawPrepare = client.pluginApps.prepare.bind(client.pluginApps), rawReadResource = client.pluginApps.readResource.bind(client.pluginApps)
  const rawInvoke = client.pluginApps.invoke.bind(client.pluginApps), rawGetAction = client.pluginApps.getAction.bind(client.pluginApps)
  client.pluginApps.prepare = (...args) => timed("prepare", args[0].appId, () => rawPrepare(...args))
  client.pluginApps.readResource = (...args) => timed("readResource", args[2], () => rawReadResource(...args))
  client.pluginApps.invoke = (...args) => timed("invoke", `${args[0].toolName}:${args[0].requestId}`, () => rawInvoke(...args))
  client.pluginApps.getAction = (...args) => timed("getAction", args[1], () => rawGetAction(...args))
  const timingSummary = () => ({ elapsedMs: Date.now() - startedAt, activeCalls, peakCalls,
    pending: timings.filter(timing => timing.durationMs === undefined),
    methods: Object.fromEntries(["prepare", "readResource", "invoke", "getAction"].map(method => {
      const calls = timings.filter(timing => timing.method === method), durations = calls.flatMap(timing => timing.durationMs === undefined ? [] : [timing.durationMs])
      return [method, { calls: calls.length, maxMs: durations.length ? Math.max(...durations) : 0 }]
    })) })
  const page = join(root, ".superpowers/sdd/2026-10-20-mcp-apps-resident-panels/electron-build/renderer/tests/plugin-apps-electron/plugin-app-host.html")
  const owner = new BrowserWindow({ show: false, width: 1200, height: 850, webPreferences: {
    preload: join(__dirname, "../preload/index.cjs"), nodeIntegration: false, nodeIntegrationInSubFrames: false,
    contextIsolation: true, sandbox: false, backgroundThrottling: false,
  } })
  const token = {}; let selectedSession = ready.sessionId
  const service = new DesktopPluginAppService({ documents, getClient: async () => client, messageReady: pluginAppMessageReady,
    getOwnerSessionToken: (ownerId, sessionId) => ownerId === owner.webContents.id && sessionId === selectedSession ? token : undefined })
  let resourceReads = 0
  const originalRead = service.readResource.bind(service)
  service.readResource = async (...args) => { resourceReads++; try { return await originalRead(...args) } finally { resourceReads-- } }
  service.registerOwner(owner.webContents, pathToFileURL(page).href)
  attachPluginAppWindowPolicy(owner.webContents, documents)
  const handlers = createPluginAppsIpcContribution(() => service).register({} as never)
  for (const { channel, handler } of handlers) ipcMain.handle(channel, (event, ...args) => handler(event, ...args))
  const evaluate = (js: string) => owner.webContents.executeJavaScript(js)
  const wait = async (predicate: () => Promise<boolean>, description: string) => {
    const deadline = Date.now() + 90_000
    while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 400)) }
    const frames = owner.webContents.mainFrame.frames
    const diagnostics = await Promise.all(frames.filter(frame => frame.url.startsWith("vykor-plugin-app:")).map(frame =>
      frame.executeJavaScript("({body:document.body.innerText.slice(-2000),state:window.__excalidrawPanel?.state()})").catch(() => ({}))))
    console.log(JSON.stringify({ scenario: "excalidraw-timeout-timings", step: description, ...timingSummary() }))
    throw new Error(`Excalidraw deadline: ${description}; ${JSON.stringify(diagnostics)}; ${stderr}`)
  }
  const backendControl = (testIPC: "hold-work" | "release-work") => new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { child.off("message", receive); reject(new Error("Backend control timeout: " + testIPC)) }, 5000)
    const receive = (value: unknown) => {
      if (value && typeof value === "object" && "testIPC" in value && value.testIPC === testIPC) {
        clearTimeout(timer); child.off("message", receive); resolve()
      }
    }
    child.on("message", receive); child.send({ testIPC })
  })
  let passed = false, busyRejections = 0
  try {
    await owner.loadFile(page)
    await wait(async () => evaluate("typeof window.fixtureOpenResult==='function'"), "production Provider ready")
    await client.sessions.admitPrompt(ready.sessionId, { items: [
      { type: "text", text: "创建包含中英文字的测试画板。" },
      { type: "capability", kind: "plugin", pluginId: ready.pluginId, displayName: "Excalidraw" },
    ] })
    await wait(async () => { const state = await client.sessions.getState(ready.sessionId); return state.runs.length > 0 && state.runs.every(run => !["pending", "running"].includes(run.status)) }, "model diagram created")
    const initialState = await client.sessions.getState(ready.sessionId)
    const part = initialState.parts.find(part => part.toolUseId === "model-excalidraw-create")!
    assert.ok(part?.metadata.pluginAppSource, "model result has verified app provenance")
    console.log(JSON.stringify({ scenario: "excalidraw-progress", step: "model-created" }))
    const mountId: string = await evaluate(`window.fixtureOpenResult(${JSON.stringify(ready.sessionId)},${JSON.stringify(part.id)})`)
    await wait(async () => owner.webContents.mainFrame.frames.some(frame => frame.url.startsWith("vykor-plugin-app:")), "opaque document loaded")
    const frame = owner.webContents.mainFrame.frames.find(frame => frame.url.startsWith("vykor-plugin-app:"))!
    const appEvaluate = (js: string) => frame.executeJavaScript(js)
    await wait(async () => appEvaluate("window.__excalidrawPanel?.state().document?.id==='electron-diagram' && !!window.__excalidrawPanel.api"), "real Excalidraw scene loaded")
    await evaluate("window.fixtureSavedWindow=document.querySelector('iframe').contentWindow;window.excalidrawConfirmations=0;new MutationObserver(()=>{const showing=!!document.querySelector('[role=alertdialog]');if(showing&&!window.excalidrawDialogVisible)window.excalidrawConfirmations++;window.excalidrawDialogVisible=showing}).observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['role']});void 0")
    await appEvaluate("window.excalidrawDocumentToken='original-document';void 0")
    const app = (await client.pluginApps.list(ready.sessionId)).apps.find(item => item.app.pluginId === ready.pluginId)!
    assert.ok(app)
    const savedActions = async () => (await client.sessions.getState(ready.sessionId)).runs
      .filter(run => run.status === "completed" && (run.metadata.pluginAppAction as { toolName?: string } | undefined)?.toolName === "commit_scene")
      .map(run => run.metadata.pluginAppAction as { executionState: string; args: { expectedRevision: number; scene: { elements: Array<{ id: string; x: number }> } } })
    const savedX = async () => (await savedActions()).sort((left, right) => right.args.expectedRevision - left.args.expectedRevision)[0]?.args.scene.elements.find(element => element.id === "stable-shape")?.x
    const edit = (x: number) => appEvaluate(`(()=>{const api=window.__excalidrawPanel.api;api.updateScene({elements:api.getSceneElements().map(el=>el.id==='stable-shape'?{...el,x:${x},version:el.version+1,versionNonce:el.versionNonce+1,updated:Date.now()}:el),captureUpdate:'IMMEDIATELY'});return true})()`)
    const waitSaved = (x: number) => wait(async () => {
      const state = await appEvaluate("(()=>{const state=window.__excalidrawPanel.state();return {dirty:state.dirty,saving:state.saving,error:state.error,revision:state.document?.revision,x:state.document?.scene.elements.find(el=>el.id==='stable-shape')?.x}})()")
      if (state.dirty || state.saving || state.error || state.x !== x) return false
      return (await savedActions()).some(action => action.executionState === "completed" && action.args.expectedRevision + 1 === state.revision
        && action.args.scene.elements.find(element => element.id === "stable-shape")?.x === x)
    }, `ACK saved x=${x}`)
    const initialDoc = await appEvaluate("window.__excalidrawPanel.state().document")
    assert.ok(initialDoc.scene.elements.some((element: { text?: string }) => element.text === "English 与中文"))
    const networkBefore = probeRequests()
    assert.equal(await appEvaluate(`fetch(${JSON.stringify(probeUrl)}).then(()=>false,()=>true)`), true)
    assert.equal(probeRequests(), networkBefore)
    await wait(async () => appEvaluate("[...window.__excalidrawFontSources].some(([font,source])=>font.status==='loaded'&&source.includes('data:'))"), "offline data fonts loaded")
    const fonts = await appEvaluate("[...window.__excalidrawFontSources].filter(([font])=>font.status==='loaded').map(([font,source])=>({family:font.family,data:source.includes('data:')}))")
    assert.ok(fonts.length > 0); assert.ok(fonts.every((font: { data: boolean }) => font.data))
    await edit(140); await waitSaved(140)
    assert.equal(await evaluate("window.excalidrawConfirmations"), 0, "autosave never opens a host confirmation")
    const afterSave = await client.sessions.getState(ready.sessionId)
    const saveRuns = afterSave.runs.filter(run => (run.metadata.pluginAppAction as { toolName?: string } | undefined)?.toolName === "commit_scene")
    // Excalidraw can normalize restored bound labels before a user edit. Every resulting
    // scene change must settle its own original receipt, rather than assuming one render.
    assert.ok(saveRuns.length >= 1)
    for (const run of saveRuns) {
      assert.equal((run.metadata.pluginAppAction as { executionState: string }).executionState, "completed")
      assert.equal(run.status, "completed", "saved indicator follows durable original Run ACK")
      assert.equal(run.sessionId, ready.sessionId)
    }
    console.log(JSON.stringify({ scenario: "excalidraw-progress", step: "model-create-autosave-fonts", fonts, normalizedSceneSaves: saveRuns.length }))
    await appEvaluate("document.querySelector('.document-menu summary').click();Array.from(document.querySelectorAll('.document-menu button')).find(button=>/重命名|Rename/.test(button.textContent)).click();void 0")
    await wait(async () => appEvaluate("!!document.querySelector('#rename-input')"), "rename dialog")
    await appEvaluate("(()=>{const input=document.querySelector('#rename-input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'Electron 重命名图');input.dispatchEvent(new Event('input',{bubbles:true}));return new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))})()")
    await appEvaluate("document.querySelector('#rename-input').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));void 0")
    await wait(async () => appEvaluate("!document.querySelector('#rename-input') && window.__excalidrawPanel.state().document.title==='Electron 重命名图'"), "Enter rename acknowledged")
    await waitSaved(140)
    assert.equal(await evaluate("window.excalidrawConfirmations"), 0, "rename uses the approved own-data save")
    const referencedRevision = await appEvaluate("window.__excalidrawPanel.state().document.revision")
    await appEvaluate("window.__excalidrawPanel.api.updateScene({appState:{selectedElementIds:{'stable-shape':true}},captureUpdate:'NEVER'});document.querySelector('.document-menu summary').click();document.querySelector('#reference-selection').click();void 0")
    await wait(async () => evaluate("window.fixtureContextIds().length===1"), "explicit selected-shape context")
    const contextIds = await evaluate("window.fixtureContextIds()")

    await evaluate("window.fixtureVisible(false)")
    await wait(async () => evaluate("document.querySelector('[data-plugin-app-mount]').style.visibility==='hidden'"), "host hidden")
    await edit(220)
    await wait(async () => appEvaluate("window.__excalidrawPanel.state().dirty && !!window.__excalidrawPanel.state().error"), "hidden draft retained")
    assert.equal(await savedX(), 140)
    await evaluate("window.fixtureVisible(true)"); await waitSaved(220)
    selectedSession = "other-session"
    await evaluate("window.fixtureSelect('other-session')")
    await wait(async () => evaluate("document.querySelector('[data-plugin-app-mount]').style.visibility==='hidden'"), "session switch hides original frame")
    await edit(300)
    await wait(async () => appEvaluate("window.__excalidrawPanel.state().dirty && !!window.__excalidrawPanel.state().error"), "switched session draft retained")
    assert.equal(await savedX(), 220)
    selectedSession = ready.sessionId
    await evaluate(`window.fixtureSelect(${JSON.stringify(ready.sessionId)})`); await waitSaved(300)
    assert.equal(await evaluate("window.fixtureSavedWindow===document.querySelector('iframe').contentWindow"), true)
    assert.equal(await appEvaluate("window.excalidrawDocumentToken"), "original-document")

    const originalInvoke = client.pluginApps.invoke.bind(client.pluginApps)
    client.pluginApps.invoke = async (...args) => {
      try { return await originalInvoke(...args) }
      catch (error) { if (error instanceof VykorApiError && (error.body as { reason?: string })?.reason === "busy") busyRejections++; throw error }
    }
    await backendControl("hold-work")
    const runsBeforeBusy = (await client.sessions.getState(ready.sessionId)).runs.length
    await edit(380)
    await wait(async () => busyRejections > 0 && await appEvaluate("window.__excalidrawPanel.state().dirty && window.__excalidrawPanel.state().error?.includes('plugin_app_busy')"), "real unaccepted busy draft")
    assert.equal((await client.sessions.getState(ready.sessionId)).runs.length, runsBeforeBusy, "busy rejection creates no operation Run")
    assert.equal(await savedX(), 300)
    await backendControl("release-work"); await waitSaved(380)
    client.pluginApps.invoke = originalInvoke
    assert.equal(await evaluate("window.excalidrawConfirmations"), 0)
    console.log(JSON.stringify({ scenario: "excalidraw-progress", step: "hidden-session-busy-recovery", busyRejections, sameFrame: true }))

    for (const format of ["excalidraw", "png", "svg"]) {
      const file = join(ready.root, `electron-output.${format}`)
      await appEvaluate("document.querySelector('#open-export').click()")
      await wait(async () => appEvaluate("!!document.querySelector('#export-path')"), "export dialog")
      await appEvaluate(`(()=>{const select=document.querySelector('#export-format');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,${JSON.stringify(format)});select.dispatchEvent(new Event('change',{bubbles:true}));const input=document.querySelector('#export-path');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(`electron-output.${format}`)});input.dispatchEvent(new Event('input',{bubbles:true}));return true})()`)
      await appEvaluate("document.querySelector('#export-button').click()")
      const tool = format === "excalidraw" ? "export_diagram" : "save_image"
      await wait(async () => evaluate(`!!document.querySelector('[role=alertdialog]')?.textContent.includes(${JSON.stringify(tool)})`), `${format} host confirmation`)
      assert.equal(existsSync(file), false, "export writes only after host confirmation")
      await evaluate("Array.from(document.querySelectorAll('button')).find(button=>button.textContent==='执行').click()")
      await wait(async () => existsSync(file) && await appEvaluate("!document.querySelector('#export-path')"), `${format} workspace file written`)
      const bytes = readFileSync(file)
      if (format === "excalidraw") { const output = JSON.parse(bytes.toString()); assert.equal(output.type, "excalidraw"); assert.ok(output.elements.some((element: { id: string; x: number }) => element.id === "stable-shape" && element.x === 380)) }
      else if (format === "png") assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a")
      else { const svg = bytes.toString(); assert.ok(svg.includes("<svg")); assert.ok(svg.includes("data:"), "SVG embeds offline font bytes") }
    }
    assert.equal(await evaluate("window.excalidrawConfirmations"), 3)
    const contexts = await service.composerContext(owner.webContents.id, ready.sessionId, contextIds)
    assert.equal(contexts.length, 1)
    assert.equal(contexts[0]!.expectedRevision, service.getBinding(owner.webContents.id, mountId).response.app.controlRevision,
      "host credential is current after automatic saves and exports")
    assert.equal((contexts[0]!.data as { documentId: string }).documentId, "electron-diagram")
    assert.equal((contexts[0]!.data as { revision: number }).revision, referencedRevision, "selection keeps its fixed business revision")
    assert.deepEqual([...(contexts[0]!.data as { elementIds: string[] }).elementIds].sort(), ["stable-shape", "stable-shape-label"],
      "Excalidraw keeps the selected shape and its bound label fixed across later saves")
    const completed = await client.sessions.getState(ready.sessionId)
    assert.ok(completed.runs.every(run => run.status === "completed"))
    const invocations = timings.filter(timing => timing.method === "invoke")
    assert.equal(new Set(invocations.map(invocation => invocation.label)).size, invocations.length,
      "the original invoke is never replayed; rejected busy retries receive a fresh Main request")
    assert.equal(probeRequests(), networkBefore)
    console.log(JSON.stringify({ scenario: "real-excalidraw-app", modelDiagram: true, automaticSave: true, originalRunAck: true,
      hiddenDraftRecovery: true, sessionDraftRecovery: true, busyNoAdmission: true, busyRejections, sameContentWindow: true,
      offlineFonts: fonts.length, enterRename: true, exportsConfirmed: 3, fixedSelectionCurrentCredential: true, formats: ["excalidraw", "png", "svg"], cspRequests: 0, originalMountId: mountId }))
    console.log(JSON.stringify({ scenario: "excalidraw-call-summary", ...timingSummary() }))
    passed = true
  } finally {
    // Drain already-issued asset/heartbeat reads while their original frame authority is live.
    const drainDeadline = Date.now() + 5000
    while (resourceReads > 0 && Date.now() < drainDeadline) await new Promise(resolve => setTimeout(resolve, 40))
    if (!owner.isDestroyed()) owner.destroy()
    service.dispose()
    for (const { channel } of handlers) ipcMain.removeHandler(channel)
    if (child.connected) child.send("close")
    await new Promise<void>(resolve => { const timer = setTimeout(() => { child.kill(); resolve() }, 5000); child.once("exit", () => { clearTimeout(timer); resolve() }) })
    if (passed) assert.equal(modelCalls, 2, "only original model create tool and final response")
  }
}
