import { BrowserWindow, ipcMain } from "electron"
import { createHash } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import assert from "node:assert/strict"
import { VykorClient } from "@vykor/client"
import { DesktopPluginUiService } from "../../src/main/features/plugin-ui/plugin-ui-service"
import { createPluginUiIpcContribution } from "../../src/main/features/plugin-ui/ipc"
import type { PluginUiDocumentStore } from "../../src/main/features/plugin-ui/document-store"
import { IpcEvents } from "../../src/shared/ipc-channels"
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
    '<p id="status">waiting</p><button id="apply">Apply</button><p id="result"></p><script>' +
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
          features: { pluginUi: 1, pluginUiLifecycle: 1 },
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
        owner.webContents.send(IpcEvents.sessionUpdated, state())
      } else
        value = {
          instance: { ...instance, revision, data: { count: revision } },
          availability: { code: "available", canRender: true, canInvoke: true },
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
    ".superpowers/sdd/2026-10-03-native-plugin-ui-a3/electron-build/renderer/tests/plugin-ui-electron/ui-host.html"
  )
  service.registerOwner(owner.webContents, pathToFileURL(page).href)
  const handlers = createPluginUiIpcContribution(() => service).register({} as never)
  for (const { channel, handler } of handlers) ipcMain.handle(channel, handler)
  const captures = join(root, ".superpowers/sdd/2026-10-03-native-plugin-ui-a3/ui-captures")
  mkdirSync(captures, { recursive: true })
  const evaluate = <T>(source: string): Promise<T> => owner.webContents.executeJavaScript(source)
  const wait = async (source: string) => {
    const until = Date.now() + 5000
    while (Date.now() < until) {
      if (await evaluate<boolean>(source)) return
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    throw new Error("Desktop UI assertion deadline: " + source)
  }
  const click = async (label: string) =>
    evaluate(
      "Array.from(document.querySelectorAll('button')).find(b=>b.textContent===" +
        JSON.stringify(label) +
        ").click()"
    )
  const capture = async (name: string, width: number, dark: boolean) => {
    owner.setContentSize(width, 760)
    await evaluate("document.documentElement.classList.toggle('dark'," + dark + ")")
    await evaluate(
      "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))"
    )
    if (name.startsWith("confirmation")) {
      assert.equal(
        await evaluate<boolean>(
          "(()=>{const e=document.querySelector('[role=alertdialog]');return !!e&&getComputedStyle(e).opacity==='1'&&e.getBoundingClientRect().width>0})()"
        ),
        true
      )
    }
    writeFileSync(join(captures, name + ".png"), (await owner.webContents.capturePage()).toPNG())
    assert.equal(
      await evaluate<boolean>("document.documentElement.scrollWidth<=innerWidth"),
      true,
      "no horizontal overflow"
    )
  }
  try {
    await owner.loadFile(page)
    await wait("document.body.textContent.includes('打开交互')")
    await evaluate(
      "const settled=document.createElement('style');settled.textContent='*,*::before,*::after{animation:none!important;transition:none!important}';document.head.append(settled)"
    )
    assert.equal(await evaluate("document.querySelector('iframe')===null"), true)
    await capture("card-desktop", 1440, false)
    await capture("card-compact-dark", 390, true)
    await click("打开交互")
    await wait("document.querySelector('iframe')!==null")
    const frame = owner.webContents.mainFrame.frames[0]!
    const childWait = async (source: string) => {
      const until = Date.now() + 5000
      while (Date.now() < until) {
        if (await frame.executeJavaScript(source)) return
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      throw new Error("actual SDK deadline")
    }
    await childWait("document.querySelector('#status')?.textContent==='1'")
    await frame.executeJavaScript("document.querySelector('#apply').click()")
    await wait("document.body.textContent.includes('确认执行')")
    assert.equal(admitted.length, 0)
    assert.equal(await evaluate("document.body.textContent.includes('实际工具：Inspect')"), true)
    await capture("confirmation-compact-dark", 390, true)
    await capture("confirmation-desktop", 1440, false)
    await click("返回")
    await childWait("document.querySelector('#result')?.textContent==='plugin_ui_user_cancelled'")
    assert.equal(admitted.length, 0)
    await frame.executeJavaScript("document.querySelector('#apply').click()")
    await wait("document.body.textContent.includes('确认执行')")
    await click("确认执行")
    await childWait(
      "document.querySelector('#result')?.textContent==='fixture_once' && document.querySelector('#status')?.textContent==='2'"
    )
    assert.equal(admitted.length, 1)
    assert.equal(admitted[0]!.expectedRevision, 1)
    await click("关闭显示")
    await wait("document.querySelector('iframe')===null")
    assert.equal(admitted.length, 1)
  } finally {
    service.dispose()
    for (const { channel } of handlers) ipcMain.removeHandler(channel)
  }
  return { actionAdmissions: admitted.length, uiCaptures: 4 }
}
