import { cpSync, rmSync } from "node:fs"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { defineConfig } from "electron-vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import { tanstackRouter } from "@tanstack/router-plugin/vite"
import type { Plugin } from "vite"
import { browserAnnotationSelectorPlugin } from "./scripts/browser-annotation-selector-plugin"
import { buildDocumentPreview } from "./scripts/document-preview-build"

function copyRuntimeResources(): Plugin {
  return {
    name: "copy-runtime-resources",
    async writeBundle(options) {
      const outputDirectory = resolve(options.dir ?? "out/main")
      const { prepareOfficeEngine } = await import(pathToFileURL(resolve("../../scripts/prepare-office-engine.mjs")).href)
      await prepareOfficeEngine(resolve(outputDirectory, "../office-engine"))
      const migrationsDirectory = resolve(outputDirectory, "../session-runtime/migrations")
      rmSync(migrationsDirectory, { recursive: true, force: true })
      cpSync(
        resolve("../../packages/services/src/session-runtime/migrations"),
        migrationsDirectory,
        { recursive: true }
      )
      cpSync(
        resolve("../../packages/agent-runtime/src/node/plugins/native-tools/host-entry.mjs"),
        resolve(outputDirectory, "host-entry.mjs")
      )
    },
  }
}

export default defineConfig({
  main: {
    resolve: {
      alias: [
        { find: "@main", replacement: resolve("src/main") },
        { find: "@shared", replacement: resolve("src/shared") },
        // 与 server 的工作区源码一起构建，避免混用旧 dist 导致新增导出缺失。
        {
          find: /^@vykor\/agent-runtime$/,
          replacement: resolve("../../packages/agent-runtime/src/index.ts"),
        },
      ],
    },
    plugins: [
      { name: "build-document-preview", buildStart: buildDocumentPreview },
      copyRuntimeResources(), browserAnnotationSelectorPlugin(),
    ],
    build: {
      externalizeDeps: {
        // workspace 包打进主进程 bundle，安装包就不必再拷整棵 monorepo 依赖树
        exclude: [
          "@electron-toolkit/utils",
          "@vykor/application-client",
          "@rzx/client",
          "@vykor/server",
          "@vykor/terminal",
          "@vykor/terminal-node",
        ],
        // 原生模块不能打进 JS；飞书 SDK 整体外置，让它的依赖（protobufjs/ws 等）
        // 由 SDK 自己的 node_modules 解析，避免子路径 require 在 bundle 里解析不到。
        include: [
          "@larksuiteoapi/node-sdk",
          "better-sqlite3",
          "electron-log",
          "electron-updater",
          "node-pty",
        ],
      },
    },
  },
  preload: {
    build: {
      externalizeDeps: {
        exclude: ["@electron-toolkit/preload"],
      },
    },
  },
  renderer: {
    worker: {
      format: "es",
    },
    resolve: {
      alias: {
        "@renderer": resolve("src/renderer/src"),
        "@main": resolve("src/main"),
        "@shared": resolve("src/shared"),
      },
    },
    plugins: [
      tanstackRouter({
        target: "react",
        autoCodeSplitting: true,
        routesDirectory: "./src/routes",
        generatedRouteTree: "./src/routeTree.gen.ts",
      }),
      react(),
      tailwindcss(),
    ],
  },
})
