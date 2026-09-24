# Vykor Desktop

## Daemon 常驻

「设置 → 常规 → 后台持续运行」控制用户级 `daemon.autoStart` 和实际系统服务。开启后，当前用户登录时会启动 daemon，异常退出后由操作系统恢复；关闭不会删除会话或定时任务。

真正首次安装且尚未开启常驻时，侧边栏底部会显示一次「保持后台运行」引导。开启成功或选择「暂不开启」后该区域永久消失；升级安装不会补发引导。安装身份和引导状态保存在 Desktop 的 `desktop-preferences.json`，与 `daemon.autoStart` 分开管理。

Desktop 的 Vykor workspace 边界只有两个：所有 HTTP/SSE 操作和协议类型走 `@vykor/client`；内嵌 daemon、registry 和系统启动项等本机能力走 `@vykor/server/daemon-host`。WSL 可用性由 daemon 宿主校验，Desktop 不直接依赖 core、sandbox、terminal 或 terminal-node。

Electron + React desktop shell for Vykor.

## Structure

- `src/main/core`: app context, window manager, IPC registry, lifecycle helpers.
- `src/main/features/main-window`: primary application window behavior.
- `src/main/features/tray`: system tray menu, notification, and tray flash helpers.
- `src/main/features/pet`: transparent desktop Pet window, visibility, click-through, and position persistence.
- `src/preload`: safe renderer-facing desktop API exposed as `window.desktop`.
- `src/shared`: IPC channel names and shared request/result types.

## Development

```bash
pnpm install
pnpm --filter @vykor/desktop dev
```

## C++ 原生模块

桌面应用依赖两份需要编译的 C++ 插件，不是纯 JavaScript 包：

- `node-pty`：在本机开真正的终端（伪终端）。
- `better-sqlite3`：本地 SQLite 数据库。

`pnpm install` 装完 JS 依赖后，`postinstall` 会再跑 `electron-builder install-app-deps`。这一步按 **Electron 自己的 Node 版本** 重编译这些插件。给普通 Node 装好的 `.node` 文件不能直接给 Electron 用。

Windows 上如果缺 Visual Studio 的 C++ 工具链，或没装 Spectre 缓解库，`node-pty` 会编译失败，整次 `pnpm install` 跟着失败。典型报错：

```text
MSB8040: Spectre-mitigated libraries are required
node-gyp failed to rebuild ...\node-pty
```

处理办法：

1. 打开 **Visual Studio Installer**，修改 VS 2022。
2. 在 **单个组件** 里勾选 **MSVC v143 - VS 2022 C++ x64/x86 Spectre 缓解库（最新）**。
3. 同时确保已安装 **使用 C++ 的桌面开发** 工作负载（含 Windows SDK、MSVC 编译器）。
4. 装完后在仓库根目录重新执行 `pnpm install`。

`better-sqlite3` 通常能编过；卡住的几乎都是 `node-pty`。没编成功之前，桌面里的内嵌终端无法启动。

## 安装包

日常验证用 `pnpm --filter @vykor/desktop build:unpack`（不解 NSIS）。为什么 production 依赖必须很瘦、以及 `pnpm build:win` 卡在搜索 node modules 时看什么，见 [docs/packaging.md](./docs/packaging.md)。

## Checks

```bash
pnpm --filter @vykor/desktop typecheck
pnpm --filter @vykor/desktop lint
```
