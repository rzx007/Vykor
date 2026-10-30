---
title: API 参考说明
description: 公开 SDK 的两个入口、主要资源与由发布声明生成的 TypeScript API 参考。
---

API 参考从发布包的两个公开入口生成：

| 入口 | 适用环境与内容 |
| --- | --- |
| [`@rzx/client`](../../api/index/) | Node 与浏览器通用，提供 `VykorClient`、资源、同步、选择函数和生命周期类型 |
| [`@rzx/client/service`](../../api/service/) | 仅 Node，提供本机服务的 `discover`、`ensure`、`stop`、`clientOptions` 和 `Service` 集合 |

根入口不会加载本机文件或进程管理。需要的本机服务功能从 `/service` 显式导入，不在浏览器代码中引用它。

可以从 [API 总索引](../../api/)浏览全部公开导出。具体方法签名以生成参考为准；本站指南说明调用顺序和结果含义。

## 客户端资源

| `VykorClient` 属性 | 公开能力 |
| --- | --- |
| `protocol` | 健康检查、协议和功能能力查询 |
| `runtime` | `listModels`、`listAgentPersonas`、`listSkills`、`getSessionMcp`，只读查询 daemon 已配置的能力 |
| `sessions` | 会话创建和配置、输入准入与队列、运行中断和恢复、历史、分叉、回退、Goal、用量、归档和删除 |
| `permissions` | 查询、批准、拒绝和撤销权限批准 |
| `attachments` | 上传、读取附件记录、下载和删除 |
| `jobs` | 查询、读取、等待、输入和取消后台任务，以及创建后台 Shell |
| `events` | 查询历史事件和订阅 SSE |
| `files` | 会话工作区的只读目录、信息、文本、文件名与内容搜索 |

通常从资源方法开始。需要持续状态时，用 `syncEvents` 或 `SessionSyncController`；只等待一个 Run 时，用 `waitForRun`。选择函数从已合并状态中读取消息、权限和运行记录。

底层传输类也作为构件公开，但 `VykorClient` 实例不暴露 transport 属性。应用应通过资源方法调用公开能力，避免自行拼接 daemon 的内部业务 endpoint。

## 生成方式与范围

站点构建先生成 SDK 发布声明，再由 TypeDoc 与 Starlight 插件读取 `packages/client/dist/index.d.ts` 和 `packages/client/dist/service.d.ts`。方法签名和类型列表随这两份声明更新，手写指南负责解释调用顺序、状态和错误处理。

生成范围只覆盖公开 SDK，不扫描整个服务端。产品内部业务不属于此站点。学习任务流程可以从[第一个任务](../../getting-started/first-run/)开始；定位具体操作可以先看[会话指南](../../guides/sessions/)或[快照与事件同步](../../guides/sync-recovery/)。
