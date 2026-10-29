import type { BrowserWindow } from "electron"

export async function checkMarkdownPerformance(window: BrowserWindow) {
  const run = (code: string) => window.webContents.executeJavaScript(code)
  const sample = async () => {
    const result = (await window.webContents.debugger.sendCommand("Performance.getMetrics")) as {
      metrics: Array<{ name: string; value: number }>
    }
    return Object.fromEntries(result.metrics.map((item) => [item.name, item.value]))
  }
  console.log(
    JSON.stringify({
      phase: "markdown-benchmark",
      streamdown: process.env.VYKOR_STREAMDOWN_VERSION,
      electron: process.versions.electron,
      chromium: process.versions.chrome,
      updates: 8,
      repeats: 3,
    })
  )
  for (let repeat = 0; repeat < 3; repeat++) {
    for (const animation of [true, false]) {
      for (const scenario of ["paragraph", "rich-paragraph", "list"]) {
        const fixture = await run(
          `window.markdownPerformance.prepare(${JSON.stringify(scenario)}, ${animation})`
        )
        const before = await sample()
        const result = await run("window.markdownPerformance.measure(8)")
        const after = await sample()
        const completion = await run("window.markdownPerformance.finish()")
        console.log(
          JSON.stringify({
            scenario,
            repeat,
            animation,
            fixture,
            result,
            completion,
            mainThreadMs: Object.fromEntries(
              ["TaskDuration", "ScriptDuration", "LayoutDuration", "RecalcStyleDuration"].map(
                (name) => [name, +((after[name] - before[name]) * 1000).toFixed(3)]
              )
            ),
          })
        )
      }
    }
  }
}
