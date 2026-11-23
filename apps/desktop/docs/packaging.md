# 桌面安装包：为什么会慢、怎么保持快

`pnpm build:win` 里，Vite 打 JS 通常几分钟内结束。真正容易“卡住”的是后面的 **electron-builder 收 node_modules**：它会按 `package.json` 的 production `dependencies` 走完整棵 pnpm 依赖树，再拷进 `dist/win-unpacked`。pnpm 是大量 junction，Windows 上再叠加 Defender 扫盘，这一步可以耗很久。

## 现在的分工

安装包里只需要运行时还 `require` 得着、又打不进 JS 的东西。

| 放哪里 | 放什么 | 为什么 |
|---|---|---|
| `dependencies` | `better-sqlite3`、`node-pty`、`sharp`、`electron-updater`、`electron-log` | C++ 插件和更新器运行时不能打进主进程 bundle；`install-app-deps` 只重编原生模块 |
| `devDependencies` | React、Tailwind、图标、workspace 包、electron-vite 等 | 开发期用；渲染进程和主进程 JS 已经打进 `out/` |
| `electron-builder.yml` 的 `files` | `out/**`、`resources/**`、`package.json` | 不要默认拷整个 `apps/desktop` |

Desktop 主进程使用 `@rzx/client`、`@vykor/daemon-admin`、`@vykor/protocol` 和 `@vykor/server` 的指定入口。主进程把 daemon 及其执行环境、终端等依赖打进 `out/main`。渲染与 preload 使用公开 SDK 和协议中的数据定义，管理请求经主进程 IPC 发出。SQLite 迁移文件由 `electron.vite.config.ts` 拷到 `out/session-runtime/migrations`，运行时从 `out/main/index.js` 相对定位。原生模块保持外置，asar 里再解开 `prebuilds` / `build`。

正式发布时，各平台会从实际生成的 `dist/*-unpacked/resources/app.asar` 读取 migration，生成 `clean-slate-migrations-<platform>.json`。Tag 创建前必须同时拿到 Windows 和 Linux inventory，确认包含基线与全部增量迁移（`.sql` 与 `meta/*.json`，清单从源迁移目录推导），并且两边文件哈希一致；只检查构建目录 `out/` 不算发布产物验证。

## 不要把这些加回 `dependencies`

- 渲染层 UI 包（`react`、`lucide-react`、`@lobehub/icons`、`streamdown`…）。窗口页面已经在 `out/renderer`。
- `@vykor/server`、`@vykor/core` 以及其它 workspace 包。放进 production 依赖后，builder 会顺着链接扫完整棵 monorepo，又回到“搜索 node modules 停很久”；主进程还会按 CJS `require` 外置加载，而 workspace 包的 `exports` 通常只有 `import`，会直接炸成 `ERR_PACKAGE_PATH_NOT_EXPORTED`。
- Tailwind / lightningcss 的全平台可选二进制。它们是构建工具，不是运行时。

以后主进程如果真的要运行时 `require` 某个 npm 包，再把它放进 `dependencies`，并确认 Vite 没有把它打进 bundle（原生模块用 `externalizeDeps.include`）。

`electron.vite.config.ts` 中保留 `terminal` / `terminal-node` 的 `externalizeDeps.exclude`，是为了打包 server 的传递实现，并不表示 Desktop 可以直接导入它们。`scripts/verify-workspace-boundaries.mjs` 会检查 package.json 和源码导入边界。

当前 migration 仍从 `packages/services` 复制，这是已知的构建期隐藏耦合，本轮依赖收敛不处理。

## 日常怎么打

`build` 会先通过 Turbo 按依赖顺序构建 Desktop 的 workspace 依赖，再检查类型并生成 `out/`；未变化的依赖复用构建缓存。`build:unpack`、`build:win`、`build:mac` 和 `build:linux` 都经过这个入口，避免直接打包时读取到 `agent-runtime/dist` 中的旧类型声明。依赖包的构建产物保存在各包的 `dist/`，安装包仍输出到 Desktop 的 `dist/`。

```bash
# 构建依赖、检查类型并生成桌面 JS
pnpm --filter @vykor/desktop build

# 单独刷新依赖产物，再运行独立类型检查
pnpm --filter @vykor/desktop build:deps
pnpm --filter @vykor/desktop typecheck

# 解包到 dist/win-unpacked，不打 NSIS，够日常看体积和启动
pnpm --filter @vykor/desktop build:unpack

# 真正出 Windows 安装包
pnpm --filter @vykor/desktop build:win
```

`searching for node modules` 之后如果很快出现 `asar` / `win-unpacked`，说明依赖树是瘦的。如果又开始刷 `duplicate dependency references` 和一长串 `antd-style`、`@tailwindcss/oxide-*`，就是有 UI 或 workspace 包被加回了 production 依赖。

Windows 上可以把仓库目录、`apps/desktop/dist`、pnpm store 加进 Defender 排除，拷贝会再快一截。Electron 官方 zip 走 `electron-builder.yml` 里的 npmmirror，下过一次会缓存，不会每次卡在 download。

## Windows 电脑操作资源

`build:win` 准备固定版本的 Cua 驱动并构建 Windows x64 NSIS 安装器。CI 在 Windows 解包后和干净 runner 静默安装后核对驱动文件摘要、x64 架构、Cua 原厂签名与许可证。静默安装还会比较宿主、升级辅助程序与 `app.asar` 的 SHA-256，并检查卸载残留。Linux 构建确认解包目录和 `app.asar` 未包含 Windows 驱动文件。 [资源来源与准备命令](../resources/computer-windows/README.md)

签名试点候选同时启用 `sign_windows` 和 `build_only`，工作流只保留验收制品。仓库 Secret 提供 `WIN_CSC_LINK` 与 `WIN_CSC_KEY_PASSWORD`，仓库变量 `VYKOR_WINDOWS_PUBLISHER` 填签名证书的发布者名称。工作流验证 Vykor 安装器、卸载器、宿主和 `elevate.exe` 的签名。 [发布流程](../../../docs/release-process.md)

本机核对已解包的 Windows 构建，可运行 `pnpm --filter @vykor/desktop verify:computer --artifact dist/win-unpacked/resources`。静默安装验收使用干净 runner 或独立试点机器。试点的开关和应用范围见 [电脑操作说明](../../../docs/computer-capabilities.md)。
