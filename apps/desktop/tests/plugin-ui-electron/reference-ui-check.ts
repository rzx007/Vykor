import type { BrowserWindow, WebFrameMain } from "electron"
import { mkdirSync, writeFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import assert from "node:assert/strict"
import type { VykorClient } from "@vykor/client"

/** Real packaged sample, real SDK, trusted host confirmation, and real Native/SQLite. */
export async function checkReferenceUi(
  owner: BrowserWindow,
  client: VykorClient,
  ready: { sessionId: string; instanceId: string; root: string },
  modelAttempts: number,
  root: string
) {
  const evaluate = (source: string) => owner.webContents.executeJavaScript(source)
  const wait = async (predicate: () => Promise<boolean>) => {
    const end = Date.now() + 8000
    while (Date.now() < end) {
      if (await predicate()) return
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    throw new Error("Reference UI assertion deadline")
  }
  const frameReady = async (): Promise<WebFrameMain> => {
    await wait(async () => {
      const frame = owner.webContents.mainFrame.frames[0]
      return (
        !!frame &&
        (await frame.executeJavaScript("document.querySelector('#preview')?.value.length>0"))
      )
    })
    return owner.webContents.mainFrame.frames[0]!
  }
  owner.webContents.debugger.attach("1.3")
  const key = async (code: "Space" | "Enter" | "Tab" | "Escape") => {
    const params =
      code === "Space"
        ? { key: " ", code, windowsVirtualKeyCode: 32, text: " " }
        : code === "Enter"
          ? { key: "Enter", code, windowsVirtualKeyCode: 13, text: "\r" }
          : { key: code, code, windowsVirtualKeyCode: code === "Tab" ? 9 : 27, text: undefined }
    await owner.webContents.debugger.sendCommand("Input.dispatchKeyEvent", {
      type: "keyDown",
      ...params,
    })
    await owner.webContents.debugger.sendCommand("Input.dispatchKeyEvent", {
      type: "keyUp",
      ...params,
      text: undefined,
    })
  }
  const clickHost = (label: string) =>
    evaluate(
      "Array.from(document.querySelectorAll('button')).find(b=>b.textContent===" +
        JSON.stringify(label) +
        ").click()"
    )
  let frame = await frameReady()
  assert.equal(
    await frame.executeJavaScript("document.querySelectorAll('input[type=checkbox]').length"),
    2
  )
  const initial = await client.pluginUi.get(ready.sessionId, ready.instanceId)
  assert.equal(
    await frame.executeJavaScript("document.querySelector('input[type=checkbox]').disabled"),
    false,
    JSON.stringify({
      availability: initial.availability,
      actions: initial.actions.map((action) => action.id),
      ui: await frame.executeJavaScript(
        "({status:document.querySelector('#status').textContent,preview:document.querySelector('#preview-button').disabled})"
      ),
    })
  )
  const beforeFiles = readdirSync(ready.root).sort()
  // Windows suppresses cross-frame dialog autofocus in a never-shown window.
  // Activate this isolated fixture off-screen; never touch the user's desktop app.
  owner.setPosition(-10000, -10000)
  owner.show()
  owner.focus()
  await evaluate(
    "window.testKeys=[];document.addEventListener('keydown',e=>testKeys.push({key:e.key,code:e.code,tag:e.target.tagName}),true)"
  )
  await frame.executeJavaScript(
    "window.testKeys=[];document.addEventListener('keydown',e=>testKeys.push({key:e.key,code:e.code,tag:e.target.tagName}),true)"
  )
  // Focus only selects the target; Chromium's native key events actually toggle and submit.
  owner.webContents.focus()
  await evaluate("document.querySelector('iframe').focus()")
  await frame.executeJavaScript("document.querySelector('input[type=checkbox]').focus()", true)
  await key("Space")
  await wait(() =>
    frame.executeJavaScript("document.querySelector('input[type=checkbox]').checked")
  ).catch(async (error) => {
    throw new Error(
      String(error) +
        " keyboard focus: " +
        JSON.stringify(
          await frame.executeJavaScript(
            "({focused:document.hasFocus(),active:document.activeElement.tagName,checked:document.querySelector('input[type=checkbox]').checked})"
          )
        )
    )
  })
  await key("Tab")
  assert.equal(await frame.executeJavaScript("document.activeElement.value"), "2:tab-indentation")
  await key("Tab")
  assert.equal(await frame.executeJavaScript("document.activeElement.id"), "preview-button")
  await key("Enter")
  await wait(() => evaluate("document.querySelector('[role=alertdialog]')!==null"))
  assert.equal(
    (await client.sessions.getState(ready.sessionId)).runs.filter((run) => run.metadata.uiAction)
      .length,
    0
  )
  await wait(() => evaluate("document.activeElement.textContent==='返回'")).catch(async (error) => {
    throw new Error(
      String(error) +
        " dialog focus: " +
        JSON.stringify(
          await evaluate(
            "({focused:document.hasFocus(),active:document.activeElement.tagName,text:document.activeElement.textContent,visible:!!document.querySelector('[role=alertdialog]')})"
          )
        )
    )
  })
  assert.equal(
    await evaluate("document.activeElement.textContent"),
    "返回",
    "safe cancel has default focus"
  )
  await key("Enter")
  await wait(() =>
    frame.executeJavaScript("document.querySelector('#status').textContent.includes('已取消')")
  ).catch(async (error) => {
    throw new Error(
      String(error) +
        " cancel state: " +
        JSON.stringify({
          author: await frame.executeJavaScript(
            "({status:document.querySelector('#status').textContent,active:document.activeElement.tagName})"
          ),
          host: await evaluate(
            "({dialog:!!document.querySelector('[role=alertdialog]'),active:document.activeElement.textContent,keys:window.testKeys})"
          ),
          childKeys: await frame.executeJavaScript("window.testKeys"),
        })
    )
  })
  assert.equal(
    (await client.sessions.getState(ready.sessionId)).runs.filter((run) => run.metadata.uiAction)
      .length,
    0
  )
  await frame.executeJavaScript("document.querySelector('#preview-button').focus()")
  await key("Enter")
  await wait(() => evaluate("document.querySelector('[role=alertdialog]')!==null"))
  await wait(() => evaluate("document.activeElement.textContent==='返回'"))
  await key("Escape")
  await wait(() => evaluate("document.querySelector('[role=alertdialog]')===null"))
  await wait(() =>
    frame.executeJavaScript("document.querySelector('#status').textContent.includes('已取消')")
  )
  assert.equal(
    (await client.sessions.getState(ready.sessionId)).runs.filter((run) => run.metadata.uiAction)
      .length,
    0
  )
  await frame.executeJavaScript("document.querySelector('#preview-button').focus()")
  await key("Enter")
  await wait(() => evaluate("document.querySelector('[role=alertdialog]')!==null"))
  await wait(() => evaluate("document.activeElement.textContent==='返回'"))
  await evaluate(
    "Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='确认执行').focus()"
  )
  await wait(() => evaluate("document.activeElement.textContent==='确认执行'"))
  await key("Enter")
  await wait(() =>
    frame.executeJavaScript(
      "document.querySelector('#preview').value===" + JSON.stringify("ok\n\titem\n")
    )
  ).catch(async (error) => {
    const state = await client.sessions.getState(ready.sessionId)
    throw new Error(
      String(error) +
        " preview state: " +
        JSON.stringify({
          uiRuns: state.runs
            .filter((run) => run.metadata.uiAction)
            .map((run) => ({ status: run.status })),
          author: await frame.executeJavaScript(
            "({status:document.querySelector('#status').textContent,length:document.querySelector('#preview').value.length})"
          ),
          host: await evaluate(
            "({dialog:!!document.querySelector('[role=alertdialog]'),active:document.activeElement.textContent,keys:window.testKeys})"
          ),
        })
    )
  })
  await wait(() =>
    frame.executeJavaScript("document.querySelector('#status').textContent.includes('预览已生成')")
  )
  assert.equal(await frame.executeJavaScript("document.querySelector('#preview').readOnly"), true)
  assert.equal(
    await frame.executeJavaScript("document.querySelectorAll('input:checked').length"),
    0
  )
  const state = await client.sessions.getState(ready.sessionId)
  assert.equal(state.inputs.length, 1)
  assert.equal(state.runs.filter((run) => run.metadata.uiAction).length, 1)
  assert.equal(state.attempts.length, modelAttempts)
  assert.deepEqual(
    readdirSync(ready.root).sort(),
    beforeFiles,
    "pure preview creates no workspace file"
  )
  const screenshots = join(root, ".superpowers/sdd/2026-10-04-native-plugin-ui-a4/screenshots")
  mkdirSync(screenshots, { recursive: true })
  for (const [width, theme, filename] of [
    [1000, "light", "wide-light.png"],
    [420, "light", "narrow-light.png"],
    [1000, "dark", "wide-dark.png"],
    [420, "dark", "narrow-dark.png"],
  ] as const) {
    owner.setContentSize(width, 950)
    await evaluate(
      "document.documentElement.classList.toggle('dark'," + String(theme === "dark") + ")"
    )
    await wait(() =>
      frame.executeJavaScript("document.documentElement.dataset.theme===" + JSON.stringify(theme))
    )
    assert.equal(
      await frame.executeJavaScript("document.documentElement.scrollWidth<=innerWidth"),
      true,
      filename + " has no horizontal overflow"
    )
    await evaluate("window.scrollTo(0,0)")
    await new Promise((resolve) => setTimeout(resolve, 100))
    writeFileSync(join(screenshots, filename), (await owner.webContents.capturePage()).toPNG())
  }
  await frame.executeJavaScript("document.querySelector('#sidebar').click()")
  await wait(() =>
    evaluate("document.querySelector('[aria-label=\"插件交互侧栏\"] iframe')!==null")
  )
  frame = await frameReady()
  assert.equal(
    await frame.executeJavaScript("document.querySelector('#preview').value"),
    "ok\n\titem\n"
  )
  await clickHost("关闭侧栏")
  await wait(() => evaluate("document.querySelector('iframe')===null"))
  await wait(() => evaluate("document.activeElement.textContent==='打开交互'"))
  await clickHost("打开交互")
  frame = await frameReady()
  await frame.executeJavaScript("document.querySelector('#dismiss').click()")
  await wait(() => evaluate("document.querySelector('[role=alertdialog]')!==null"))
  await clickHost("确认取消")
  await wait(() => frame.executeJavaScript("document.querySelector('#dismiss').disabled"))
  assert.equal(
    (await client.pluginUi.get(ready.sessionId, ready.instanceId)).instance.status,
    "dismissed"
  )
  assert.equal(
    (await client.sessions.getState(ready.sessionId)).runs.filter((run) => run.metadata.uiAction)
      .length,
    1
  )
  assert.equal(
    await frame.executeJavaScript("document.querySelector('#preview-button').disabled"),
    true
  )
  await clickHost("关闭显示")
  await wait(() => evaluate("document.querySelector('iframe')===null"))
  owner.webContents.debugger.detach()
  owner.hide()
}
