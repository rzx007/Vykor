# @vykor/services

共享持久化与领域服务。业务代码通过 Repository（负责一个领域的读写）和 Transaction（负责需要原子完成的跨表操作）访问状态；`SessionStore` 只保留数据库打开与关闭、应用独占使用许可（owner lease）、事件等待与监听、启动恢复和维护入口。

## 功能

- **Scheduled recurrence**: 校验一次性时间和 RRULE，并按时区计算下一次运行时间
- **Repository**: Projects、Schedules、Workflows、Channels、Sessions、Conversations、Runs、Goals、Permissions 和 Attachments 的当前读写入口
- **Transaction**: prompt 准入、会话树操作、Goal、Attachment 等需要一起提交或一起回滚的操作
- **Attachment 领域根**: `src/attachments/` 是唯一入口。`persistence/` 管 SQLite 记录，`storage/` 管 Blob 和完整性，`processing/` 管 OCR 与图片标准化，`content/` 管不依赖存储的文本分类。应用用例不在本包，而在 Server 的 `AttachmentService`
- **Database kernel**: SQLite 打开/关闭、事务协调、增量输出、owner lease、恢复与维护；不提供旧 Store 转发入口
- **standalone session files**: 只接受当前 schema 的项目级 snapshot 与 transcript 导出；不供 daemon/TUI 保存权威状态

本地进程、输出捕获、子 Agent 执行观察和 LSP 已迁入 `@vykor/execution-node`，由宿主创建的 `ExecutionRuntimeOwner` 管理。autodream 接收宿主显式传入的 taskRunner；本包不再维护默认进程目录。跨端执行投影与 Scheduled Task 状态仍由 daemon `SessionStore` 持久化。

数据库包含基线 `0000_current_schema.sql` 及其后的增量迁移。从空目录一次建立当前 schema，之后每次打开都应用迁移链。不做旧库接管：与当前基线不匹配的库会带提示失败，删除后重建即可。

## 测试

```bash
pnpm --filter @vykor/services test
```

## 目录导航

| 目录 | 职责 |
| --- | --- |
| [src/](./src/README.md) | 汇总共享存储、领域读写、附件、记忆和 Office 能力。 |
| [src/attachments/](./src/attachments/README.md) | 管理附件状态、限制、输入引用和错误，并汇总附件子目录。 |
| [src/channels/](./src/channels/README.md) | 保存外部渠道会话映射、消息投递结果及平台附加信息。 |
| [src/conversations/](./src/conversations/README.md) | 管理输入、消息、消息部件、增量输出以及会话树操作。 |
| [src/database/](./src/database/README.md) | 打开 SQLite、应用迁移链，并为领域模块提供数据库和共享状态接口。 |
| [src/goals/](./src/goals/README.md) | 保存会话目标、版本、执行请求、等待与模型尝试用量。 |
| [src/memory/](./src/memory/README.md) | 从会话中提取长期记忆，并维护压缩后继续对话所需的会话记忆文件。 |
| [src/notes/](./src/notes/README.md) | 保存笔记索引，并协调 Markdown 文件与记录修订。 |
| [src/office/](./src/office/README.md) | 提供文档字节、文件读取、文字提取和内置引擎定位。 |
| [src/permissions/](./src/permissions/README.md) | 保存权限请求、处理结果和决策作用范围。 |
| [src/plugin-apps/](./src/plugin-apps/README.md) | 保存插件应用的身份、状态、修订及操作归属。 |
| [src/projects/](./src/projects/README.md) | 保存项目路径、名称、固定状态、默认 Shell 和位置历史。 |
| [src/runs/](./src/runs/README.md) | 保存运行、执行尝试、子任务及相关计时信息。 |
| [src/schedules/](./src/schedules/README.md) | 保存定时计划、执行历史，并计算下一次触发时间。 |
| [src/session-runtime/](./src/session-runtime/README.md) | 组装各领域读写能力，管理应用独占使用许可、事件等待、恢复和保留策略。 |
| [src/sessions/](./src/sessions/README.md) | 保存会话属性、工作树绑定，并提供默认标题识别与标题生成。 |
| [src/token-estimation/](./src/token-estimation/README.md) | 提供不依赖模型请求的文本 Token 数量估算。 |
| [src/tool-outputs/](./src/tool-outputs/README.md) | 集中定义工具结果内联、预览和压缩的长度规则。 |
| [src/workflows/](./src/workflows/README.md) | 保存工作流运行、任务尝试、事件及执行占用记录。 |
| [scripts/](./scripts/README.md) | 维护数据库测试清单，并检查打包后能否应用迁移链。 |
| [resources/](./resources/README.md) | 保存开发与打包所需的服务资源目录。 |

## 一次修改如何保存

1. 应用通过 SessionStore 创建的领域 Repository（负责一类记录的读写）或 Transaction（负责需要一起完成的操作）提交修改。
2. 事务协调器记录原值与待保存对象，在同一事务中完成关联修改；失败时恢复相应状态。
3. 正式会话通过数据库持久化接口保存到 SQLite；临时会话使用内存中的会话与控制记录。
4. 已提交事件交给等待与监听者，调用方读取领域查询结果。流式文本通过增量检查点定期保存，关闭存储时保存剩余变化。

数据库连接和迁移在 database，共享会话状态及保存映射在 session-runtime/persistence，各领域保存自己的记录转换、操作参数与事务规则。

## 公开入口与检查

`@vykor/services` 仍通过 [src/index.ts](./src/index.ts) 提供主要接口；`@vykor/services/memory-extract` 指向 [记忆提取实现](./src/memory/memory-extract.ts)，`@vykor/services/workflows` 指向 [工作流记录入口](./src/workflows/index.ts)。跨包使用优先从这些公开入口导入。

测试位于被测分类同层的 `__test__/`，共用层级的测试留在共同上层。分类 README 说明入口、流程、状态归属与新增代码的放置位置。

```bash
pnpm --filter @vykor/services check-types
pnpm --filter @vykor/services test
pnpm --filter @vykor/services db:check
pnpm --filter @vykor/services test:bundled-baseline
pnpm test:server-client
pnpm check:retired-ui
pnpm check-docs
```
