import { cpSync, rmSync } from "node:fs"
import { resolve } from "node:path"

import { defineConfig } from "electron-vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import { tanstackRouter } from "@tanstack/router-plugin/vite"
import type { Plugin } from "vite"

function copySessionMigrations(): Plugin {
  return {
    name: "copy-session-migrations",
    writeBundle(options) {
      const outputDirectory = resolve(options.dir ?? "out/main")
      const migrationsDirectory = resolve(outputDirectory, "../session-runtime/migrations")
      rmSync(migrationsDirectory, { recursive: true, force: true })
      cpSync(
        resolve("../../packages/services/src/session-runtime/migrations"),
        migrationsDirectory,
        { recursive: true }
      )
      cpSync(
        resolve("../../packages/agent-runtime/src/native-tools/host-entry.mjs"),
        resolve(outputDirectory, "host-entry.mjs")
      )
    },
  }
}

export default defineConfig({
  main: {
    resolve: {
      alias: {
        "@main": resolve("src/main"),
        "@shared": resolve("src/shared"),
      },
    },
    plugins: [copySessionMigrations()],
    build: {
      externalizeDeps: {
        // workspace 包打进主进程 bundle，安装包就不必再拷整棵 monorepo 依赖树
        exclude: [
          "@electron-toolkit/utils",
          "@vykor/client",
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
