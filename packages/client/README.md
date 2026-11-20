# @rzx/client

开发者站点提供可运行的示例、协议说明和 API 参考。API 参考由两个公开入口的发布声明生成。 [Vykor Client SDK 文档](https://rzx007.github.io/Vykor/client-sdk/)

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

`waitForRun(client, { sessionId, runId, signal })` 复用快照与事件同步，返回指定 Run 的 `{ run, messages }`。应用在等待期间处理权限，取消 signal 结束观察。要停止后台运行，显式调用 `sessions.interrupt`。 [第一个 Agent 任务](https://rzx007.github.io/Vykor/client-sdk/getting-started/first-run/) · [权限处理](https://rzx007.github.io/Vykor/client-sdk/guides/permissions/)

## 公开资源

| 实例资源 | 作用 |
| --- | --- |
| `protocol` | 健康检查、能力查询与协议兼容检查 |
| `runtime` | 只读查询已有模型、Agent persona、技能和会话 MCP 状态 |
| `sessions` | 创建/配置、输入准入与队列、运行中断/恢复、分叉/回退、Goal、历史/结果/用量、归档/删除 |
| `permissions` | 查询待处理请求，回复工具审批或回答 Agent 提问 |
| `attachments` | 上传、读取、下载和删除附件 |
| `jobs` | 查询、读取、等待、输入和取消后台任务及子任务 |
| `events` | 查询历史事件和订阅 SSE（服务端持续推送的事件） |
| `files` | 按会话读取目录、文件信息和 UTF-8 文本，查找文件名与内容 |

`files` 通过 daemon 的实际会话工作区执行只读操作，按项检查路径和权限；调用方不提供宿主目录。支持 `list`、`stat`、`readText`、`find`、`search`，读取和搜索有上限并返回 `truncated`；使用前检查 `sessionFiles` 能力。

目录最多采集 4000 个候选项（含截断探针），只对受限集合排序；API 无法表示的 POSIX 枚举项会被跳过，用户直接传非法路径仍返回 400。正文在打开文件后重新授权，再从同一已打开对象读取；缺少安全读取或有界枚举能力时返回 501。

正文读取当前支持有 `/proc` 的 Linux/WSL，以及可用 PowerShell 和 `fsutil` 校验的本地 NTFS 单硬链接文件；WSL 目录扫描还需 Bash 与 GNU coreutils 9+。其他 Windows 卷、UNC 和 macOS 暂不支持正文读取。 [工作区文件指南](https://rzx007.github.io/Vykor/client-sdk/guides/files/)

`runtime` 提供 `listModels`、`listAgentPersonas`、`listSkills` 和 `getSessionMcp`，只读取 daemon 已配置的能力。会话快照、reducer（合并快照和事件的函数）、选择函数及同步控制器从根入口导出，供不同界面共用一套恢复流程。请求 metadata 与工具输入/输出保留扩展数据。

CLI、TUI 和 Desktop 与第三方使用同一套生命周期资源。渠道、设置和插件等管理功能由内部 `@vykor/daemon-admin` 的分组入口提供。Desktop 本地便签与其他桌面功能走各自的产品入口。 [公开契约](https://rzx007.github.io/Vykor/client-sdk/reference/overview/) · [首方接入](https://github.com/rzx007/Vykor/blob/main/docs/product-surface-integration.md)

## 可选本机服务管理

需要程序管理本机后台时，显式使用 Node 专用入口 `@rzx/client/service`。`Service.discover()` 只查找已有实例，`Service.ensure()` 可启动本机 CLI，`Service.stop(endpoint)` 只停止匹配的登记实例。启动功能需要在调用方项目另装 `@rzx/ohs`；普通远程连接不需要它。

Node 服务入口提供参数、启动锁和进程归属检查。 [本机服务管理](https://rzx007.github.io/Vykor/client-sdk/guides/local-service/)

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
| [src/](https://github.com/rzx007/Vykor/tree/main/packages/client/src) | 根导出与源码导航 |
| [src/configuration/](https://github.com/rzx007/Vykor/tree/main/packages/client/src/configuration) | 会话运行配置的公共规则 |
| [src/protocol/](https://github.com/rzx007/Vykor/tree/main/packages/client/src/protocol) | 协议与能力检查 |
| [src/resources/](https://github.com/rzx007/Vykor/tree/main/packages/client/src/resources) | 生命周期资源及只读运行能力 |
| [src/service/](https://github.com/rzx007/Vykor/tree/main/packages/client/src/service) | 显式选择的 Node 本机后台管理 |
| [src/state/](https://github.com/rzx007/Vykor/tree/main/packages/client/src/state) | 快照、事件合并、同步恢复和指定 Run 等待 |
| [src/transport/](https://github.com/rzx007/Vykor/tree/main/packages/client/src/transport) | HTTP 与 SSE 传输 |
| [src/types/](https://github.com/rzx007/Vykor/tree/main/packages/client/src/types) | 生命周期请求、响应、能力描述及同步类型 |
| [scripts/](https://github.com/rzx007/Vykor/tree/main/packages/client/scripts) | 构建、独立安装验证和发布 |

新增代码放入对应职责目录，测试放该目录的 `__test__/`。新增公开 API 同步更新导出、契约和安装包消费者。仓库开发者可运行 `pnpm docs:dev` 预览 API 参考。 [文档项目](https://github.com/rzx007/Vykor/tree/main/apps/client-docs)

```bash
pnpm --filter @rzx/client check-types
pnpm --filter @rzx/client test
pnpm --filter @rzx/client test:pack
pnpm test:client-browser
```

daemon 保存运行状态，客户端根据快照和事件恢复视图。 [事件同步与恢复](https://rzx007.github.io/Vykor/client-sdk/guides/sync-recovery/) · [Daemon Application](https://github.com/rzx007/Vykor/blob/main/docs/daemon-application-architecture.md)

### 补充当前运行

`sessions.admitPrompt` 接受 `delivery: "steer"` 和 `expectedActiveRunId`。SDK 在发起目标明确的请求前验证 `features.steer >= 2`。同一条输入重试仍带原 Input ID 和 Run ID，目标已过期则返回 409。
