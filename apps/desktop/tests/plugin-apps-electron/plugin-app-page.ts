import { App, PostMessageTransport } from "@modelcontextprotocol/ext-apps"
declare global { interface Window { fixtureTool: string; fixtureApp: App; fixtureHandshakes: number; fixtureResult?: unknown; fixtureError?: string } }
window.fixtureHandshakes = 0
const app = new App({ name: "Resident fixture", version: "1" }, { availableDisplayModes: ["inline", "fullscreen"] }, { autoResize: false })
window.fixtureApp = app
let abort: AbortController | undefined
for (const [id, wait] of [["save", false], ["wait", true]] as const) document.getElementById(id)!.onclick = () => {
  abort = new AbortController()
  void app.callServerTool({ name: window.fixtureTool, arguments: { value: (document.getElementById("draft") as HTMLInputElement).value, ...(wait ? { wait } : {}) } }, { signal: abort.signal })
    .then(result => { window.fixtureResult = result; document.getElementById("result")!.textContent = JSON.stringify(result) }, error => { window.fixtureError = String(error) })
}
document.getElementById("cancel")!.onclick = () => abort?.abort()
void app.connect(new PostMessageTransport(window.parent, window.parent)).then(() => { window.fixtureHandshakes++ })
