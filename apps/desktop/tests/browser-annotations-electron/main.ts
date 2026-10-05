import { app, BrowserWindow, ipcMain, type WebContents } from "electron"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { mkdirSync, writeFileSync } from "node:fs"
import assert from "node:assert/strict"
import {
  BROWSER_ANNOTATION_WORLD_ID,
  buildAnnotationScript,
} from "../../src/main/features/browser/browser-annotation-script"
import type {
  PageAnnotationCommand,
  PageAnnotationSnapshot,
} from "../../src/shared/browser-annotation"
import { browserAgentService } from "../../src/main/features/browser/browser-agent-service"
import { browserIpcContribution } from "../../src/main/features/browser/ipc"

app.setPath("userData", process.env.VYKOR_ANNOTATION_PROFILE!)
app.setPath("sessionData", process.env.VYKOR_ANNOTATION_PROFILE!)
app.commandLine.appendSwitch("disable-gpu")
const deadline = setTimeout(() => app.exit(2), 55_000)
void (async () => {
  await app.whenReady()
  for (const registration of browserIpcContribution.register({} as never))
    ipcMain.handle(registration.channel, registration.handler)
  const owner = new BrowserWindow({
    show: false,
    width: 800,
    height: 600,
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      webviewTag: true,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
    },
  })
  owner.webContents.on("did-attach-webview", (_event, guest) =>
    browserAgentService.trackGuest(owner.webContents.id, guest)
  )
  owner.webContents.on("will-attach-webview", (_event, preferences) => {
    delete preferences.preload
    preferences.nodeIntegration = false
    preferences.contextIsolation = true
    preferences.sandbox = true
    preferences.backgroundThrottling = false
  })
  try {
    const attached = new Promise<WebContents>((resolve) =>
      owner.webContents.once("did-attach-webview", (_event, guest) => resolve(guest))
    )
    const fixtureRoot = join(
      process.env.VYKOR_ANNOTATION_ROOT!,
      "tests/browser-annotations-electron"
    )
    await owner.loadFile(join(fixtureRoot, "host.html"))
    const guest = await attached
    await guest.loadFile(join(fixtureRoot, "page.html"))
    guest.focus()
    await guest.capturePage()
    const run = (command: PageAnnotationCommand): Promise<PageAnnotationSnapshot> =>
      guest.executeJavaScriptInIsolatedWorld(BROWSER_ANNOTATION_WORLD_ID, [
        { code: buildAnnotationScript(command) },
      ])
    const wait = async (predicate: () => Promise<boolean>) => {
      const started = Date.now()
      while (!(await predicate())) {
        if (Date.now() - started > 2000)
          throw new Error("Real Electron input did not reach its target")
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
    }
    const point = (selector: string) =>
      guest.executeJavaScript(
        `(() => { const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)} })()`
      )
    const click = async (selector: string) => {
      const p = await point(selector)
      guest.sendInputEvent({ type: "mouseMove", ...p })
      guest.sendInputEvent({ type: "mouseDown", ...p, button: "left", clickCount: 1 })
      guest.sendInputEvent({ type: "mouseUp", ...p, button: "left", clickCount: 1 })
    }
    await run({ action: "install", mode: "pick", interactionVersion: 1 })
    await click("#target")
    await wait(async () => Boolean((await run({ action: "read", interactionVersion: 1 })).selected))
    const selected = (await run({ action: "read", interactionVersion: 1 })).selected!
    assert.equal(selected.selector, "#target")
    assert.deepEqual(await guest.executeJavaScript("window.pageActions"), {
      down: 0,
      click: 0,
      submit: 0,
    })
    assert.deepEqual(
      await guest.executeJavaScriptInIsolatedWorld(BROWSER_ANNOTATION_WORLD_ID, [
        { code: "[typeof process, typeof require]" },
      ]),
      ["undefined", "undefined"]
    )
    const p = await point("#scroll")
    guest.sendInputEvent({ type: "mouseMove", ...p })
    guest.sendInputEvent({ type: "mouseWheel", ...p, deltaY: -120, deltaX: 0, canScroll: true })
    await wait(
      async () => (await guest.executeJavaScript("document.getElementById('scroll').scrollTop")) > 0
    )
    await run({ action: "install", mode: "pick", interactionVersion: 2 })
    await click("#frame")
    await wait(
      async () =>
        (await run({ action: "read", interactionVersion: 2 })).selected?.selector === "#frame"
    )
    assert.equal(
      await guest.executeJavaScript("document.getElementById('frame').contentWindow.clicked || 0"),
      0
    )
    for (const zoom of [0.8, 1.25]) {
      guest.setZoomFactor(zoom)
      await run({ action: "install", mode: "pick", interactionVersion: 3 + Math.round(zoom * 100) })
      await click("#target")
      await wait(async () =>
        Boolean(
          (await run({ action: "read", interactionVersion: 3 + Math.round(zoom * 100) })).selected
        )
      )
      const state = await run({ action: "read", interactionVersion: 3 + Math.round(zoom * 100) })
      assert.ok(state.selected)
      const placement = { rect: state.selected!.rect, viewport: state.viewport }
      const result = await owner.webContents.executeJavaScript(`(() => {
      const p=${JSON.stringify(placement)}, view=document.querySelector('webview').getBoundingClientRect(), editor=document.querySelector('#editor');
      editor.style.display='block';editor.style.left=(view.left+p.rect.x*view.width/p.viewport.width)+'px';
      editor.style.top=(view.top+p.rect.y*view.height/p.viewport.height)+'px';editor.focus();
      return {focused:document.activeElement===editor,left:editor.getBoundingClientRect().left,expected:view.left+p.rect.x*view.width/p.viewport.width};
    })()`)
      assert.equal(result.focused, true)
      assert.ok(Math.abs(result.left - result.expected) <= 2)
      await owner.webContents.executeJavaScript("editor.style.display='none'")
    }
    await run({ action: "stop", interactionVersion: 1000 })
    await click("#target")
    await wait(async () => (await guest.executeJavaScript("pageActions.click")) === 1)
    guest.setZoomFactor(1)
    await guest.executeJavaScript("document.querySelector('#target').removeAttribute('id')")
    await run({ action: "install", mode: "pick", interactionVersion: 1001 })
    await click('[data-testid="submit-button"]')
    await wait(async () =>
      Boolean((await run({ action: "read", interactionVersion: 1001 })).selected)
    )
    const semantic = (await run({ action: "read", interactionVersion: 1001 })).selected!
    assert.equal(semantic.locatorKind, "semantic")
    assert.ok(semantic.selector.includes("data-testid"))
    const reloaded = new Promise<void>((resolve) => guest.once("dom-ready", () => resolve()))
    guest.reload()
    await reloaded
    await run({ action: "install", mode: "review", interactionVersion: 1002 })
    const restored = await run({
      action: "syncMarkers",
      interactionVersion: 1002,
      markers: [{ ...semantic, id: "semantic-1", handleId: null }],
    })
    assert.equal(restored.markers[0].status, "visible")
    await run({ action: "stop", interactionVersion: 1003 })
    const captures = join(__dirname, "../captures")
    mkdirSync(captures, { recursive: true })
    const capture = async (name: string) => {
      await owner.webContents.executeJavaScript(
        "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))"
      )
      await owner.webContents.executeJavaScript(
        "Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {})))"
      )
      writeFileSync(join(captures, name + ".png"), (await owner.webContents.capturePage()).toPNG())
    }
    const hostClick = async (selector: string) => {
      await wait(async () =>
        owner.webContents.executeJavaScript(
          `(() => {const el=document.querySelector(${JSON.stringify(selector)});return Boolean(el && !el.disabled)})()`
        )
      )
      await owner.webContents.capturePage()
      const p = await owner.webContents.executeJavaScript(
        `(() => {const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`
      )
      owner.webContents.focus()
      owner.webContents.sendInputEvent({ type: "mouseMove", ...p })
      owner.webContents.sendInputEvent({ type: "mouseDown", ...p, button: "left", clickCount: 1 })
      owner.webContents.sendInputEvent({ type: "mouseUp", ...p, button: "left", clickCount: 1 })
    }
    const query = (selector: string) =>
      owner.webContents.executeJavaScript(
        `Boolean(document.querySelector(${JSON.stringify(selector)}))`
      )
    for (const page of [
      join(fixtureRoot, "page.html"),
      join(__dirname, "../renderer/react-page.html"),
    ]) {
      const ready = new Promise<WebContents>((resolve) =>
        owner.webContents.once("did-attach-webview", (_event, g) => resolve(g))
      )
      await owner.loadFile(join(__dirname, "../renderer/ui-host.html"), {
        query: { page: pathToFileURL(page).href },
      })
      const view = await ready
      owner.webContents.setZoomFactor(1)
      view.setZoomFactor(1)
      await view.capturePage()
      await wait(async () => {
        try {
          return (await browserAgentService.readAnnotations(owner.webContents.id, "qa-browser"))
            .ready
        } catch {
          return false
        }
      })
      await hostClick('[aria-label="选择页面元素添加批注"]')
      await wait(
        async () =>
          (await browserAgentService.readAnnotations(owner.webContents.id, "qa-browser")).mode ===
          "pick"
      )
      const p = await view.executeJavaScript(
        "(() => {const r=document.querySelector('#target').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()"
      )
      view.focus()
      view.sendInputEvent({ type: "mouseMove", ...p })
      view.sendInputEvent({ type: "mouseDown", ...p, button: "left", clickCount: 1 })
      view.sendInputEvent({ type: "mouseUp", ...p, button: "left", clickCount: 1 })
      await wait(async () => query("textarea"))
      owner.webContents.focus()
      await owner.webContents.insertText("请增加按钮周围留白")
      await wait(
        async () =>
          (await owner.webContents.executeJavaScript(
            "document.querySelector('textarea').value"
          )) === "请增加按钮周围留白"
      )
      if (page.endsWith("page.html") && !page.endsWith("react-page.html")) {
        for (const theme of ["light", "dark"]) {
          await owner.webContents.executeJavaScript(
            `window.setAnnotationTestTheme(${JSON.stringify(theme)})`
          )
          await wait(async () =>
            owner.webContents.executeJavaScript(
              `document.documentElement.classList.contains(${JSON.stringify(theme)})`
            )
          )
          await capture("editor-" + theme)
        }
        owner.setSize(420, 600)
        await capture("editor-narrow")
        assert.equal(
          await owner.webContents.executeJavaScript(
            "document.documentElement.scrollWidth <= innerWidth"
          ),
          true
        )
        owner.setSize(800, 600)
      }
      owner.webContents.sendInputEvent({
        type: "keyDown",
        keyCode: "Return",
        modifiers: ["control"],
      })
      owner.webContents.sendInputEvent({ type: "keyUp", keyCode: "Return", modifiers: ["control"] })
      await wait(
        async () =>
          (await browserAgentService.readAnnotations(owner.webContents.id, "qa-browser"))
            .annotations.length === 1
      )
      const observe = {
        sessionId: "annotation-qa",
        cwd: join(process.env.VYKOR_ANNOTATION_ROOT!, "../.."),
        includeScreenshot: false,
        approve: async () => true,
      }
      const observed = await browserAgentService.execute({
        ...observe,
        action: { action: "inspect" },
      })
      const button = observed.elements!.find((element) => element.name === "提交")!
      await browserAgentService.execute({
        ...observe,
        action: { action: "click", elementId: button.id },
      })
      assert.equal(
        await view.executeJavaScript(
          page.endsWith("react-page.html")
            ? "document.body.innerText.includes('页面按钮执行次数：1')"
            : "window.pageActions.click === 1"
        ),
        true,
        "annotation picking must not block Agent Browser actions"
      )
      await wait(async () => query('[aria-label="查看已保存批注"]'))
      await hostClick('[aria-label="查看已保存批注"]')
      await wait(async () => query('[aria-label="定位批注 1"]'))
      await capture(page.endsWith("react-page.html") ? "saved-react" : "saved-html")
      await hostClick('[aria-label="定位批注 1"]')
      assert.equal(
        (await browserAgentService.readAnnotations(owner.webContents.id, "qa-browser"))
          .annotations[0].record.comment,
        "请增加按钮周围留白"
      )
      await hostClick('[aria-label="删除批注 1"]')
      await wait(
        async () =>
          (await browserAgentService.readAnnotations(owner.webContents.id, "qa-browser"))
            .annotations.length === 0
      )
    }
    console.log(
      JSON.stringify({
        result: "passed",
        electron: process.versions.electron,
        checks: [
          "native-selection",
          "no-page-actions",
          "native-inner-scroll",
          "iframe-outer",
          "isolated-world",
          "renderer-editor",
          "80%-125%-zoom",
          "cleanup",
          "finder-semantic-reload",
          "real-BrowserTool-HTML-React",
          "native-typing-save-focus-delete",
          "light-dark-narrow",
        ],
        captures,
      })
    )
    owner.destroy()
    clearTimeout(deadline)
    app.exit(0)
  } catch (error) {
    console.error(
      "Renderer state:",
      await owner.webContents
        .executeJavaScript(
          "({text:document.body.innerText,editor:document.querySelector('textarea')?.value,webview:!!document.querySelector('webview')})"
        )
        .catch(() => "gone")
    )
    console.error(error)
    owner.destroy()
    clearTimeout(deadline)
    app.exit(1)
  }
})().catch((error) => {
  console.error(error)
  clearTimeout(deadline)
  app.exit(1)
})
