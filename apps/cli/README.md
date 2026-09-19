# @rzx/ohs

OpenHarness-ts 终端 CLI：在终端里跑 AI Agent。默认进入交互式 TUI（需 [Bun](https://bun.sh)），也可一次性打印结果后退出。会话由本机 daemon 持久化，可与 Desktop 等客户端共用同一后端。

命令行入口：`ohs` 与 `openharness`（等价）。

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
ohs --version
ohs doctor
```

## 快速开始

```bash
# 首次配置（Provider / API Key / 模型）
ohs setup

# 或手动登录
ohs auth login <provider> <api-key>
ohs provider list
ohs provider use <name> -m <model>

# 交互式 TUI（默认；会 attach 或启动本机 daemon）
ohs

# 单次提问后退出
ohs "explain this codebase"
ohs -p "explain this codebase"

# 只检查配置，不调模型
ohs --dry-run
```

用户配置与数据默认在 `~/.openharness-ts/`（例如 `settings.json`、daemon registry、会话库）。

## 常用用法

```bash
ohs -m <model> "你的问题"
ohs --provider <name> --permission-mode full_auto "重构这段代码"
ohs --cwd /path/to/project
ohs --tui "带初始提示打开 TUI"
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


完整参数见 `ohs --help`。

## 常用子命令

```bash
ohs setup
ohs doctor
ohs auth login <provider> <api-key>
ohs auth status
ohs provider list|use|add|edit|remove
ohs mcp list|add|remove
ohs plugin list|install|uninstall|enable|disable
ohs sandbox enable|disable|status|check
ohs daemon start|status|stop|install|uninstall
ohs config show
ohs config set <key> <value>
ohs workflow list|status|validate|template|reconcile|cancel
ohs channels add|allow|status|serve
```

开启登录后自动拉起 daemon（可选）：

```bash
ohs daemon install
# 或
ohs config set daemon.autoStart true
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
