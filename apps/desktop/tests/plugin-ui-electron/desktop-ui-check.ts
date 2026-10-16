import { BrowserWindow, ipcMain } from "electron"
import { createHash } from "node:crypto"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import assert from "node:assert/strict"
import { VykorClient } from "@vykor/client"
import { DesktopPluginUiService } from "../../src/main/features/plugin-ui/plugin-ui-service"
import { createPluginUiIpcContribution } from "../../src/main/features/plugin-ui/ipc"
import type { PluginUiDocumentStore } from "../../src/main/features/plugin-ui/document-store"
import { IpcEvents, IpcChannels } from "../../src/shared/ipc-channels"
import { currentPluginUiFrame } from "./plugin-ui-frame-query"
import {
  instance,
  sourcePart,
} from "../../src/renderer/src/components/desktop/conversation-page/plugin-ui/plugin-ui-fixtures.test-support"

export async function checkDesktopUi(
  owner: BrowserWindow,
  store: PluginUiDocumentStore,
  root: string,
  sdk: string
) {
  let revision = 1
  const admitted: Array<Record<string, unknown>> = []
  const html =
    '<p id="status">waiting</p><input id="local"><button id="apply">Apply</button><p id="result"></p><script>' +
    sdk +
    "</script>"
  const state = () => ({
    cursor: revision,
    syncStatus: "connected",
    session: {
      id: "session",
      cwd: "/fixture",
      title: "fixture",
      model: "fixture",
      status: "idle",
      metadata: {},
      createdAt: 1,
      updatedAt: 1,
    },
    parts: [
      {
        ...sourcePart,
        metadata: { pluginUi: { ...instance, revision, data: { count: revision } } },
      },
    ],
    inputs: [],
    messages: [],
    runs: [],
    tasks: [],
    attempts: [],
    permissions: [],
  })
  const client = new VykorClient({
    baseUrl: "http://127.0.0.1:1",
    fetch: async (url, options) => {
      const path = new URL(String(url)).pathname
      let value: unknown
      if (path === "/capabilities")
        value = {
          protocol: { version: 5 },
          serverVersion: "fixture",
          features: { pluginUi: 2, pluginUiLifecycle: 1 },
        }
      else if (path.endsWith("/state")) value = state()
      else if (path.endsWith("/document"))
        value = { html, sha256: createHash("sha256").update(html).digest("hex") }
      else if (path.endsWith("/actions")) {
        const input = JSON.parse(String(options?.body))
        admitted.push(input)
        revision++
        value = {
          receipt: {
            requestId: input.requestId,
            instanceId: instance.instanceId,
            runId: "fixture_once",
            revision,
            status: "completed",
          },
        }
        owner.webContents.send(IpcEvents.sessionUpdated, {
          kind: "snapshot",
          subscriptionId: "fixture",
          generation: 1,
          deliveryId: String(revision),
          view: state(),
        })
      } else
        value = {
          instance: { ...instance, revision, data: { count: revision } },
          availability: { code: "available", canRender: true, canInvoke: true },
          conversation: { draft: false, submit: false },
          actions: [
            {
              id: "apply",
              label: "应用检查结果",
              toolName: "Inspect",
              inputSchema: {},
              completion: "keep-open",
            },
          ],
        }
      return new Response(JSON.stringify(value), {
        headers: { "Content-Type": "application/json" },
      })
    },
  })
  const service = new DesktopPluginUiService({
    documents: store,
    getClient: async () => client,
    getOwnerSessionId: (id) => (id === owner.webContents.id ? "session" : undefined),
    localAvailable: () => true,
  })
  const page = join(
    root,
    ".superpowers/sdd/2026-10-11-native-plugin-ui-continuity/electron-build/renderer/tests/plugin-ui-electron/ui-host.html"
  )
  service.registerOwner(owner.webContents, pathToFileURL(page).href)
  const handlers = createPluginUiIpcContribution(() => service).register({} as never)
  for (const { channel, handler } of handlers) ipcMain.handle(channel, handler)
  ipcMain.handle(IpcChannels.sessionUpdateAck, () => ({ accepted: true }))
  ipcMain.handle(IpcChannels.sessionUpdateResync, () => ({ accepted: true }))
  const evaluate = (source: string) => owner.webContents.executeJavaScript(source)
  const wait = async (predicate: () => Promise<boolean>) => {
    const until = Date.now() + 5000
    while (Date.now() < until) {
      if (await predicate()) return
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    throw new Error("Desktop UI assertion deadline")
  }
  const click = (label: string) =>
    evaluate(
      "Array.from(document.querySelectorAll('button')).find(b=>b.textContent===" +
        JSON.stringify(label) +
        ").click()"
    )
  try {
    await owner.loadFile(page)
    await wait(() => evaluate("document.body.textContent.includes('打开交互')"))
    assert.equal(await evaluate("document.querySelector('iframe')===null"), true)
    await assert.rejects(
      service.mount(owner.webContents.id, {
        sessionId: "session",
        instanceId: instance.instanceId,
        surface: "session-sidebar",
      }),
      /plugin_ui_surface_not_supported/
    )
    await click("打开交互")
    await wait(() => evaluate("document.querySelector('iframe')!==null"))
    await wait(async () => !!(await currentPluginUiFrame(owner)))
    const frame = (await currentPluginUiFrame(owner))!
    await wait(() =>
      frame.executeJavaScript("document.querySelector('#status')?.textContent==='1'")
    )
    await frame.executeJavaScript(
      "document.querySelector('#local').value='local input';document.querySelector('#apply').click()"
    )
    await wait(() => evaluate("document.body.textContent.includes('确认执行')"))
    assert.equal(admitted.length, 0)
    assert.equal(await evaluate("document.body.textContent.includes('实际工具：Inspect')"), true)
    await click("返回")
    await wait(() =>
      frame.executeJavaScript(
        "document.querySelector('#result')?.textContent==='plugin_ui_user_cancelled'"
      )
    )
    assert.equal(admitted.length, 0)
    assert.equal(
      await frame.executeJavaScript("document.querySelector('#local').value"),
      "local input"
    )
    await frame.executeJavaScript("document.querySelector('#apply').click()")
    await wait(() => evaluate("document.body.textContent.includes('确认执行')"))
    await click("确认执行")
    await wait(() =>
      frame.executeJavaScript(
        "document.querySelector('#result')?.textContent==='fixture_once' && document.querySelector('#status')?.textContent==='2'"
      )
    )
    assert.equal(admitted.length, 1)
    assert.equal(admitted[0]!.expectedRevision, 1)
    await click("关闭显示")
    await wait(() => evaluate("document.querySelector('iframe')===null"))
    await click("打开交互")
    await wait(() => evaluate("document.querySelector('iframe')!==null"))
    await wait(async () => !!(await currentPluginUiFrame(owner)))
    const reopened = (await currentPluginUiFrame(owner))!
    await wait(() =>
      reopened.executeJavaScript("document.querySelector('#status')?.textContent==='2'")
    )
    assert.equal(await reopened.executeJavaScript("document.querySelector('#local').value"), "")
    await click("关闭显示")
    await wait(() => evaluate("document.querySelector('iframe')===null"))
  } finally {
    await owner.loadURL("about:blank")
    service.dispose()
    for (const { channel } of handlers) ipcMain.removeHandler(channel)
    ipcMain.removeHandler(IpcChannels.sessionUpdateAck)
    ipcMain.removeHandler(IpcChannels.sessionUpdateResync)
  }
  return { actionAdmissions: admitted.length, fixedSurfaceRejected: true, closeResetsInput: true }
}
