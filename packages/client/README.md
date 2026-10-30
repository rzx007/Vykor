# @rzx/client

连接已有 Vykor daemon 的 Agent 生命周期 SDK。网页、IDE 和 Node 脚本可创建会话、提交输入、处理权限、控制运行并读取结果；执行与持久化由 daemon 负责。

## 安装与连接

```bash
npm install @rzx/client
```

发布包包含 ESM JavaScript 和类型声明，运行时不要求安装本仓库或其他 `@vykor/*` 包。Node.js 要求 >= 20.3；浏览器使用标准 fetch。

```ts
import { VykorClient } from "@rzx/client";

const client = new VykorClient({
  baseUrl: "http://127.0.0.1:8787",
  token: process.env.VYKOR_TOKEN,
});
const providers = await client.runtime.listModels();
console.log(providers.flatMap(provider => provider.models));
```

地址、token、可用模型和服务端工作目录由调用方提供。构造客户端不发送请求、不启动后台，也不改变全局配置。首次资源请求会检查 daemon 的协议版本；SDK 版本与 CLI 版本可以不同，通信协议必须相同。

完整的任务提交、权限处理和等待结果示例见 [Client SDK 使用指南](../../docs/client-sdk.md)。`waitForRun(client, { sessionId, runId, signal })` 复用快照与事件同步，返回指定 Run 的 `{ run, messages }`；它不自动批准权限。取消 signal 只结束观察，停止后台任务需显式调用 `sessions.interrupt`。

## 公开资源

| 实例资源 | 作用 |
| --- | --- |
| `protocol` | 健康检查、能力查询与协议兼容检查 |
| `runtime` | 只读查询已有模型、Agent persona、技能和会话 MCP 状态 |
| `sessions` | 创建/配置、输入准入与队列、运行中断/恢复、分叉/回退、Goal、历史/结果/用量、归档/删除 |
| `permissions` | 查询权限请求并明确批准或拒绝 |
| `attachments` | 上传、读取、下载和删除附件 |
| `jobs` | 查询、读取、等待、输入和取消后台任务及子任务 |
| `events` | 查询历史事件和订阅 SSE（服务端持续推送的事件） |
| `files` | 按会话读取目录、文件信息和 UTF-8 文本，查找文件名与内容 |

`files` 通过 daemon 的实际会话工作区执行只读操作，按项检查路径和权限；调用方不提供宿主目录。支持 `list`、`stat`、`readText`、`find`、`search`，读取和搜索有上限并返回 `truncated`；使用前检查 `sessionFiles` 能力。

目录最多采集 4000 个候选项（含截断探针），只对受限集合排序；API 无法表示的 POSIX 枚举项会被跳过，用户直接传非法路径仍返回 400。正文在打开文件后重新授权，再从同一已打开对象读取；缺少安全读取或有界枚举能力时返回 501。

正文读取当前支持有 `/proc` 的 Linux/WSL，以及可用 PowerShell 和 `fsutil` 校验的本地 NTFS 单硬链接文件；WSL 目录扫描还需 Bash 与 GNU coreutils 9+。其他 Windows 卷、UNC 和 macOS 暂不支持正文读取。详细示例和限制见 [会话文件指南](../../docs/client-sdk.md#会话工作区文件只读)。

`runtime` 提供 `listModels`、`listAgentPersonas`、`listSkills` 和 `getSessionMcp`，只读取 daemon 已配置的能力。会话快照、reducer（合并快照和事件的函数）、选择函数及同步控制器从根入口导出，供不同界面共用一套恢复流程。请求 metadata 与工具输入/输出保留扩展数据。

笔记、渠道、调度、插件与市场、插件应用、Office、全局设置、提供商与登录、Git/终端管理、命令及业务展示规则归私有工作区包 [`@vykor/application-client`](../application-client/README.md)。附件存储扫描/修复/清理、Desktop worktree 绑定清理与 `pluginAppContexts` 也由该包扩展。CLI、TUI、Desktop 从私有包接入产品功能；私有包复用本 SDK 的传输与同步，不复制实现。公开 SDK 不依赖或重导出私有包。

## 可选本机服务管理

需要程序管理本机后台时，显式使用 Node 专用入口 `@rzx/client/service`。`Service.discover()` 只查找已有实例，`Service.ensure()` 可启动本机 CLI，`Service.stop(endpoint)` 只停止匹配的登记实例。启动功能需要在调用方项目另装 `@rzx/ohs`；普通远程连接不需要它。

根入口不加载本机文件或进程管理。服务管理的参数、锁及进程归属见 [service 分类说明](./src/service/README.md)。

## 状态与调用流程

```text
应用 -> VykorClient Resource -> 协议握手与 HTTP -> daemon
应用 <- 选择函数 <- reducer <- 快照 + SSE <- daemon
```

Session、Input、Message、Run、Task、Permission 和事件游标由 daemon 持久保存。SDK 维护这些记录的本地视图，断线后重新读取快照并继续同步；草稿、当前选中项、窗口及连接提示由各产品保存。界面不直接读取数据库，不另建 Run 对账或 Agent 执行逻辑。

首次快照或全局历史回放失败时直接抛出错误。进入事件循环后，SSE、断流后的快照恢复或事件缺口补齐遇到网络错误、5xx、408/425/429 时退避重试；其他 4xx 会终止同步并原样抛出 `VykorApiError`，保留 `status` 和 `body`，由调用方处理参数、权限或资源失效。

## 目录与维护

| 目录 | 用途 |
| --- | --- |
| [src/](./src/README.md) | 根导出与源码导航 |
| [src/configuration/](./src/configuration/README.md) | 会话运行配置的公共规则 |
| [src/protocol/](./src/protocol/README.md) | 协议与能力检查 |
| [src/resources/](./src/resources/README.md) | 生命周期资源及只读运行能力 |
| [src/service/](./src/service/README.md) | 显式选择的 Node 本机后台管理 |
| [src/state/](./src/state/README.md) | 快照、事件合并、同步恢复和指定 Run 等待 |
| [src/transport/](./src/transport/README.md) | HTTP 与 SSE 传输 |
| [src/types/](./src/types/README.md) | 生命周期请求、响应、能力描述及同步类型 |
| [scripts/](./scripts/README.md) | 构建、独立安装验证和发布 |

新增代码放入对应职责目录，测试放该目录的 `__test__/`。新增公开 API 同步更新导出、契约和安装包消费者；产品业务放私有应用包。

```bash
pnpm --filter @rzx/client check-types
pnpm --filter @rzx/client test
pnpm --filter @rzx/client test:pack
pnpm test:client-browser
```

同步与运行边界见 [客户端同步](../../docs/client-sync-flow.md)和[Daemon Application](../../docs/daemon-application-architecture.md)。
