import { app, BrowserWindow } from "electron"
import { join } from "node:path"
import assert from "node:assert/strict"

app.setPath("userData", process.env.VYKOR_CONVERSATION_PROFILE!)
app.setPath("sessionData", process.env.VYKOR_CONVERSATION_PROFILE!)
app.commandLine.appendSwitch("disable-gpu")
const deadline = setTimeout(() => app.exit(2), 120_000)
void (async () => {
  await app.whenReady()
  const window = new BrowserWindow({
    show: false,
    width: 1000,
    height: 700,
    webPreferences: {
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false,
      offscreen: true,
    },
  })
  window.webContents.setFrameRate(60)
  window.webContents.on("console-message", (_event, level, message) => {
    if (level >= 2) console.error(message)
  })
  window.webContents.on("render-process-gone", (_event, details) =>
    console.error("renderer exited", details)
  )
  try {
    await window.loadFile(join(__dirname, "../renderer/host.html"))
    console.log(JSON.stringify({ phase: "loaded" }))
    const run = (code: string) => window.webContents.executeJavaScript(code)
    await window.webContents.debugger.attach("1.3")
    await window.webContents.debugger.sendCommand("Performance.enable")
    const sample = async () => {
      const result = (await window.webContents.debugger.sendCommand("Performance.getMetrics")) as {
        metrics: Array<{ name: string; value: number }>
      }
      return Object.fromEntries(result.metrics.map((item) => [item.name, item.value]))
    }
    for (const count of [1000, 10000]) {
      await run(`window.transcriptPerformance.prepare(${count})`)
      console.log(JSON.stringify({ phase: "prepared", history: count }))
      const before = await sample()
      const growth = await run("window.transcriptPerformance.grow(100)")
      const after = await sample()
      const regression = await run("window.transcriptPerformance.regress()")
      assert.equal(regression.passed, true)
      console.log(
        JSON.stringify({
          history: count,
          growth,
          regression,
          chromium: Object.fromEntries(
            [
              "ScriptDuration",
              "LayoutDuration",
              "RecalcStyleDuration",
              "TaskDuration",
              "LayoutCount",
              "RecalcStyleCount",
            ].map((name) => [name, +(after[name] - before[name]).toFixed(6)])
          ),
        })
      )
    }
    window.setSize(1500, 700)
    await window.loadFile(join(__dirname, "../renderer/panels.html"))
    for (const count of [1000, 10000]) {
      await run(`window.panelPerformance.prepare(${count})`)
      for (const target of ["sidebar", "utility"]) {
        const before = await sample()
        const panel = await run(`window.panelPerformance.toggle('${target}')`)
        const after = await sample()
        console.log(
          JSON.stringify({
            scenario: "panel-toggle-stream",
            history: count,
            target,
            panel,
            chromium: Object.fromEntries(
              ["ScriptDuration", "LayoutDuration", "LayoutCount"].map((name) => [
                name,
                +(after[name] - before[name]).toFixed(6),
              ])
            ),
          })
        )
      }
      for (const target of ["sidebar", "utility"]) {
        const point = await run(`window.panelPerformance.separatorInfo('${target}')`)
        await window.webContents.debugger.sendCommand("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: point.x,
          y: point.y,
        })
        await window.webContents.debugger.sendCommand("Input.dispatchMouseEvent", {
          type: "mousePressed",
          x: point.x,
          y: point.y,
          button: "left",
          buttons: 1,
          clickCount: 1,
        })
        for (let step = 1; step <= 5; step++) {
          await window.webContents.debugger.sendCommand("Input.dispatchMouseEvent", {
            type: "mouseMoved",
            x: point.x + step * 6,
            y: point.y,
            button: "left",
            buttons: 1,
          })
          await run("window.panelPerformance.growFrame()")
        }
        await window.webContents.debugger.sendCommand("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          x: point.x + 30,
          y: point.y,
          button: "left",
          buttons: 0,
          clickCount: 1,
        })
        await run(`window.panelPerformance.resized('${target}', ${point.width})`)
        const keyboard = await run(`window.panelPerformance.separatorInfo('${target}')`)
        await window.webContents.debugger.sendCommand("Input.dispatchKeyEvent", {
          type: "keyDown",
          key: "ArrowRight",
          code: "ArrowRight",
          windowsVirtualKeyCode: 39,
        })
        await window.webContents.debugger.sendCommand("Input.dispatchKeyEvent", {
          type: "keyUp",
          key: "ArrowRight",
          code: "ArrowRight",
          windowsVirtualKeyCode: 39,
        })
        await run(`window.panelPerformance.resized('${target}', ${keyboard.width})`)
        console.log(
          JSON.stringify({
            scenario: "panel-pointer-keyboard",
            history: count,
            target,
            passed: true,
          })
        )
      }
      console.log(
        JSON.stringify({
          scenario: "panel-regression",
          history: count,
          result: await run("window.panelPerformance.regress()"),
        })
      )
    }
    console.log(JSON.stringify({ result: "passed" }))
    clearTimeout(deadline)
    window.destroy()
    app.exit(0)
  } catch (error) {
    console.error(error)
    clearTimeout(deadline)
    window.destroy()
    app.exit(1)
  }
})()
