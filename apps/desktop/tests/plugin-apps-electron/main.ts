import { app, BrowserWindow, session } from "electron"
import { createServer } from "node:http"
import { join } from "node:path"
import { registerPluginAppScheme, installPluginAppDocumentProtocol, desktopPluginAppDocuments } from "../../src/main/features/plugin-apps/document-protocol"
import { attachPluginAppWindowPolicy } from "../../src/main/features/plugin-apps/window-policy"
import { checkMcpAppsSdk } from "./mcp-apps-sdk-check"
import { checkResidentPluginApps } from "./plugin-app-check"
registerPluginAppScheme()
app.on("window-all-closed", () => {})
const root = process.env.VYKOR_UI_TEST_ROOT!
const deadline = setTimeout(() => { console.error("Electron assertion deadline"); app.exit(2) }, 120_000)
app.whenReady().then(async () => {
  let requests = 0
  const server = createServer((_req, res) => { requests++; res.end("outside") })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const external = "http://127.0.0.1:" + (server.address() as { port: number }).port + "/escape"
  installPluginAppDocumentProtocol(desktopPluginAppDocuments, session.defaultSession)
  const owner = new BrowserWindow({ show: false, webPreferences: { preload: join(__dirname, "../preload/index.cjs"), nodeIntegration: false, nodeIntegrationInSubFrames: false, contextIsolation: true, sandbox: false, backgroundThrottling: false } })
  attachPluginAppWindowPolicy(owner.webContents, desktopPluginAppDocuments)
  console.log(JSON.stringify({ scenario: "official-mcp-apps-sdk", ...await checkMcpAppsSdk(owner, desktopPluginAppDocuments, root) }))
  owner.destroy()
  if (process.env.VYKOR_UI_TEST_MCP_SDK_ONLY !== "1") {
    if (process.env.VYKOR_UI_TEST_INSPECTOR_ONLY !== "1" && process.env.VYKOR_UI_TEST_NOTES_ONLY !== "1") {
      await checkResidentPluginApps(root, desktopPluginAppDocuments, "native-tools", external, () => requests)
      await checkResidentPluginApps(root, desktopPluginAppDocuments, "mcp-server", external, () => requests)
    }
    if (process.env.VYKOR_UI_TEST_NOTES_ONLY !== "1") await checkResidentPluginApps(root, desktopPluginAppDocuments, "text-inspector", external, () => requests)
    if (process.env.VYKOR_UI_TEST_INSPECTOR_ONLY !== "1") await checkResidentPluginApps(root, desktopPluginAppDocuments, "notes-app", external, () => requests)
  }
  await new Promise<void>(resolve => server.close(() => resolve()))
  clearTimeout(deadline)
  console.log(JSON.stringify({ result: "passed", scenario: "resident-plugin-apps", electron: process.versions.electron }))
  app.quit()
}).catch(error => { console.error(error); clearTimeout(deadline); app.exit(1) })
