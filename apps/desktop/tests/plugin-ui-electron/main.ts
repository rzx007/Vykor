import { app, BrowserWindow, ipcMain, session } from "electron"
import { createHash } from "node:crypto"
import { createServer } from "node:http"
import { mkdirSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import assert from "node:assert/strict"
import {
  PluginUiDocumentStore,
  PLUGIN_UI_PERMISSIONS_POLICY,
} from "../../src/main/features/plugin-ui/document-store"
import {
  installPluginUiDocumentProtocol,
  registerPluginUiScheme,
} from "../../src/main/features/plugin-ui/document-protocol"
import { attachPluginUiWindowPolicy } from "../../src/main/features/plugin-ui/window-policy"
import { checkDesktopUi } from "./desktop-ui-check"
import { checkNativeUi } from "./native-ui-check"
import { desktopPluginUiDocuments } from "../../src/main/features/plugin-ui/document-runtime"

const root = process.env.VYKOR_UI_TEST_ROOT!
const profile = join(root, ".superpowers/sdd/2026-10-03-native-plugin-ui-a3/electron-profile")
mkdirSync(profile, { recursive: true })
app.setPath("userData", profile)
app.setPath("sessionData", profile)
app.setAppLogsPath(join(profile, "logs"))
app.commandLine.appendSwitch("disable-gpu")
registerPluginUiScheme()
const deadline = setTimeout(() => {
  console.error("plugin-ui Electron test timed out")
  app.exit(2)
}, 120_000)
const instanceId = "10000000-0000-4000-8000-000000000001"
const snapshot = {
  instanceId,
  revision: 1,
  status: "open",
  data: { count: 1 },
  actions: [],
  readOnly: true,
  theme: "light",
  locale: "zh-CN",
  surface: "tool-result",
}
app
  .whenReady()
  .then(async () => {
    let requests = 0
    let popups = 0
    let downloads = 0
    const server = createServer((_req, res) => {
      requests++
      res.end("outside")
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address() as { port: number }
    const external = "http://127.0.0.1:" + address.port + "/escape"
    const store = desktopPluginUiDocuments
    installPluginUiDocumentProtocol(store, session.defaultSession)
    const preload = join(__dirname, "../preload/index.cjs")
    const owner = new BrowserWindow({
      show: false,
      webPreferences: {
        preload,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        contextIsolation: true,
        sandbox: false,
        backgroundThrottling: false,
      },
    })
    const other = new BrowserWindow({
      show: false,
      webPreferences: {
        preload,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        contextIsolation: true,
        sandbox: false,
      },
    })
    attachPluginUiWindowPolicy(owner.webContents, store)
    attachPluginUiWindowPolicy(other.webContents, store)
    if (process.env.VYKOR_UI_TEST_REFERENCE === "only") {
      const referenceUi = await checkNativeUi(owner, store, root, true)
      console.log(
        JSON.stringify({ result: "passed", electron: process.versions.electron, ...referenceUi })
      )
      owner.destroy()
      other.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      clearTimeout(deadline)
      app.exit(0)
      return
    }
    owner.webContents.setWindowOpenHandler(() => {
      popups++
      return { action: "deny" }
    })
    session.defaultSession.on("will-download", (event) => {
      downloads++
      event.preventDefault()
    })
    const host = join(root, "apps/desktop/tests/plugin-ui-electron/host.html")
    await owner.loadFile(host)
    await other.loadFile(host)
    assert.equal(
      await owner.webContents.executeJavaScript("typeof window.desktop"),
      "object",
      "trusted preload must actually run"
    )
    const assets = join(root, "tests/browser-plugin-ui-sdk/dist/assets")
    const bundle = readdirSync(assets).filter((name) => name.endsWith(".js"))
    assert.equal(bundle.length, 1)
    const sdk = readFileSync(join(assets, bundle[0]!), "utf8").replace(/<\/script/gi, "<\\/script")
    const attacks =
      "window.addEventListener('message',event=>{" +
      "if(event.data==='attack'){window.attacksRan=true;window.open(" +
      JSON.stringify(external) +
      ");" +
      "fetch(" +
      JSON.stringify(external) +
      ").catch(()=>{});" +
      "const img=new Image();img.src=" +
      JSON.stringify(external) +
      ";document.body.append(img);" +
      "const relax=document.createElement('meta');relax.httpEquiv='Content-Security-Policy';relax.content=\"default-src * 'unsafe-inline'\";document.head.append(relax);" +
      "const script=document.createElement('script');script.src=" +
      JSON.stringify(external + "/script.js") +
      ";document.head.append(script);" +
      "const style=document.createElement('style');style.textContent=\"@font-face{font-family:escape;src:url('" +
      external +
      "/font.woff2')}body{font-family:escape}\";document.head.append(style);" +
      "fetch('file:///C:/Windows/win.ini').then(r=>r.text()).then(t=>window.fileData=t).catch(()=>{});" +
      "try{const w=new Worker(URL.createObjectURL(new Blob(['postMessage(1)'],{type:'text/javascript'})));w.onmessage=()=>window.workerRan=true}catch{window.workerBlocked=true}" +
      "const nested=document.createElement('iframe');nested.srcdoc='<script>parent.nestedRan=true<\\/script>';document.body.append(nested);" +
      "const link=document.createElement('a');link.href='data:text/plain,download';link.download='attack.txt';document.body.append(link);link.click();" +
      "}" +
      "if(event.data?.command==='navigate')location.href=event.data.url;" +
      "if(event.data==='retired')location.href='data:text/html,<script>window.escaped=1<\\/script>';});"
    const html =
      '<p id="status">waiting</p><script>' + sdk + "</script><script>" + attacks + "</script>"
    const mounted = store.register({
      ownerId: owner.webContents.id,
      connection: {},
      sessionId: "session",
      instanceId,
      componentDigest: "a".repeat(64),
      surface: "tool-result",
      html,
      sha256: createHash("sha256").update(html).digest("hex"),
    })
    await owner.webContents.executeJavaScript(
      "window.addEventListener('message',event=>{const frame=document.querySelector('iframe');" +
        "if(event.source!==frame?.contentWindow||event.data?.type!=='plugin-ui-ready')return;" +
        "const c=new MessageChannel();c.port1.onmessage=e=>{const r=JSON.parse(e.data);" +
        "c.port1.postMessage(JSON.stringify({version:1,mountId:" +
        JSON.stringify(mounted.mountId) +
        ",id:r.id,result:" +
        JSON.stringify(snapshot) +
        "}));};" +
        "frame.contentWindow.postMessage({version:1,type:'plugin-ui-init',mountId:" +
        JSON.stringify(mounted.mountId) +
        "},'*',[c.port2]);" +
        "c.port1.postMessage(JSON.stringify({version:1,mountId:" +
        JSON.stringify(mounted.mountId) +
        ",type:'snapshot',snapshot:" +
        JSON.stringify(snapshot) +
        "}));});" +
        "const frame=document.createElement('iframe');frame.sandbox='allow-scripts';frame.title='test UI';" +
        "frame.allow=" +
        JSON.stringify(
          PLUGIN_UI_PERMISSIONS_POLICY.replaceAll("=()", " 'none'").replaceAll(", ", "; ")
        ) +
        ";" +
        "frame.src=" +
        JSON.stringify(mounted.url) +
        ";document.body.append(frame);"
    )
    const wait = async (check: () => Promise<boolean>): Promise<void> => {
      const end = Date.now() + 5_000
      while (Date.now() < end) {
        if (await check()) return
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      throw new Error("Electron assertion deadline")
    }
    await wait(async () => {
      const frame = owner.webContents.mainFrame.frames[0]
      return (
        !!frame &&
        (await frame.executeJavaScript("document.querySelector('#status')?.textContent==='1'"))
      )
    })
    const frame = owner.webContents.mainFrame.frames[0]!
    const isolation = await frame.executeJavaScript(
      "({node:typeof require,process:typeof process,buffer:typeof Buffer," +
        "desktop:typeof window.desktop,electron:typeof window.electron,parent:(()=>{try{parent.document.body;return true}catch{return false}})()})"
    )
    assert.deepEqual(isolation, {
      node: "undefined",
      process: "undefined",
      buffer: "undefined",
      desktop: "undefined",
      electron: "undefined",
      parent: false,
    })
    const original = frame.url
    // Attacks run in the author's actual document realm, not privileged main executeJavaScript.
    await owner.webContents.executeJavaScript(
      "document.querySelector('iframe').contentWindow.postMessage('attack','*')"
    )
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.equal(await frame.executeJavaScript("window.attacksRan"), true)
    assert.deepEqual(
      await frame.executeJavaScript(
        "({file:typeof window.fileData,worker:typeof window.workerRan,nested:typeof window.nestedRan})"
      ),
      { file: "undefined", worker: "undefined", nested: "undefined" }
    )
    assert.equal(frame.url, original)
    assert.equal(requests, 0)
    assert.equal(popups, 0)
    assert.equal(downloads, 0)
    const targetHtml = "<p>another instance secret</p><script>window.foreign=1</script>"
    const target = store.register({
      ownerId: owner.webContents.id,
      connection: {},
      sessionId: "session",
      instanceId: "10000000-0000-4000-8000-000000000002",
      componentDigest: "b".repeat(64),
      surface: "tool-result",
      html: targetHtml,
      sha256: createHash("sha256").update(targetHtml).digest("hex"),
    })
    await owner.webContents.executeJavaScript(
      "document.querySelector('iframe').contentWindow.postMessage(" +
        JSON.stringify({ command: "navigate", url: target.url }) +
        ",'*')"
    )
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(await frame.executeJavaScript("typeof window.foreign"), "undefined")
    assert.equal(
      frame.url,
      original,
      "actual frame navigation policy must reject another registered mount"
    )
    await other.webContents.executeJavaScript(
      "const frame=document.createElement('iframe');frame.sandbox='allow-scripts';frame.src=" +
        JSON.stringify(mounted.url) +
        ";document.body.append(frame)"
    )
    await new Promise((resolve) => setTimeout(resolve, 100))
    const otherFrame = other.webContents.mainFrame.frames[0]!
    assert.equal(
      await otherFrame.executeJavaScript("document.querySelector('#status')!==null"),
      false,
      "inspect the actual child: opaque parent access alone would be a false-negative"
    )
    await owner.webContents.executeJavaScript(
      "const script=document.createElement('script');script.textContent='window.inlineEscaped=1';document.head.append(script)"
    )
    assert.equal(
      await owner.webContents.executeJavaScript("typeof window.inlineEscaped"),
      "undefined"
    )
    store.revokeOwner(owner.webContents.id)
    assert.equal(store.respond(new Request(mounted.url)).status, 404)
    await owner.webContents.executeJavaScript(
      "document.querySelector('iframe').contentWindow.postMessage('retired','*')"
    )
    await new Promise((resolve) => setTimeout(resolve, 80))
    assert.equal(await frame.executeJavaScript("typeof window.escaped"), "undefined")
    assert.equal(requests, 0)
    const desktopUi = await checkDesktopUi(owner, store, root, sdk)
    const nativeUi = await checkNativeUi(owner, store, root)
    const referenceUi = await checkNativeUi(owner, store, root, true)
    console.log(
      JSON.stringify({
        result: "passed",
        electron: process.versions.electron,
        checks: [
          "actual SDK/MessageChannel",
          "trusted preload present",
          "opaque parent/Node/preload isolation",
          "network/navigation/popup/download/file/script/font/worker/nested-frame denied",
          "other window denied",
          "main CSP unchanged",
          "live-owner retirement",
        ],
        requests,
        popups,
        downloads,
        ...desktopUi,
        ...nativeUi,
        ...referenceUi,
      })
    )
    owner.destroy()
    other.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    clearTimeout(deadline)
    app.exit(0)
  })
  .catch((error) => {
    console.error(error)
    clearTimeout(deadline)
    app.exit(1)
  })
