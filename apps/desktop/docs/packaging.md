# 桌面安装包：为什么会慢、怎么保持快

`pnpm build:win` 里，Vite 打 JS 通常几分钟内结束。真正容易“卡住”的是后面的 **electron-builder 收 node_modules**：它会按 `package.json` 的 production `dependencies` 走完整棵 pnpm 依赖树，再拷进 `dist/win-unpacked`。pnpm 是大量 junction，Windows 上再叠加 Defender 扫盘，这一步可以耗很久。

## 现在的分工

安装包里只需要运行时还 `require` 得着、又打不进 JS 的东西。

| 放哪里 | 放什么 | 为什么 |
|---|---|---|
| `dependencies` | `better-sqlite3`、`node-pty`、`sharp`、`electron-updater`、`electron-log` | C++ 插件和更新器运行时不能打进主进程 bundle；`install-app-deps` 只重编原生模块 |
| `devDependencies` | React、Tailwind、图标、workspace 包、electron-vite 等 | 开发期用；渲染进程和主进程 JS 已经打进 `out/` |
| `electron-builder.yml` 的 `files` | `out/**`、`resources/**`、`package.json` | 不要默认拷整个 `apps/desktop` |

Desktop 只直接依赖 `@openharness/client` 和 `@openharness/server`。主进程把 server 及其 `core`、`sandbox`、`terminal-node` 等传递实现打进 `out/main`；renderer/preload 不允许导入 server。SQLite 迁移文件仍由 `electron.vite.config.ts` 拷到 `out/session-runtime/migrations`，以匹配 bundle 后迁移加载器相对于 `out/main/index.js` 的路径。原生模块保持外置，asar 里再解开 `prebuilds` / `build`。

## 不要把这些加回 `dependencies`

- 渲染层 UI 包（`react`、`lucide-react`、`@lobehub/icons`、`streamdown`…）。窗口页面已经在 `out/renderer`。
- `@openharness/server`、`@openharness/core` 以及其它 workspace 包。放进 production 依赖后，builder 会顺着链接扫完整棵 monorepo，又回到“搜索 node modules 停很久”；主进程还会按 CJS `require` 外置加载，而 workspace 包的 `exports` 通常只有 `import`，会直接炸成 `ERR_PACKAGE_PATH_NOT_EXPORTED`。
- Tailwind / lightningcss 的全平台可选二进制。它们是构建工具，不是运行时。

以后主进程如果真的要运行时 `require` 某个 npm 包，再把它放进 `dependencies`，并确认 Vite 没有把它打进 bundle（原生模块用 `externalizeDeps.include`）。

`electron.vite.config.ts` 中保留 `terminal` / `terminal-node` 的 `externalizeDeps.exclude`，是为了打包 server 的传递实现，并不表示 Desktop 可以直接导入它们。`scripts/verify-workspace-boundaries.mjs` 会检查 package.json 和源码导入边界。

当前 migration 仍从 `packages/services` 复制，这是已知的构建期隐藏耦合，本轮依赖收敛不处理。

## 日常怎么打

```bash
# 只验证 JS 能不能编过
pnpm --filter @openharness/desktop exec electron-vite build

# 解包到 dist/win-unpacked，不打 NSIS，够日常看体积和启动
pnpm --filter @openharness/desktop build:unpack

# 真正出 Windows 安装包
pnpm --filter @openharness/desktop build:win
```

`searching for node modules` 之后如果很快出现 `asar` / `win-unpacked`，说明依赖树是瘦的。如果又开始刷 `duplicate dependency references` 和一长串 `antd-style`、`@tailwindcss/oxide-*`，就是有 UI 或 workspace 包被加回了 production 依赖。

Windows 上可以把仓库目录、`apps/desktop/dist`、pnpm store 加进 Defender 排除，拷贝会再快一截。Electron 官方 zip 走 `electron-builder.yml` 里的 npmmirror，下过一次会缓存，不会每次卡在 download。
