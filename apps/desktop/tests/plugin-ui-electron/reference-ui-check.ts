import type { BrowserWindow, WebFrameMain } from "electron"
import { readdirSync } from "node:fs"
import assert from "node:assert/strict"
import type { VykorClient } from "@vykor/client"
import { currentPluginUiFrame } from "./plugin-ui-frame-query"

/** Packaged sample, current SDK and real Native/SQLite; hidden window, behavioral assertions only. */
export async function checkReferenceUi(
  owner: BrowserWindow,
  client: VykorClient,
  ready: { sessionId: string; instanceId: string; root: string },
  modelAttempts: number
) {
  const started = Date.now()
  const checkpoint = (stage: string) =>
    console.log(
      JSON.stringify({ scenario: "reference-ui", stage, elapsedMs: Date.now() - started })
    )
  const evaluate = (source: string) => owner.webContents.executeJavaScript(source)
  const wait = async (predicate: () => Promise<boolean>) => {
    const until = Date.now() + 8000
    while (Date.now() < until) {
      if (await predicate()) return
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    throw new Error("Reference UI assertion deadline")
  }
  const frameReady = async (): Promise<WebFrameMain> => {
    let current: WebFrameMain | undefined
    await wait(async () => {
      const candidate = await currentPluginUiFrame(owner)
      if (
        !candidate ||
        !(await candidate.executeJavaScript("document.querySelector('#preview')?.value.length>0"))
      )
        return false
      current = candidate
      return true
    })
    return current!
  }
  const clickHost = (label: string) =>
    evaluate(
      "Array.from(document.querySelectorAll('button')).find(b=>b.textContent===" +
        JSON.stringify(label) +
        ").click()"
    )
  checkpoint("frame-ready")
  let frame = await frameReady()
  checkpoint("initial-state")
  const initial = await client.pluginUi.get(ready.sessionId, ready.instanceId)
  assert.equal(initial.instance.surface, "session-sidebar")
  assert.equal(await frame.executeJavaScript("document.querySelector('#sidebar')===null"), true)
  assert.equal(
    await frame.executeJavaScript("document.querySelectorAll('input[type=checkbox]').length"),
    2
  )
  assert.equal(await frame.executeJavaScript("document.querySelector('input').disabled"), false)
  checkpoint("appearance")
  const beforeFiles = readdirSync(ready.root).sort()
  await frame.executeJavaScript(
    "document.querySelector('input').click();document.querySelector('#conversation-text').value='local note'"
  )
  const originalId = frame.frameTreeNodeId
  await evaluate(
    "window.originalPluginFrame=document.querySelector('iframe');document.documentElement.classList.add('dark')"
  )
  await wait(() =>
    frame.executeJavaScript("document.documentElement.dataset.theme==='dark'")
  ).catch(async (error) => {
    console.log(
      JSON.stringify({
        stage: "reference appearance failure",
        css: await evaluate(
          "(()=>{const c=getComputedStyle(document.documentElement);return Object.fromEntries(['--background','--foreground','--muted','--muted-foreground','--primary','--primary-foreground','--accent','--border','--destructive','--font-sans','--ui-font-size','font-family'].map(k=>[k,c.getPropertyValue(k)]))})()"
        ),
      })
    )
    throw error
  })
  assert.equal(
    (await client.pluginUi.get(ready.sessionId, ready.instanceId)).instance.revision,
    initial.instance.revision
  )
  assert.equal(
    await frame.executeJavaScript(
      "document.querySelector('input').checked && document.querySelector('#conversation-text').value==='local note'"
    ),
    true
  )
  checkpoint("hide-show")
  await clickHost("隐藏侧栏")
  await wait(() => frame.executeJavaScript("document.querySelector('#draft').hidden"))
  assert.equal(
    await evaluate("document.querySelector('iframe')===window.originalPluginFrame"),
    true
  )
  assert.equal(owner.webContents.mainFrame.frames[0]!.frameTreeNodeId, originalId)
  assert.equal(
    await frame.executeJavaScript("document.querySelector('#conversation-text').value"),
    "local note"
  )
  await clickHost("显示侧栏")
  await wait(() => frame.executeJavaScript("!document.querySelector('#draft').hidden"))
  checkpoint("preview-cancel")
  await frame.executeJavaScript("document.querySelector('#preview-button').click()")
  await wait(() => evaluate("document.querySelector('[role=alertdialog]')!==null"))
  assert.equal(
    (await client.sessions.getState(ready.sessionId)).runs.filter((run) => run.metadata.uiAction)
      .length,
    0
  )
  await clickHost("返回")
  await wait(() =>
    frame.executeJavaScript("document.querySelector('#status').textContent.includes('已取消')")
  )
  assert.equal(await frame.executeJavaScript("document.querySelector('input').checked"), true)
  await frame.executeJavaScript("document.querySelector('#preview-button').click()")
  await wait(() => evaluate("document.querySelector('[role=alertdialog]')!==null"))
  checkpoint("preview-confirm")
  await clickHost("确认执行")
  await wait(() =>
    frame.executeJavaScript(
      "document.querySelector('#preview').value===" + JSON.stringify("ok\n\titem\n")
    )
  )
  await wait(() =>
    frame.executeJavaScript("document.querySelector('#status').textContent.includes('预览已生成')")
  )
  assert.equal(
    await frame.executeJavaScript("document.querySelectorAll('input:checked').length"),
    0
  )
  const previewState = await client.sessions.getState(ready.sessionId)
  assert.equal(previewState.inputs.length, 1)
  assert.equal(previewState.runs.filter((run) => run.metadata.uiAction).length, 1)
  assert.equal(previewState.attempts.length, modelAttempts)
  assert.deepEqual(
    readdirSync(ready.root).sort(),
    beforeFiles,
    "pure preview creates no workspace file"
  )
  checkpoint("draft")
  // The remaining finding is selected and sent via the actual SDK/host handoff.
  await frame.executeJavaScript(
    "document.querySelector('input').click();document.querySelector('#conversation-text').value='please explain chosen line'"
  )
  await frame.executeJavaScript("document.querySelector('#draft').click()")
  await wait(() => evaluate("document.body.textContent.includes('确认加入输入框')"))
  await clickHost("确认加入输入框")
  await wait(() =>
    frame.executeJavaScript(
      "document.querySelector('#status').textContent.includes('已加入输入框')"
    )
  )
  assert.equal((await client.sessions.getState(ready.sessionId)).inputs.length, 1)
  assert.equal(
    await evaluate(
      "document.querySelector('#composer-draft').textContent.includes('please explain chosen line')"
    ),
    true
  )
  checkpoint("submit-cancel")
  await frame.executeJavaScript(
    "document.querySelector('#conversation-text').value='assistant submit only';document.querySelector('#submit').click()"
  )
  await wait(() => evaluate("document.body.textContent.includes('确认交给助手')"))
  await clickHost("返回")
  await wait(() =>
    frame.executeJavaScript("document.querySelector('#status').textContent.includes('已取消')")
  )
  assert.equal((await client.sessions.getState(ready.sessionId)).inputs.length, 1)
  assert.equal(
    await frame.executeJavaScript("document.querySelector('#conversation-text').value"),
    "assistant submit only"
  )
  await frame.executeJavaScript("document.querySelector('#submit').click()")
  await wait(() => evaluate("document.body.textContent.includes('确认交给助手')"))
  assert.equal(
    await evaluate(
      "document.querySelector('[role=alertdialog]').textContent.includes('please explain chosen line')"
    ),
    false,
    "submit excludes existing composer draft"
  )
  checkpoint("submit-confirm")
  await clickHost("确认交给助手")
  await wait(() =>
    frame.executeJavaScript("document.querySelector('#status').textContent.includes('已交给助手')")
  )
  await wait(async () => (await client.sessions.getState(ready.sessionId)).inputs.length === 2)
  const submitted = await client.sessions.getState(ready.sessionId)
  assert.equal(submitted.runs.filter((run) => run.metadata.uiAction).length, 1)
  assert.equal(submitted.runs.length, previewState.runs.length + 1)
  assert.equal(
    await evaluate(
      "document.querySelector('#composer-draft').textContent.includes('please explain chosen line')"
    ),
    true
  )
  checkpoint("reopen")
  await clickHost("关闭侧栏")
  checkpoint("reopen-wait-close")
  await wait(() => evaluate("document.querySelector('iframe')===null"))
  checkpoint("reopen-click")
  await clickHost("在侧栏打开")
  checkpoint("reopen-wait-frame")
  frame = await frameReady()
  checkpoint("reopen-frame-ready")
  assert.notEqual(frame.frameTreeNodeId, originalId)
  assert.equal(
    await frame.executeJavaScript("document.querySelector('#conversation-text').value"),
    "请解释所选格式问题并给出建议。"
  )
  assert.equal(
    await frame.executeJavaScript("document.querySelectorAll('input:checked').length"),
    0
  )
  assert.equal(await frame.executeJavaScript("document.querySelector('#dismiss').disabled"), true)
  assert.equal(
    (await client.pluginUi.get(ready.sessionId, ready.instanceId)).instance.status,
    "resolved"
  )
  await frame.executeJavaScript("document.querySelector('input').click()")
  assert.equal(
    await frame.executeJavaScript(
      "!document.querySelector('#draft').disabled && document.querySelector('#submit').hidden"
    ),
    true
  )
  await clickHost("关闭侧栏")
  await wait(() => evaluate("document.querySelector('iframe')===null"))
}
