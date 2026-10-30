# Agent 生命周期客户端边界

用户已确认：`@rzx/client` 默认连接已有 daemon，提供完整 Agent 生命周期和同步恢复，纯业务接口、类型、逻辑移到内部应用层。

## 公开 SDK

- 保持包名 `@rzx/client` 和类名 `VykorClient`。构造只接收地址、凭据和可选 fetch，不启动、停止或改配置 daemon。
- 实例资源限定为 `protocol`、`runtime`、`sessions`、`permissions`、`attachments`、`jobs`、`events`。
- `runtime` 只读取已有模型、Agent persona、技能和会话 MCP 能力，不安装插件、修改提供商凭据或全局设置。
- 保留会话创建/配置、输入准入和队列、运行中断/恢复、分叉/回退、Goal、历史/结果/用量、归档/删除，以及子任务查询/等待/取消。
- 保留快照水合、事件归并、去重、断线恢复、运行状态和结果选择函数。增加 `waitForRun(client, { sessionId, runId, signal })`，复用同一同步流程等待指定 Run 终态并返回该 Run 的消息。
- 保留附件上传/读取/下载/删除；存储扫描/修复/清理和 Desktop worktree 绑定清理属于应用管理功能。
- `@rzx/client/service` 仍为显式选择的 Node 管理入口，主入口不引用它。
- 请求与结果的通用 metadata、工具 input/output 保持开放，不能删除 Agent 记录中的正常扩展数据。

## 私有应用客户端

- 新增 `packages/application-client`，包名 `@vykor/application-client`，`private: true`。
- 内部 `VykorClient` 保持产品现有资源，复用公开 SDK 的传输、协议、会话同步和核心 Resource；不得复制 reducer、同步恢复或 Agent 执行逻辑。
- 笔记、渠道、调度、插件与市场、插件应用/历史、全局配置/身份认证/提供商管理、Git/终端管理、业务展示策略、斜杠命令及其类型归此包。
- Desktop、TUI、CLI 的产品功能从私有包导入。服务端兼容测试中的业务场景改用私有包，生命周期场景继续直接覆盖公开 SDK。
- 公共 SDK 不依赖、重导出或打包私有应用包；内部包可以依赖 SDK 与 Protocol。

## 验收

- 公开实例、根导出、类型声明、真实安装包均不能暴露业务资源和业务类型；包只提供根入口及可选 service 入口。
- 冻结的公开 API 清单和外部编译用例同步更新，加入业务 API/类型的负例。
- 生命周期与断线恢复测试继续通过；新增指定 Run 的正常/失败/取消和已完成快照等待用例。
- 私有客户端的业务接口、命令和展示规则继续有原有测试覆盖。
- 检查应用构建别名、workspace 依赖、缓存输入、架构规则、文档导航和精确旧引用登记；运行 `pnpm check:retired-ui`、`pnpm check-docs`。

本次不增加服务器业务功能，不修改持久化协议、服务端 Run 状态机和现有执行语义。
