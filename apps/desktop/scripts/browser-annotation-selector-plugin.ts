import { build, type Plugin } from "vite"
import { fileURLToPath } from "node:url"
import { createRequire } from "node:module"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"

const PUBLIC_ID = "virtual:browser-annotation-selector"
const INTERNAL_ID = "\0" + PUBLIC_ID
const entry = fileURLToPath(
  new URL("../src/main/features/browser/browser-annotation-selector.ts", import.meta.url)
)
const require = createRequire(import.meta.url)

// 生产、Electron 检查与 Vitest 共用同一个浏览器打包入口。
export function browserAnnotationSelectorPlugin(): Plugin {
  let bundled: Promise<string> | undefined
  return {
    name: "browser-annotation-selector",
    resolveId(id) {
      if (id === PUBLIC_ID) return INTERNAL_ID
    },
    async load(id) {
      if (id !== INTERNAL_ID) return
      this.addWatchFile(entry)
      bundled ??= (async () => {
        const result = await build({
          configFile: false,
          logLevel: "silent",
          build: {
            write: false,
            minify: true,
            target: "chrome142",
            lib: { entry, name: "VykorAnnotationSelector", formats: ["iife"] },
          },
        })
        const output = Array.isArray(result)
          ? result[0].output
          : "output" in result
            ? result.output
            : []
        const chunk = output.find((item) => item.type === "chunk")
        if (!chunk || chunk.type !== "chunk") throw new Error("批注选择器浏览器打包未生成脚本")
        const license = readFileSync(
          join(dirname(require.resolve("@medv/finder/package.json")), "LICENSE"),
          "utf8"
        )
        return `/* @license @medv/finder\n${license}\n*/\n${chunk.code}`
      })()
      return `export default ${JSON.stringify(await bundled)};`
    },
    watchChange(id) {
      if (id === entry) bundled = undefined
    },
  }
}
