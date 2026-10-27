# Vykor

Vykor 是一套能保存会话和运行记录的 Agent 应用。CLI、终端界面（TUI）、Desktop 和外部聊天渠道通过同一个后台服务（daemon）提交任务、读取状态；`@vykor/agent-runtime` 也可在程序中独立使用。

第一次了解项目，从[文档目录](docs/README.md)和[架构总览](docs/architecture-overview.md)开始。每个主题的维护入口见[文档维护约定](docs/documentation-policy.md)，历史计划不作为当前功能清单。

## 安装与使用

CLI 需要 Node.js 20 或更新版本；交互式 TUI 还需要 [Bun](https://bun.sh)。

```bash
npm install -g @rzx/ohs
vk setup
vk "解释这个项目"
vk
```

`vk setup` 配置供应商、凭据和模型。有 prompt 时默认打印结果后退出，没有 prompt 时进入 TUI。两种方式都会连接或按需启动本机 daemon，会话与运行记录保存在配置目录的 SQLite 数据库中。

- 完整参数与子命令：[CLI 使用说明](apps/cli/README.md)，也可运行 `vk --help`。
- 凭据与模型选择：[认证、Provider 和 Model](docs/auth-provider-model.md)。
- 远程服务：[连接 daemon](docs/remote-attach.md)、[系统常驻服务](docs/daemon-system-service.md)。
- 插件：[安装与市场](docs/plugin-marketplace.md)、[作者指南](docs/native-plugin-authoring.md)。
- 飞书等外部消息：[Channels 流程与使用范围](docs/channels-flow.md)。

默认配置目录是 `~/.vykor`，可用 `VYKOR_CONFIG_DIR` 改变。设置、供应商凭据、MCP OAuth 凭据和渠道凭据分别保存，文件用途与解析优先级见[认证说明](docs/auth-provider-model.md)。不要把完整配置模板从旧计划复制到新版本。

## 从源码开发

准备 Node.js、pnpm 和 Bun。pnpm 版本以根 `package.json` 的 `packageManager` 为准，各构建工具的 Node 要求以各包声明为准。

Windows 上的文件边界测试会实际创建文件符号链接。运行测试前，请开启 [Windows 开发者模式](https://learn.microsoft.com/windows/advanced-settings/developer-mode)，让普通 Node.js 进程具备创建链接的权限；也可使用管理员终端运行测试。若创建链接时报 `EPERM`，应修复本机权限后重跑，不能跳过用例、用普通文件替代链接或放宽断言。

跨平台验证需要 Windows 中实际可用的 Git Shell（执行 `sh` 脚本的程序）、完成首次用户初始化的 WSL 发行版，以及 Linux 中限制命令访问范围的 SRT 运行器和它使用的 bubblewrap 隔离工具。POSIX 引号安全、文件权限位和 SRT 测试在 Linux 中运行，不能用 Windows 结果代替。官方插件兼容性检查需显式设置 `VYKOR_OFFICIAL_PLUGINS_DIR`，指向独立 `vykor-plugins` 仓库的 `plugins` 目录；涉及外部插件的两个包测试不缓存结果，避免外部源码更新后重用旧验证。运行入口见[契约与测试索引](docs/contract-test-index.md)。

```bash
git clone https://github.com/rzx007/Vykor.git vykor
cd vykor
pnpm install
pnpm build

# 直接运行源码
bun apps/cli/src/index.ts --dry-run
bun apps/cli/src/index.ts "hello"
bun apps/cli/src/index.ts --tui

# 或运行构建产物
node apps/cli/dist/index.js "hello"
```

需要在任意目录调用本地构建时，可在 shell 配置中添加函数，将路径换成仓库绝对路径：

```bash
vk() { node "/absolute/path/to/vykor/apps/cli/dist/index.js" "$@"; }
vykor() { vk "$@"; }
```

```powershell
function vk { node 'D:\path\to\vykor\apps\cli\dist\index.js' @args }
function vykor { vk @args }
```

移除函数即可取消本地命令。源码开发和 TUI 运行仍需要 Bun。

## 目录导航

| 位置 | 用途与入口 |
| --- | --- |
| [apps/cli](apps/cli/README.md) | 命令行、TUI 启动与 daemon 连接 |
| [apps/frontend](apps/frontend/README.md) | 终端交互界面 |
| [apps/desktop](apps/desktop/README.md) | Electron 主进程、preload 与桌面界面 |
| [packages/agent-runtime](packages/agent-runtime/README.md) | 默认 Node Agent、运行与子 Agent 生命周期 |
| [packages/core](packages/core/README.md) | 模型调用循环、历史、工具执行和上下文压缩 |
| [packages/server](packages/server/README.md) | 请求接纳、运行控制、权限、事件与启动恢复 |
| [packages/services](packages/services/README.md) | 数据库、各类记录读写和跨记录事务 |
| [packages/client](packages/client/README.md) | 独立客户端 SDK、HTTP 请求和状态同步 |
| [packages/protocol](packages/protocol/README.md) | 客户端与服务端的通信格式和校验 |
| [packages/agent-contracts](packages/agent-contracts/README.md)、[domain-contracts](packages/domain-contracts/README.md)、[plugin-contracts](packages/plugin-contracts/README.md) | 执行数据、产品记录、插件清单与绑定格式 |
| [packages/coordinator](packages/coordinator/README.md)、[jobs](packages/jobs/README.md) | Agent 定义、团队登记、Workflow 调度与后台任务控制 |
| [packages/host-config](packages/host-config/README.md)、[api](packages/api/README.md)、[auth](packages/auth/README.md) | 配置解析、模型请求和凭据 |
| [packages/tools](packages/tools/README.md)、[permissions](packages/permissions/README.md) | 基础工具与执行许可检查 |
| [packages/environment](packages/environment/README.md)、[execution-node](packages/execution-node/README.md)、[sandbox](packages/sandbox/README.md) | Native/WSL 中的文件与进程执行、可选 SRT 限制 |
| [packages/plugins](packages/plugins/README.md)、[plugin-sources](packages/plugin-sources/README.md)、[plugin-converters](packages/plugin-converters/README.md) | 插件校验安装、来源下载和外部格式转换 |
| [packages/prompts](packages/prompts/README.md)、[memory](packages/memory/README.md)、[skills](packages/skills/README.md) | 提示词、长期记忆与 Skill |
| [packages/channels](packages/channels/README.md) | 外部聊天渠道和消息桥接 |
| [scripts](scripts/README.md) | 跨包检查、构建准备和发布脚本 |
| [docs](docs/README.md) | 当前手册、提案及历史资料索引 |

其余包的职责和内部目录见各包 README；跨包调用方向见[架构总览](docs/architecture-overview.md)。

## 运行和状态归属

```text
CLI / TUI / Desktop / 渠道
  → Client 或渠道桥接提交请求
  → Server 接纳输入并保存 Run
  → Agent Runtime 调用模型、工具和子 Agent
  → Server 保存消息、权限与运行结果
  → Client 读取快照，通过 SSE 接收后续变化
```

SQLite 保存可重读的运行事实，Runtime 保存当前进程中的执行对象，界面保存草稿和显示状态。进程重启会收束失去执行进程的记录，不会自动重放旧工具。详见[生命周期契约](docs/agent-lifecycle-contract.md)和[运维与恢复](docs/operations-and-recovery.md)。

默认工具、模型、轮数和协议版本随代码维护，具体入口列在[文档维护约定](docs/documentation-policy.md)。使用限制和权限模式分别见[运行环境](docs/sandbox-runtime-flow.md)与[权限流程](docs/permission-flow.md)。

## 检查与发布

| 命令 | 用途 |
| --- | --- |
| `pnpm check-docs` | 文档分类、导航、链接、源码路径与协议版本声明 |
| `pnpm check:retired-ui` | 退役界面实现和精确历史引用登记 |
| `pnpm --filter <包名> test` | 被修改模块的测试 |
| `pnpm check-types` | 工作区及 Server/Client 联合类型检查 |
| `pnpm test` | 全量工作区与跨包测试 |
| `pnpm test:client-browser` | 客户端浏览器构建 |
| `pnpm check:architecture` | 依赖边界、公开入口与当前格式检查 |

检查范围按改动选择，具体测试入口见[契约与测试索引](docs/contract-test-index.md)。Desktop 与 CLI 发布步骤见[发布流程](docs/release-process.md)，客户端独立发布见[Client SDK](docs/client-sdk.md)。

## License

MIT。第三方声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
