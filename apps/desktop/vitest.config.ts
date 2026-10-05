import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"
import { browserAnnotationSelectorPlugin } from "./scripts/browser-annotation-selector-plugin"

export default defineConfig({
  plugins: [browserAnnotationSelectorPlugin()],
  root: fileURLToPath(new URL(".", import.meta.url)),
  resolve: {
    alias: {
      "@renderer": fileURLToPath(new URL("src/renderer/src", import.meta.url)),
      "@main": fileURLToPath(new URL("src/main", import.meta.url)),
      "@shared": fileURLToPath(new URL("src/shared", import.meta.url)),
    },
  },
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    // 路由/页面这类测试要在 beforeAll 里导入整棵 routeTree.gen，turbo 并行跑全量时
    // CPU 争抢会让导入慢数倍（同根目录 vitest.config.ts 的说明）；默认 5s/30s 会在
    // 高负载下偶发超时（非断言失败），这里对齐根配置放宽到 60s 留足余量。
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
})
