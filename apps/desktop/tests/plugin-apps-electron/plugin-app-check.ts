import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { BrowserWindow, ipcMain } from "electron"
import { VykorClient } from "@vykor/client"
import { DesktopPluginAppService } from "../../src/main/features/plugin-apps/plugin-app-service"
import { pluginAppMessageReady } from "../../src/main/features/plugin-apps/message-ready"
import { createPluginAppsIpcContribution } from "../../src/main/features/plugin-apps/ipc"
import { PluginAppDocumentStore } from "../../src/main/features/plugin-apps/document-store"
import { attachPluginAppWindowPolicy } from "../../src/main/features/plugin-apps/window-policy"
interface Ready { baseUrl: string; token: string; root: string; sessionId: string; pluginId: string; toolName: string; effectFile: string; surfaceId: string }
/** Actual production Main IPC + root owner + official App, backed by real ToolHost/stdio and SQLite. */
export async function checkResidentPluginApps(root: string, documents: PluginAppDocumentStore, kind: "native-tools" | "mcp-server" | "text-inspector" | "notes-app", probeUrl: string, probeRequests: () => number) {
  const child = spawn(process.env.VYKOR_UI_TEST_NODE!, [join(__dirname, "../backend/plugin-app-backend.mjs")], {
    cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: { ...process.env, VYKOR_APP_BACKEND: kind, VYKOR_APP_PAGE_BUNDLE: join(__dirname, "../plugin-app-page.js") },
  })
  let stderr = ""
  let modelCalls: number | undefined
  child.stdout?.resume(); child.stderr?.on("data", data => { stderr += data })
  child.on("message", value => { if (value && typeof value === "object" && "modelCalls" in value) modelCalls = Number(value.modelCalls) })
  const ready = await new Promise<Ready>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error("App backend startup: " + stderr)) }, 45000)
    child.once("error", reject)
    child.once("exit", code => { clearTimeout(timer); reject(new Error(`App backend exited ${code}: ${stderr}`)) })
    child.on("message", value => { if (value && typeof value === "object" && "baseUrl" in value) { clearTimeout(timer); resolve(value as Ready) } })
  })
  const client = new VykorClient({ baseUrl: ready.baseUrl, token: ready.token })
  const page = join(root, ".superpowers/sdd/2026-10-20-mcp-apps-resident-panels/electron-build/renderer/tests/plugin-apps-electron/plugin-app-host.html")
  const windows = [0, 1].map(() => new BrowserWindow({ show: false, webPreferences: {
    preload: join(__dirname, "../preload/index.cjs"), nodeIntegration: false, nodeIntegrationInSubFrames: false,
    contextIsolation: true, sandbox: false, backgroundThrottling: false,
  } }))
  const token = {}, owners = new Set(windows.map(window => window.webContents.id))
  let activeSession = ready.sessionId
  const service = new DesktopPluginAppService({ documents, getClient: async () => client, messageReady: pluginAppMessageReady,
    getOwnerSessionToken: (ownerId, sessionId) => owners.has(ownerId) && sessionId === activeSession ? token : undefined })
  for (const window of windows) { service.registerOwner(window.webContents, pathToFileURL(page).href); attachPluginAppWindowPolicy(window.webContents, documents) }
  const handlers = createPluginAppsIpcContribution(() => service).register({} as never)
  for (const { channel, handler } of handlers) ipcMain.handle(channel, (event, ...args) => handler(event, ...args))
  const [owner, second] = windows as [BrowserWindow, BrowserWindow]
  const evaluate = async (window: BrowserWindow, js: string) => {
    try { return await window.webContents.executeJavaScript(js) }
    catch (error) { throw new Error(`Host evaluation ${js.slice(0, 120)}: ${error}`) }
  }
  const appEvaluate = async (frame: Electron.WebFrameMain, js: string) => {
    try { return await frame.executeJavaScript(js) }
    catch (error) { throw new Error(`App evaluation ${js.slice(0, 120)}: ${error}`) }
  }
  const wait = async (predicate: () => Promise<boolean>, description: string) => {
    const until = Date.now() + 15000
    while (Date.now() < until) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 30)) }
    throw new Error("Resident app deadline: " + description + " " + stderr)
  }
  const effects = () => existsSync(ready.effectFile) ? Number(readFileSync(ready.effectFile, "utf8")) : 0
  let scenarioPassed = false
  try {
    if (kind === "text-inspector") assert.equal(await pluginAppMessageReady(client, ready.sessionId), true, "real configured fixture model is available")
    await Promise.all(windows.map(window => window.loadFile(page)))
    await wait(async () => await evaluate(owner, "typeof window.fixtureOpen === 'function'"), "host ready")
    const mountId: string = await evaluate(owner, `window.fixtureOpen(${JSON.stringify(ready.sessionId)},${JSON.stringify(ready.pluginId)},${JSON.stringify(ready.surfaceId)})`)
    await wait(async () => owner.webContents.mainFrame.frames.some(frame => frame.url.startsWith("vykor-plugin-app:")), "frame load")
    const frame = owner.webContents.mainFrame.frames.find(frame => frame.url.startsWith("vykor-plugin-app:"))!
    const networkBefore = probeRequests()
    assert.equal(await appEvaluate(frame, `fetch(${JSON.stringify(probeUrl)}).then(()=>false,()=>true)`), true)
    assert.equal(probeRequests(), networkBefore, "reachable loopback probe received no sandbox requests")
    if (kind === "notes-app") {
      await wait(async () => await appEvaluate(frame, "document.querySelector('#status').textContent.includes('已读取')"), "notes official initialization")
      await evaluate(owner, "window.fixtureSavedWindow=document.querySelector('iframe').contentWindow;void 0")
      const edit = async (text: string) => appEvaluate(frame, `document.querySelector('#draft').value=${JSON.stringify(text)};document.querySelector('#draft').dispatchEvent(new Event('input',{bubbles:true}));void 0`)
      const confirmSave = async () => {
        await appEvaluate(frame, "document.querySelector('#save').click()")
        await wait(async () => await evaluate(owner, "document.querySelector('[role=alertdialog]')?.textContent.includes('save_note_draft')"), "notes save confirmation")
        await evaluate(owner, "Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='执行').click()")
      }
      await edit("hello world")
      await confirmSave()
      await wait(async () => await appEvaluate(frame, "document.querySelector('#status').textContent.includes('服务器确认已保存')"), "server save receipt")
      assert.equal(JSON.parse(readFileSync(ready.effectFile, "utf8")).revision, 1)
      await appEvaluate(frame, "document.querySelector('#draft').setSelectionRange(0,5);document.querySelector('#selection').click()")
      await wait(async () => await evaluate(owner, "window.fixtureContextIds().length===1"), "visible selection context")
      const ids = await evaluate(owner, "window.fixtureContextIds()")
      const contexts = await service.composerContext(owner.webContents.id, ready.sessionId, ids)
      await client.sessions.admitPrompt(ready.sessionId, { items: [{ type: "text", text: "将选区改为 together" },
        { type: "capability", kind: "plugin", pluginId: ready.pluginId, displayName: "Notes" }], pluginAppContexts: contexts })
      await wait(async () => await appEvaluate(frame, "document.querySelector('#draft').value==='together world'"), "model change arrives by real subscribed resource")
      await wait(async () => (await client.sessions.getState(ready.sessionId)).runs.every(run => !["pending", "running"].includes(run.status)), "notes model settled")
      const snapshot = await client.sessions.getState(ready.sessionId)
      const part = snapshot.parts.find(item => item.toolUseId === "model-note-edit")!
      assert.ok(part.metadata.pluginAppSource)
      assert.equal(await evaluate(owner, `window.fixtureOpenResult(${JSON.stringify(ready.sessionId)},${JSON.stringify(part.id)})`), mountId, "successful model tool reuses unique declared surface")
      assert.equal(await evaluate(owner, "window.fixtureSavedWindow===document.querySelector('iframe').contentWindow"), true)
      await appEvaluate(frame, "document.querySelector('#fullscreen').click()")
      await wait(async () => await evaluate(owner, "document.querySelector('[data-plugin-app-mount]').dataset.displayMode==='fullscreen'"), "official fullscreen request")
      await appEvaluate(frame, "document.querySelector('#fullscreen').click()")
      await wait(async () => await evaluate(owner, "document.querySelector('[data-plugin-app-mount]').dataset.displayMode==='inline'"), "official inline request")
      const beforeReconnectRead = client.pluginApps.readResource.bind(client.pluginApps)
      const beforeReconnectStream = client.pluginApps.notifications.bind(client.pluginApps)
      let reconnectResyncs = 0, reconnectReads = 0
      await appEvaluate(frame, "window.fixtureReconnectNotices=0;window.addEventListener('message',event=>{if(event.source===window.parent&&event.data?.method==='notifications/resources/list_changed')window.fixtureReconnectNotices++},true);void 0")
      client.pluginApps.notifications = async function* (...args) {
        for await (const notice of beforeReconnectStream(...args)) {
          if (notice.kind === "resync") {
            // Reset immediately before forwarding the real new-stream resync, excluding old queued notices.
            await appEvaluate(frame, "window.fixtureReconnectNotices=0;void 0")
            reconnectResyncs++
          }
          yield notice
        }
      }
      client.pluginApps.readResource = async (...args) => {
        const fromResync = args[2] === "notes://welcome" && reconnectResyncs > 0
          && await appEvaluate(frame, "window.fixtureReconnectNotices>0")
        const result = await beforeReconnectRead(...args)
        if (fromResync) reconnectReads++
        return result
      }
      service.invalidateConnection()
      assert.equal(reconnectReads, 0)
      await service.refresh(owner.webContents.id, { mountId })
      await wait(async () => reconnectResyncs > 0 && reconnectReads > 0, "new stream resync reaches App and completes a fresh resource read")
      assert.equal(await appEvaluate(frame, "document.querySelector('#draft').value"), "together world")
      const reconnectNotices = await appEvaluate(frame, "window.fixtureReconnectNotices")
      console.log(JSON.stringify({ scenario: "notes-reconnect-evidence", newStreamResyncs: reconnectResyncs,
        appResourceListChanged: reconnectNotices, completedPageReadsBefore: 0, completedPageReadsAfter: reconnectReads }))
      client.pluginApps.notifications = beforeReconnectStream
      client.pluginApps.readResource = beforeReconnectRead
      const originalInvoke = client.pluginApps.invoke.bind(client.pluginApps)
      let invokes = 0, lostRequestId = ""
      const noteSource = (await client.pluginApps.list(ready.sessionId)).apps.find(item => item.app.resourceUri === "ui://notes/editor")!.source
      client.pluginApps.invoke = async (...args) => {
        invokes++
        const accepted = await originalInvoke(...args)
        lostRequestId = accepted.receipt.requestId
        await wait(async () => (await client.pluginApps.getAction(args[0].source, args[0].requestId)).receipt.executionState === "completed", "notes persisted before acknowledgement loss")
        throw new Error("test: accepted tool acknowledgement lost")
      }
      await wait(async () => await evaluate(owner, "!document.querySelector('[role=alertdialog]')"), "notes old confirmation removed")
      await edit("final draft"); await confirmSave()
      await wait(async () => await appEvaluate(frame, "document.querySelector('#status').textContent.includes('待核实')"), "notes lost acknowledgement preserves draft")
      const recovered = await client.pluginApps.getAction(noteSource, lostRequestId)
      assert.equal(recovered.receipt.executionState, "completed")
      await service.refresh(owner.webContents.id, { mountId })
      assert.equal(await appEvaluate(frame, "document.querySelector('#draft').value"), "final draft")
      assert.equal(invokes, 1)
      assert.equal(JSON.parse(readFileSync(ready.effectFile, "utf8")).revision, 3)
      assert.equal(await evaluate(owner, "window.fixtureSavedWindow===document.querySelector('iframe').contentWindow"), true)
      // In-flight reads must fail when the durable app is closed, without returning stale data.
      const originalRead = client.pluginApps.readResource.bind(client.pluginApps)
      client.pluginApps.readResource = async (...args) => {
        const latest = await client.pluginApps.prepare(noteSource)
        await client.pluginApps.close(noteSource, { expectedRevision: latest.app.controlRevision })
        client.pluginApps.readResource = originalRead
        return originalRead(...args)
      }
      await assert.rejects(evaluate(owner, `window.desktop.pluginApps.readResource({mountId:${JSON.stringify(mountId)},uri:'notes://welcome'})`), /应用资源当前不可读/)
      assert.equal(JSON.parse(readFileSync(ready.effectFile, "utf8")).revision, 3)
      console.log(JSON.stringify({ scenario: "real-notes-app", offlineInstalledPackage: true, manualSave: true, selectionContext: true,
        modelEditViaOriginalRun: true, realSubscriptionRefresh: true, toolResultSurfaceReuse: true, sameFrameFullscreenInline: true,
        reconnectResync: true, revokedReadRejected: true, lostAcknowledgementCalls: invokes, businessRevision: 3, cspRequests: probeRequests() - networkBefore }))
      scenarioPassed = true; return
    }
    if (kind === "text-inspector") {
      // Real installed package HTML, real production bridge and Native Host; no fixture App replacement.
      await wait(async () => await appEvaluate(frame, "!document.querySelector('#draft').hidden"), "inspector connected")
      assert.equal(await appEvaluate(frame, "document.querySelector('#preview').value"), "")
      await appEvaluate(frame, "window.displayUpdates=0;new MutationObserver(()=>window.displayUpdates++).observe(document.querySelector('#findings'),{childList:true})")
      const initial = { content: [], structuredContent: { text: "ok  \n\titem\n", findings: [
        { line: 1, code: "trailing-whitespace" }, { line: 2, code: "tab-indentation" }], truncated: false } }
      await evaluate(owner, `window.fixturePush(${JSON.stringify(initial)})`)
      await wait(async () => await appEvaluate(frame, "document.querySelectorAll('#findings input').length===2"), "initial result")
      assert.equal(await appEvaluate(frame, "window.displayUpdates"), 1)
      assert.equal((await client.sessions.getState(ready.sessionId)).runs.length, 0, "notification never invokes tools")
      await appEvaluate(frame, "document.querySelector('#check-button').click()")
      await wait(async () => await evaluate(owner, "Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='执行' && !b.disabled)"), "inspector check confirmation")
      await evaluate(owner, "Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='执行').click()")
      await wait(async () => await appEvaluate(frame, "window.displayUpdates===2"), "explicit call result without notification")
      assert.equal((await client.sessions.getState(ready.sessionId)).runs.length, 1)
      await appEvaluate(frame, "document.querySelector('#findings input').click();document.querySelector('#draft').click()")
      await wait(async () => await evaluate(owner, "!!document.querySelector('[aria-label=\"插件上下文\"]')"), "visible context")
      assert.equal((await client.sessions.getState(ready.sessionId)).runs.length, 1, "context does not call model")
      await appEvaluate(frame, "document.querySelector('#preview-button').click()")
      await wait(async () => await evaluate(owner, "Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='执行' && !b.disabled)"), "inspector preview confirmation")
      await evaluate(owner, "Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='执行').click()")
      await wait(async () => await appEvaluate(frame, "document.querySelector('#preview').value==='ok\\n\\titem\\n'"), "real native preview")
      assert.equal((await client.sessions.getState(ready.sessionId)).runs.length, 2)
      await wait(async () => await evaluate(owner, "!document.querySelector('[role=alertdialog]')"), "preview confirmation fully closed")
      const originalSubmit = client.pluginApps.submitConversation.bind(client.pluginApps)
      let messageSubmits = 0
      client.pluginApps.submitConversation = async (...args) => { messageSubmits++; await originalSubmit(...args); throw new Error("test: accepted message acknowledgement lost") }
      await appEvaluate(frame, "document.querySelector('#findings input').click()")
      assert.deepEqual(await appEvaluate(frame, "({hidden:document.querySelector('#submit').hidden,disabled:document.querySelector('#submit').disabled})"), { hidden: false, disabled: false })
      await appEvaluate(frame, "document.querySelector('#submit').click()")
      try {
        await wait(async () => await evaluate(owner, "document.querySelector('[role=alertdialog]')?.textContent.includes('来自 example.text-inspector 的消息') && Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='发送' && !b.disabled)"), "ordinary message confirmation")
      } catch (error) {
        throw new Error(`${error}; page=${await appEvaluate(frame, "document.querySelector('#status').textContent")}; dialog=${await evaluate(owner, "document.querySelector('[role=alertdialog]')?.textContent")}`)
      }
      await evaluate(owner, "Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='发送').click()")
      await wait(async () => await appEvaluate(frame, "document.querySelector('#status').textContent.includes('已交给助手')"), "ordinary message accepted")
      await wait(async () => (await client.sessions.getState(ready.sessionId)).runs.every(run => !["pending", "running"].includes(run.status)), "model completed")
      const sent = await client.sessions.getState(ready.sessionId)
      assert.equal(sent.runs.length, 3)
      assert.equal(sent.inputs.length, 1)
      assert.equal(messageSubmits, 1, "lost message acknowledgement never resubmits")
      assert.equal((await client.pluginApps.list(ready.sessionId)).apps[0]?.app.status, "open")
      await evaluate(owner, "window.fixtureSavedWindow=document.querySelector('iframe').contentWindow;window.fixtureVisible(false)")
      await evaluate(owner, "window.fixtureVisible(true)")
      assert.equal(await evaluate(owner, "window.fixtureSavedWindow===document.querySelector('iframe').contentWindow"), true)
      console.log(JSON.stringify({ scenario: "real-text-inspector", offlineInstalledPackage: true, initialNotificationRenders: 1, notificationCalls: 0,
        explicitResponseRenders: 1, checkAndPreviewRuns: 2, ordinaryMessageRuns: 1, messageKeepsOpen: true,
        visibleContext: true, sameContentWindow: true, cspRequests: probeRequests() - networkBefore }))
      scenarioPassed = true
      return
    }
    await wait(async () => await appEvaluate(frame, "window.fixtureHandshakes === 1"), "official handshake")
    await appEvaluate(frame, "document.querySelector('#draft').value='unsaved original';")
    await evaluate(owner, "window.fixtureSavedWindow=document.querySelector('iframe').contentWindow;window.fixtureVisible(false)")
    await wait(async () => await evaluate(owner, "document.querySelector('[data-plugin-app-mount]').inert"), "trusted hidden state")
    assert.deepEqual(await appEvaluate(frame, `Promise.all([
      window.fixtureApp.callServerTool({name:${JSON.stringify(ready.toolName)},arguments:{value:'hidden'}}),
      window.fixtureApp.sendMessage({role:'user',content:[{type:'text',text:'hidden'}]}),
      window.fixtureApp.updateModelContext({content:[{type:'text',text:'hidden'}]})
    ].map(p=>p.then(()=>false,()=>true)))`), [true, true, true])
    assert.equal(effects(), 0)
    activeSession = "different-session"
    await evaluate(owner, "window.fixtureSelect('different-session')")
    await evaluate(owner, "window.fixtureSelect('app-session');window.fixtureVisible(true)")
    assert.equal(await evaluate(owner, "window.fixtureSavedWindow===document.querySelector('iframe').contentWindow"), true)
    assert.deepEqual(await appEvaluate(frame, "({draft:document.querySelector('#draft').value,handshakes:window.fixtureHandshakes})"), { draft: "unsaved original", handshakes: 1 })
    assert.deepEqual(await appEvaluate(frame, "({node:typeof process,preload:typeof window.desktop,parent:(()=>{try{return !!parent.document}catch{return false}})()})"), { node: "undefined", preload: "undefined", parent: false })
    await assert.rejects(evaluate(second, `window.desktop.pluginApps.prepareTool({mountId:${JSON.stringify(mountId)},name:${JSON.stringify(ready.toolName)},arguments:{value:'forged'}})`))
    await appEvaluate(frame, "document.querySelector('#save').click()")
    await wait(async () => await evaluate(owner, "Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='执行' && !b.disabled)"), "confirmation")
    await evaluate(owner, "Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='执行').click()")
    await wait(async () => await appEvaluate(frame, "!!window.fixtureResult"), "original tool result")
    assert.equal(effects(), 1)
    const result = await appEvaluate(frame, "window.fixtureResult")
    if (kind === "mcp-server") assert.deepEqual(result._meta, { private: "page only" })
    assert.equal((await client.pluginApps.list(ready.sessionId)).apps.length, 1)
    activeSession = ready.sessionId
    const app = (await client.pluginApps.list(ready.sessionId)).apps[0]!
    await appEvaluate(frame, "window.fixtureError=undefined;document.querySelector('#save').click()")
    await wait(async () => await evaluate(owner, "Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='执行' && !b.disabled)"), "stale confirmation opened")
    const concurrent = await client.pluginApps.prepare(app.source)
    const otherAction = await client.pluginApps.invoke({ source: app.source, lease: concurrent.lease!, requestId: "other-window",
      expectedRevision: concurrent.app.controlRevision, toolName: ready.toolName, args: { value: "other viewer" } })
    await wait(async () => !["pending", "running"].includes((await client.pluginApps.getAction(app.source, "other-window")).receipt.status), "other viewer completed")
    assert.ok(otherAction.receipt.runId)
    await evaluate(owner, "Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='执行').click()")
    await wait(async () => await appEvaluate(frame, "!!window.fixtureError"), "stale request rejected before admission")
    assert.equal(effects(), 2, "stale confirmed action never executed")
    await wait(async () => await evaluate(owner, "!document.querySelector('[role=alertdialog]')"), "stale dialog fully closed")
    await service.refresh(owner.webContents.id, { mountId })
    await appEvaluate(frame, "window.fixtureResult=undefined;document.querySelector('#save').click()")
    await wait(async () => await evaluate(owner, "Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='执行' && !b.disabled)"), "fresh explicit click after rejection")
    await evaluate(owner, "Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='执行').click()")
    await wait(async () => await appEvaluate(frame, "!!window.fixtureResult"), "fresh explicit call result")
    assert.equal(effects(), 3)
    const originalInvoke = client.pluginApps.invoke.bind(client.pluginApps)
    let lostInvokes = 0
    client.pluginApps.invoke = async (...args) => {
      lostInvokes++
      const accepted = await originalInvoke(...args)
      await wait(async () => !["pending", "running"].includes((await client.pluginApps.getAction(accepted.receipt.source, accepted.receipt.requestId)).receipt.status), "accepted tool completed before dropped response")
      const terminal = await client.pluginApps.getAction(accepted.receipt.source, accepted.receipt.requestId)
      assert.equal(terminal.receipt.executionState, "completed", JSON.stringify(terminal))
      throw new Error("test: accepted tool acknowledgement lost")
    }
    await appEvaluate(frame, "window.fixtureError=undefined;document.querySelector('#save').click()")
    await wait(async () => await evaluate(owner, "Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='执行' && !b.disabled)"), "lost acknowledgement confirmation")
    await evaluate(owner, "Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='执行').click()")
    await wait(async () => await appEvaluate(frame, "!!window.fixtureError"), "lost acknowledgement delivered")
    console.log(JSON.stringify({ scenario: "resident-progress", kind, step: "lost-ack-delivered" }))
    client.pluginApps.invoke = originalInvoke
    await wait(async () => {
      await service.refresh(owner.webContents.id, { mountId })
      return (await client.pluginApps.prepare(app.source)).availability.canInvokeTools
    }, "lost tool receipt settled")
    assert.equal(effects(), 4); assert.equal(lostInvokes, 1)
    console.log(JSON.stringify({ scenario: "resident-progress", kind, step: "lost-ack-recovered" }))
    const fresh = await service.prepareTool(owner.webContents.id, { mountId, name: ready.toolName, arguments: { value: "ready again" } })
    await service.cancelTool(owner.webContents.id, { mountId, requestId: fresh.requestId })
    console.log(JSON.stringify({ scenario: "resident-progress", kind, step: "new-request-prepared-and-cancelled" }))
    const originalClose = client.pluginApps.close.bind(client.pluginApps)
    client.pluginApps.close = async (source, input, options) => {
      console.log(JSON.stringify({ scenario: "resident-progress", kind, step: "close-race-entered" }))
      const current = await client.pluginApps.prepare(source)
      await originalInvoke({ source, requestId: "close-race", lease: current.lease!, expectedRevision: current.app.controlRevision,
        toolName: ready.toolName, args: { value: "concurrent close" } })
      await wait(async () => !["pending", "running"].includes((await client.pluginApps.getAction(source, "close-race")).receipt.status), "close race completed")
      return originalClose(source, input, options)
    }
    await evaluate(owner, "window.fixtureSavedWindow=document.querySelector('iframe').contentWindow;void 0")
    console.log(JSON.stringify({ scenario: "resident-progress", kind, step: "calling-close" }))
    await assert.rejects(evaluate(owner, "window.fixtureClose()"))
    client.pluginApps.close = originalClose
    assert.equal(await evaluate(owner, "window.fixtureSavedWindow===document.querySelector('iframe').contentWindow"), true)
    assert.equal(await appEvaluate(frame, "document.querySelector('#draft').value"), "unsaved original")
    assert.equal((await client.pluginApps.prepare(app.source)).app.status, "open")
    assert.equal(effects(), 5)
    await evaluate(second, `window.fixtureMount(${JSON.stringify(app.source)})`)
    await evaluate(owner, "window.fixtureRelease()")
    assert.equal((await client.pluginApps.prepare(app.source)).app.status, "open", "window release must not close another viewer")
    await assert.rejects(evaluate(owner, `window.desktop.pluginApps.prepareTool({mountId:${JSON.stringify(mountId)},name:${JSON.stringify(ready.toolName)},arguments:{value:'retired'}})`))
    await wait(async () => second.webContents.mainFrame.frames.some(item => item.url.startsWith("vykor-plugin-app:")), "second frame load")
    const secondFrame = second.webContents.mainFrame.frames.find(item => item.url.startsWith("vykor-plugin-app:"))!
    await wait(async () => await appEvaluate(secondFrame, "window.fixtureHandshakes===1"), "second handshake")
    await appEvaluate(secondFrame, "document.querySelector('#wait').click()")
    await wait(async () => await evaluate(second, "Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='执行' && !b.disabled)"), "cancel confirmation")
    await evaluate(second, "Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='执行').click()")
    await wait(async () => effects() === 6, "accepted side effect")
    const running = (await client.sessions.getState(ready.sessionId)).runs.find(run => run.status === "running")!
    assert.ok(running, "original Run is running before cancellation")
    const action = running.metadata.pluginAppAction as { requestId: string }
    assert.ok(action.requestId)
    await appEvaluate(secondFrame, "document.querySelector('#cancel').click()")
    await wait(async () => {
      const receipt = (await client.pluginApps.getAction(app.source, action.requestId)).receipt
      return receipt.runId === running.id && receipt.status !== "pending" && receipt.status !== "running" && receipt.executionState === "unknown"
    }, "original cancellation terminal receipt with unknown execution")
    await wait(async () => await appEvaluate(secondFrame, "!!window.fixtureError"), "cancel rejection delivered")
    await appEvaluate(secondFrame, "window.fixtureError=undefined;document.querySelector('#save').click()")
    await wait(async () => await appEvaluate(secondFrame, "!!window.fixtureError"), "unknown blocks next operation")
    assert.equal(effects(), 6)
    await assert.rejects(secondFrame.executeJavaScript("window.fixtureApp.sendMessage({role:'user',content:[{type:'text',text:'blocked'}]})"))
    await second.loadURL("about:blank")
    assert.equal((await client.pluginApps.prepare(app.source)).availability.reason, "action-unconfirmed")
    console.log(JSON.stringify({ scenario: "resident-plugin-app", kind, sameContentWindow: true, draft: true, singleHandshake: true,
      originalSession: true, foreignOwnerRejected: true, hiddenRequestsRejected: true, staleConfirmationRecovery: true, lostAcknowledgementNoReplay: true,
      closeConflictRetainsFrame: true, releaseIsNotClose: true,
      cancelledUnknown: true, cancelledRunId: running.id, cspRequests: probeRequests() - networkBefore, executions: effects() }))
    scenarioPassed = true
  } finally {
    for (const window of windows) if (!window.isDestroyed()) window.destroy()
    service.dispose()
    for (const { channel } of handlers) ipcMain.removeHandler(channel)
    child.send("close")
    await new Promise<void>(resolve => { const timer = setTimeout(() => { child.kill(); resolve() }, 5000); child.once("exit", () => { clearTimeout(timer); resolve() }) })
    if (scenarioPassed) assert.equal(modelCalls, kind === "notes-app" ? 2 : kind === "text-inspector" ? 1 : 0, "exact original model invocation count")
    console.log(JSON.stringify({ scenario: "resident-model-count", kind, modelCalls }))
  }
}
