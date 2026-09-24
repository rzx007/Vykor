# Vykor CLI

Vykor 终端 CLI：在终端里跑 AI Agent。默认进入交互式 TUI（需 [Bun](https://bun.sh)），也可一次性打印结果后退出。会话由本机 daemon 持久化，可与 Desktop 等客户端共用同一后端。

命令行入口：`vk` 与 `vykor`（等价）。

## 要求

- Node.js >= 20
- 交互式 TUI：额外安装 [Bun](https://bun.sh)
- 可选：SRT（启用本机 sandbox 时）；Windows 可选择 WSL 作为 Agent 运行环境

## 安装

```bash
npm install -g @rzx/ohs
# 或
pnpm add -g @rzx/ohs
```

验证：

```bash
vk --version
vk doctor
```

## 快速开始

```bash
# 首次配置（Provider / API Key / 模型）
vk setup

# 或手动登录
vk auth login <provider> <api-key>
vk provider list
vk provider use <name> -m <model>

# 交互式 TUI（默认；会 attach 或启动本机 daemon）
vk

# 单次提问后退出
vk "explain this codebase"
vk -p "explain this codebase"

# 只检查配置，不调模型
vk --dry-run
```

用户配置与数据默认在 `~/.vykor/`（例如 `settings.json`、daemon registry、会话库）。

## 常用用法

```bash
vk -m <model> "你的问题"
vk --provider <name> --permission-mode full_auto "重构这段代码"
vk --cwd /path/to/project
vk --tui "带初始提示打开 TUI"
```

### 主要选项


| 选项                                | 说明                                 |
| --------------------------------- | ---------------------------------- |
| `-p, --print`                     | 经 daemon 打印结果后退出（有 prompt 时默认即此模式） |
| `--tui`                           | 显式启动 TUI（无 prompt 时默认已是 TUI）       |
| `-m, --model`                     | 模型名                                |
| `--provider`                      | 强制指定 Provider                      |
| `--permission-mode`               | `default` | `plan` | `full_auto`   |
| `--max-turns`                     | 最大 agent 轮次                        |
| `--effort`                        | `low` | `medium` | `high`          |
| `--no-plugins`                    | 本次会话不加载已安装插件贡献                     |
| `--dangerously-skip-permissions`  | 跳过权限确认                             |
| `--dry-run`                       | 预览解析后的配置，不调模型                      |
| `--daemon-url` / `--daemon-token` | 连接到指定 daemon，而不是本机自动启动             |


完整参数见 `vk --help`。

## 常用子命令

```bash
vk setup
vk doctor
vk auth login <provider> <api-key>
vk auth status
vk provider list|use|add|edit|remove
vk mcp list|add|remove
# 公开 HTTP MCP：只提供 URL
vk mcp add beui --url https://mcp.beui.dev/mcp
# OAuth HTTP MCP：显式声明 scope，再授权
vk mcp add linear --url https://mcp.linear.app/mcp --scope read
vk mcp login linear --scopes read
vk plugin list|install|uninstall|enable|disable
vk sandbox enable|disable|status|check
vk daemon start|status|stop|install|uninstall
vk config show
vk config set <key> <value>
vk workflow list|status|validate|template|reconcile|cancel
vk channels add|allow|status|serve
```

开启登录后自动拉起 daemon（可选）：

```bash
vk daemon install
# 或
vk config set daemon.autoStart true
```

## 说明

- **TUI** 需要 Bun；没有 Bun 时可用 `-p` / 带 prompt 的 print 模式。
- 默认会连接已有本机 daemon；没有可用进程时会按需启动。Desktop 等客户端也可连同一 daemon，共享会话状态。
- 原生依赖含 `sharp`、`better-sqlite3`、`node-pty`；全局安装时会由 npm/pnpm 一并安装对应平台包。
- 正式版本随 GitHub tag `vX.Y.Z` 发布，和 Desktop 安装包同一版本。详见仓库 `docs/release-process.md`。

## 文档与源码

- 源码仓库：[https://github.com/rzx007/openharness-ts](https://github.com/rzx007/openharness-ts)
- 项目文档：[https://github.com/rzx007/openharness-ts/tree/main/docs](https://github.com/rzx007/openharness-ts/tree/main/docs)
- 问题反馈：[https://github.com/rzx007/openharness-ts/issues](https://github.com/rzx007/openharness-ts/issues)

本地从源码开发请看仓库根目录 `README.md`。
