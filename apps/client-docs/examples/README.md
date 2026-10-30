# SDK 使用示例

这里的 TypeScript 文件既是可运行示例，也是文档页面展示的源码。它们只通过发布包的 `@rzx/client` 和可选的 `@rzx/client/service` 入口使用 SDK；类型检查不依赖工作区内部源码。

| 入口 | 用途 | 输入 |
| --- | --- | --- |
| [node/connect.ts](./node/connect.ts) | 检查通信协议与能力，列出已有会话 | `VYKOR_BASE_URL`、`VYKOR_TOKEN` |
| [node/run-with-permissions.ts](./node/run-with-permissions.ts) | 新建会话、提交任务、拒绝权限请求并等到运行终态 | 连接变量，加 `VYKOR_MODEL`、`VYKOR_DAEMON_CWD` |
| [node/sync-events.ts](./node/sync-events.ts) | 从快照开始观察已有会话，最多观察 30 秒 | 连接变量，命令行 `sessionId` |
| [node/files.ts](./node/files.ts) | 列目录、查看信息、读文本、查找文件和搜索内容 | 连接变量，命令行 `sessionId` 和可选相对路径 |
| [node/service.ts](./node/service.ts) | Node 应用可选的本机服务发现、启动与停止 | 默认读取本机服务登记；可传 `--start` 或 `--stop` |
| [browser/connect.ts](./browser/connect.ts) | 浏览器应用连接已有 daemon | 应用调用导出的 `connect(options, signal?)` |

## 运行 Node 示例

示例使用 Node.js 24 内建的 TypeScript 去类型能力，不需要 `tsx`。daemon 需事先运行并配置模型；除 `service.ts --start` 外，示例不会启动服务。

在仓库根目录先安装工作区依赖并构建发布入口：

```sh
pnpm install
pnpm --filter @rzx/client build
```

设置已有 daemon 的参数。下面是 PowerShell 写法；token 应从自己的服务配置取得，不写入示例文件或版本库。

```powershell
$env:VYKOR_BASE_URL = "http://127.0.0.1:8787"
$env:VYKOR_TOKEN = "<自己的 daemon token>"
pnpm --dir apps/client-docs exec node examples/node/connect.ts
```

运行任务还需要该 daemon 已配置的模型 ID 和 **daemon 机器**上的工作目录。`run-with-permissions.ts` 会创建真实会话、调用模型，可能产生费用；它设置 `approvalMode: "ask"`，并拒绝本会话所有待处理权限请求。它不是权限审批界面。

```powershell
$env:VYKOR_MODEL = "<daemon 已配置的模型 ID>"
$env:VYKOR_DAEMON_CWD = "D:/path/on/daemon/machine"
pnpm --dir apps/client-docs exec node examples/node/run-with-permissions.ts
```

运行结束后保留会话记录。可使用输出的会话 ID 继续观察或读取工作区文件：

```sh
pnpm --dir apps/client-docs exec node examples/node/sync-events.ts <sessionId>
pnpm --dir apps/client-docs exec node examples/node/files.ts <sessionId> README.md
```

文件路径用 `/` 分隔且相对于会话工作区，默认读取 `README.md`。若没有该文件，传入一个实际存在的 UTF-8 文本文件。文件示例先检查 `features.sessionFiles`；正文读取还受 daemon 机器的系统能力和读取策略限制，可能返回 403 或 501。

复制到独立项目使用时，在该项目安装 `npm install @rzx/client`，然后用 `node connect.ts` 等命令运行所复制的文件。

## 浏览器入口

`browser/connect.ts` 导出一个函数，由网页应用传入地址、运行时取得的 token 和可选 `fetch`。它不读取环境变量，不在导入时发送请求。浏览器应用需要支持 fetch、ReadableStream 和 AbortController；daemon 需通过 `--allow-origin` 允许网页的准确来源。不要把长期 token 硬编码到前端构建产物。

## 本机服务管理（可选）

`service.ts` 只适用于 Node。默认只发现服务，没有服务时打印提示并退出：

```sh
pnpm --dir apps/client-docs exec node examples/node/service.ts
pnpm --dir apps/client-docs exec node examples/node/service.ts --start
pnpm --dir apps/client-docs exec node examples/node/service.ts --stop
```

`--start` 调用 `Service.ensure()`，复用兼容实例或启动 CLI。调用目录需要能找到已安装的 `@rzx/ohs`；独立项目使用前可运行 `npm install @rzx/client @rzx/ohs`。它不会替应用安装模型或配置凭据。启动后的 daemon 在脚本结束后继续运行。

`--stop` 会停止整个共用 daemon，所有连接该服务的客户端都会受影响。结束一次脚本通常无需停止服务；只中断某次运行应使用 `sessions.interrupt(sessionId, { expectedRunId })`。服务登记里的 endpoint 含 token，示例不会打印它。

## 状态、取消和清理

会话、运行、消息和权限记录由 daemon 保存。`syncEvents()` 在客户端建立展示用状态，先读取快照再接收事件，断线后重新取得快照。不要把客户端副本当成另一套持久化状态。

给请求、订阅或 `waitForRun()` 传入 `AbortSignal` 只取消本地操作，后台 Agent 仍可能继续。任务示例在超时、按 Ctrl+C 或观察失败时，另外调用 `sessions.interrupt()` 请求 daemon 停止该次运行；中断请求使用新的 10 秒期限。若网络不可达，示例会输出会话 ID，供调用方恢复连接后核查。观察示例只停止订阅，不中断既有任务。

`waitForRun()` 返回真实终态：`failed`、`interrupted` 也会正常返回，不自动变成异常。示例将它们转换为非零脚本退出码。任务示例始终停止本地权限观察，不自动删除会话记录。

## 类型检查和新增示例

文档构建只读取和检查源码，不执行示例，不连接 daemon 或调用模型。

```sh
pnpm --filter @rzx/client build
pnpm --dir apps/client-docs exec tsc -p examples/tsconfig.json
pnpm --dir apps/client-docs exec tsc -p examples/browser/tsconfig.json
```

根配置使用 NodeNext 解析发布包导出，覆盖 `node/` 和 `browser/` 中所有 `.ts`；浏览器配置额外去掉 Node 全局类型，防止误用 `process` 等接口。两者都不生成文件。

新增 Node 示例放入 `node/`，浏览器示例放入 `browser/`。只使用 SDK 公开入口；给网络操作设置有限等待时间，声明会创建的服务端状态，并明确是否中断后台运行。同步更新本表和对应分类 README，文档页面通过源码导入展示同一份文件，再执行以上类型检查。
