# 应用组装与业务服务

把会话、配置、项目、渠道和维护能力接到同一个应用对象。

## 入口与流程

`createDefaultNodeApplication()` 组装默认配置与本机能力；`DaemonApplication` 创建各项服务，处理启动与关闭。`settings-api.ts` 定义可注入的服务接口，`support.ts` 保存共用的运行快照和辅助函数。

## 状态归属

应用持有服务实例与资源生命周期；持久记录通过 services 提供的接口访问，各业务目录保存自己的临时协调状态。

`createDefaultNodeApplication()` 同步返回应用。返回前，工厂负责回收自己创建但尚未交出的 Store，即使指定了 `ownsStore:false`；外部 Store 默认借用，只有明确 `ownsStore:true` 才在同步构造失败时关闭。构造错误直接返回；如果 Store 关闭也失败，则通过 `AggregateError.errors` 按顺序保留构造错误和关闭错误。成功返回后仍按原有 `ownsStore` 规则关闭，重复调用 `Application.close()` 共用一次关闭过程。`ready()` 的异步恢复失败由已返回的应用负责，调用方仍须关闭应用。


## 主要文件

| 文件 | 主要接口或用途 |
| --- | --- |
| [daemon-application.ts](./daemon-application.ts) | `DaemonApplicationOptions`、`DurableAgentApplication`、`DaemonApplication` |
| [default-application-services.ts](./default-application-services.ts) | `createDefaultAgentPersonaService`、`createDefaultApplicationServices` |
| [default-node-application.ts](./default-node-application.ts) | `DefaultNodeApplicationOptions`、`createDefaultNodeApplication` |
| [index.ts](./index.ts) | 汇总本分类的公开接口 |
| [settings-api.ts](./settings-api.ts) | `SettingsService`、`ProviderInfo`、`CustomProviderModelInput`、`CustomProviderInput` 等 |
| [support.ts](./support.ts) | `DAEMON_RESTART_RUN_REASON`、`DAEMON_RESTART_INPUT_REASON`、`DAEMON_RESTART_TASK_REASON`、`DAEMON_RESTART_PERMISSION_REASON` 等 |

## 子目录

| 目录 | 用途 |
| --- | --- |
| [agent/](./agent/README.md) | 管理正在使用的 Agent，把执行事件和子 Agent 活动接回持久会话。 |
| [attachments/](./attachments/README.md) | 接收附件，协调存储、完整性检查和会话中的附件使用。 |
| [auto-review/](./auto-review/README.md) | 根据运行产生的 Git 变化决定是否启动审查，并规范审查结果。 |
| [backup/](./backup/README.md) | 备份数据库及相关目录，校验清单并恢复应用数据。 |
| [browser-tools/](./browser-tools/README.md) | 把浏览器宿主能力转换为 Agent 可调用的浏览器与开发工具。 |
| [channel/](./channel/README.md) | 管理渠道配置、接入引导和外部消息到持久会话的转换。 |
| [context-usage/](./context-usage/README.md) | 汇总会话当前使用的上下文与模型容量，并把活跃运行接到缓存。 |
| [control/](./control/README.md) | 协调应用是否接受操作、独占维护，以及运行状态诊断。 |
| [default-services/](./default-services/README.md) | 提供应用接口的默认实现，并共享当前配置引用。 |
| [events/](./events/README.md) | 把已保存的事件重放和后续通知提供给 HTTP、渠道及嵌入调用方。 |
| [files/](./files/README.md) | 按会话的实际执行环境与读取权限提供只读目录、文件与搜索接口。 |
| [goals/](./goals/README.md) | 为 Agent 提供目标读取、修改、策略和每次运行的目标上下文。 |
| [maintenance/](./maintenance/README.md) | 统一处理存储扫描、清理策略、用量报表及维护准备。 |
| [mcp/](./mcp/README.md) | 管理外部工具服务的配置、OAuth 登录和运行连接同步。 |
| [notes/](./notes/README.md) | 提供笔记查询、保存和删除的应用入口。 |
| [observability/](./observability/README.md) | 汇总会话运行与工作流执行信息，供状态页和诊断接口查询。 |
| [personalization/](./personalization/README.md) | 提供记忆配置、规则查看和项目事实维护。 |
| [plugins/](./plugins/README.md) | 把插件安装操作接入当前应用，并在需要时请求安装确认。 |
| [projects/](./projects/README.md) | 管理项目列表、属性、工作目录重绑定和桌面 Git 工作树创建。 |
| [recovery/](./recovery/README.md) | 在应用启动时修复未完成的执行状态并处理历史记录遗留操作。 |
| [retention/](./retention/README.md) | 按保留策略清理不再需要的应用记录与相关内容。 |
| [schedule/](./schedule/README.md) | 把持久定时任务转换为应用中的会话与输入执行。 |
| [session/](./session/README.md) | 提供会话命令、查询、输入操作与运行服务的共同入口。 |
| [settings/](./settings/README.md) | 提供可迁移配置的解析、导入和导出。 |
| [skills/](./skills/README.md) | 提供技能目录查询、安装与管理操作。 |
| [visual-tools/](./visual-tools/README.md) | 提供图片生成、图片转文字、远程图片读取与取消处理。 |
| [workflow/](./workflow/README.md) | 把工作流运行记录连接到服务端会话存储。 |

## 测试与维护

根目录保留组装入口、共用接口和支持函数；具体业务按下方分类放置，避免继续堆入应用入口。

测试放在本分类同层的 `__test__/`；覆盖多个子分类的测试放在共同上层的 `__test__/`。迁移文件时同步导入、公开入口、文档链接与旧引用清单。

`__test__/durable-agent-application.test.ts` 的后台 Shell 回归通过离线模型调用真实 `BackgroundShellCreate`，启动临时目录中的本机进程，再用 `application.jobs` 检查 Shell 归属、输出、取消及 SQLite 终态。它使用真实 Node Agent 和现有 `target`、`{ jobs, errors }` 接口；不从底层能力覆盖中读取旧的 `.value/.jobs`，也不用不会执行工具的 Echo Agent 代替这条链路。

普通权限与审批通过后，执行入口调用当前 Run 的 `checkToolDispatch`，核对 owner、会话、Run、输入归属、cwd、最终工具绑定和运行修订。检查失败终止本 Run；工具普通错误与 unknown 只反馈本次调用，不限制其他新调用，也不自动重试。实际调用 Promise 一直跟踪到工具真正结束。
