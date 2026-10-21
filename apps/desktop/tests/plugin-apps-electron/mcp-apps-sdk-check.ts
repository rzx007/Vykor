import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { BrowserWindow } from "electron"
import type { PluginAppDocumentStore } from "../../src/main/features/plugin-apps/document-store"

export async function checkMcpAppsSdk(owner: BrowserWindow, store: PluginAppDocumentStore, root: string) {
  const bundle = readFileSync(join(__dirname, "../mcp-apps-sdk-fixture.js"), "utf8")
  const template = readFileSync(join(root, "apps/desktop/tests/plugin-apps-electron/mcp-apps-sdk.html"), "utf8")
  const html = template.replace("/* MCP_SDK_BUNDLE */", () => bundle.replace(/<\/script/gi, "<\\/script"))
  const mounted = store.register({ ownerId: owner.webContents.id, connection: {}, sessionId: "sdk-session",
    appId: "20000000-0000-4000-8000-000000000001", html, sha256: createHash("sha256").update(html).digest("hex") })
  const raw = { content: [{ type: "text", text: "public text" }, { type: "image", mimeType: "image/png", data: "cGl4ZWw=" }],
    structuredContent: { rows: [{ id: 1 }] }, _meta: { private: "app-only secret" }, isError: true }
  try {
    await owner.loadFile(join(root, "apps/desktop/tests/plugin-apps-electron/host.html"))
    await owner.webContents.executeJavaScript(bundle)
    await owner.webContents.executeJavaScript(`window.runMcpSdkFixture(${JSON.stringify(mounted.url)},${JSON.stringify(raw)})`)
    const deadline = Date.now() + 15_000
    let probe: Record<string, unknown> = {}
    while (Date.now() < deadline) {
      probe = await owner.webContents.executeJavaScript("window.mcpSdkProbe")
      assert.equal(probe.error, undefined, JSON.stringify(probe))
      if (probe.connected && probe.initialized && probe.requestAborted && probe.requestRejected && probe.cancelled) break
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    const diagnostics = probe.connected ? probe : {
      ...probe, frames: await Promise.all(owner.webContents.mainFrame.frames.map(frame =>
        frame.executeJavaScript("({url:location.href,mode:document.documentElement.dataset.mcpSdk,probe:window.mcpSdkProbe,scriptBytes:document.scripts[0]?.textContent.length})"))),
    }
    assert.equal(probe.connected, true, JSON.stringify(diagnostics))
    assert.equal(probe.initialized, true)
    assert.deepEqual(probe.input, { fixture: "initial input" })
    assert.deepEqual(probe.result, raw, "official App must receive full private metadata and structured content")
    assert.equal(probe.requestAborted, true, "official tools/call cancellation must reach AppBridge signal")
    assert.equal(probe.requestRejected, true)
    assert.equal(probe.cancelled, "fixture cancellation")
    const frame = owner.webContents.mainFrame.frames[0]!
    assert.deepEqual(await frame.executeJavaScript("({node:typeof process,preload:typeof window.desktop,parent:(()=>{try{return !!parent.document}catch{return false}})()})"),
      { node: "undefined", preload: "undefined", parent: false })
    assert.equal(await owner.webContents.executeJavaScript("document.querySelector('iframe').sandbox.value"), "allow-scripts")
    await owner.webContents.executeJavaScript("window.disposeMcpSdkFixture?.()")
    const modes = await checkDisplayModes(owner, store, template, bundle)
    return { displayModes: modes, mcpAppsSdk: { version: "1.1.2", handshake: true, fullInitialResult: true, requestCancellation: true, toolCancelledNotification: true, opaqueSandbox: true } }
  } finally {
    await owner.webContents.executeJavaScript("window.disposeMcpSdkFixture?.()")
    store.revoke(mounted.mountId)
  }
}

async function checkDisplayModes(owner: BrowserWindow, store: PluginAppDocumentStore, template: string, bundle: string) {
  const outcomes: Record<string, unknown> = {}
  for (const mode of ["omitted", "inline", "fullscreen"]) {
    const html = template.replace('data-mcp-sdk="app"', `data-mcp-mode="${mode}"`).replace("/* MCP_SDK_BUNDLE */", () => bundle.replace(/<\/script/gi, "<\\/script"))
    const mounted = store.register({ ownerId: owner.webContents.id, connection: {}, sessionId: "mode-session", appId: "mode-" + mode,
      html, sha256: createHash("sha256").update(html).digest("hex") })
    try {
      await owner.webContents.executeJavaScript(`window.runMcpModeFixture(${JSON.stringify(mounted.url)})`)
      const deadline = Date.now() + 10_000
      let state: any
      while (Date.now() < deadline) {
        state = await owner.webContents.executeJavaScript("window.modeState()")
        if (state.modes) break
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      assert.deepEqual(state.modes, mode === "fullscreen" ? ["inline", "fullscreen"] : ["inline"])
      assert.equal(state.eligible, mode === "fullscreen")
      assert.equal(state.visibility, "visible")
      const frame = owner.webContents.mainFrame.frames[0]!
      await frame.executeJavaScript("document.querySelector('#draft').value='edited after handshake'; window.modeDocumentToken='same-document'")
      assert.equal(await frame.executeJavaScript("window.modeApp.getHostContext().displayMode"), "inline")
      assert.deepEqual(await frame.executeJavaScript("window.modeApp.getHostContext().availableDisplayModes"), state.modes)
      assert.equal(await frame.executeJavaScript("window.modeApp.requestDisplayMode({mode:'pip'}).then(()=>false,()=>true)"), true)
      if (mode === "fullscreen") {
        await owner.webContents.executeJavaScript("window.modePlace('sidebar')")
        // Await the official context notification in the App's public callback.
        await frame.executeJavaScript("window.modeApp.getHostContext().displayMode==='fullscreen' ? true : new Promise(resolve => { window.modeApp.onhostcontextchanged = context => { if(context.displayMode==='fullscreen') resolve(true) } })")
        const sidebar = await owner.webContents.executeJavaScript("window.modeState()")
        assert.equal(sidebar.left, "400px"); assert.equal(sidebar.width, "200px"); assert.equal(sidebar.mode, "fullscreen")
        await owner.webContents.executeJavaScript("window.modePlace('hidden')")
        assert.equal((await owner.webContents.executeJavaScript("window.modeState()")).visibility, "hidden")
        await owner.webContents.executeJavaScript("window.modePlace('inline')")
        await frame.executeJavaScript("window.modeApp.getHostContext().displayMode==='inline' ? true : new Promise(resolve => { window.modeApp.onhostcontextchanged = context => { if(context.displayMode==='inline') resolve(true) } })")
        assert.deepEqual(await frame.executeJavaScript("window.modeApp.requestDisplayMode({mode:'fullscreen'})"), { mode: "fullscreen" })
        assert.equal((await owner.webContents.executeJavaScript("window.modeState()")).left, "0px")
        assert.deepEqual(await frame.executeJavaScript("window.modeApp.requestDisplayMode({mode:'inline'})"), { mode: "inline" })
      } else assert.equal(await frame.executeJavaScript("window.modeApp.requestDisplayMode({mode:'fullscreen'}).then(()=>false,()=>true)"), true)
      const final = await owner.webContents.executeJavaScript("window.modeState()")
      assert.equal(final.sameWindow, true); assert.equal(final.attached, true); assert.equal(final.handshakes, 1)
      assert.equal(await frame.executeJavaScript("window.modeHandshakes"), 1)
      assert.equal(await frame.executeJavaScript("document.querySelector('#draft').value"), "edited after handshake")
      assert.equal(await frame.executeJavaScript("window.modeDocumentToken"), "same-document")
      outcomes[mode] = { eligible: final.eligible, sameWindow: true, handshakes: 1, draft: true, unsupportedRequestRejected: true }
    } finally {
      await owner.webContents.executeJavaScript("window.disposeMcpModeFixture?.()")
      store.revoke(mounted.mountId)
    }
  }
  return outcomes
}
