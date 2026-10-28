# 服务入口

汇总共享存储、领域读写、附件、记忆和 Office 能力。

## 入口与流程

`index.ts` 为 `@vykor/services` 汇总接口。调用方打开 SessionStore 后使用各领域的读写对象；记忆提取和工作流还分别提供稳定的包子入口。

## 状态归属

持久记录由数据库、附件和记忆文件保存；SessionStore 管理打开期间的状态、事务和事件订阅。

## 主要文件

| 文件 | 主要接口或用途 |
| --- | --- |
| [index.ts](./index.ts) | 汇总本分类的接口 |

## 子目录

| 目录 | 用途 |
| --- | --- |
| [attachments/](./attachments/README.md) | 管理附件状态、限制、输入引用和错误，并汇总附件子目录。 |
| [channels/](./channels/README.md) | 保存外部渠道会话映射、消息投递结果及平台附加信息。 |
| [conversations/](./conversations/README.md) | 管理输入、消息、消息部件、增量输出以及会话树操作。 |
| [database/](./database/README.md) | 打开 SQLite、应用迁移链，并为领域模块提供数据库和共享状态接口。 |
| [goals/](./goals/README.md) | 保存会话目标、版本、执行请求、等待与模型尝试用量。 |
| [memory/](./memory/README.md) | 从会话中提取长期记忆，并维护压缩后继续对话所需的会话记忆文件。 |
| [notes/](./notes/README.md) | 保存笔记索引，并协调 Markdown 文件与记录修订。 |
| [office/](./office/README.md) | 提供文档字节、文件读取、文字提取和内置引擎定位。 |
| [permissions/](./permissions/README.md) | 保存权限请求、处理结果和决策作用范围。 |
| [plugin-apps/](./plugin-apps/README.md) | 保存插件应用的身份、状态、修订及操作归属。 |
| [projects/](./projects/README.md) | 保存项目路径、名称、固定状态、默认 Shell 和位置历史。 |
| [runs/](./runs/README.md) | 保存运行、执行尝试、子任务及相关计时信息。 |
| [schedules/](./schedules/README.md) | 保存定时计划、执行历史，并计算下一次触发时间。 |
| [session-runtime/](./session-runtime/README.md) | 组装各领域读写能力，管理应用独占使用许可、事件等待、恢复和保留策略。 |
| [sessions/](./sessions/README.md) | 保存会话属性、工作树绑定，并提供默认标题识别与标题生成。 |
| [token-estimation/](./token-estimation/README.md) | 提供不依赖模型请求的文本 Token 数量估算。 |
| [tool-outputs/](./tool-outputs/README.md) | 集中定义工具结果内联、预览和压缩的长度规则。 |
| [tool-results/](./tool-results/README.md) | 复用已有操作结果，提供重启后可读取的引用、文本分页和字面检索。 |
| [workflows/](./workflows/README.md) | 保存工作流运行、任务尝试、事件及执行占用记录。 |

## 测试与维护

根目录保留公开入口，具体实现放入对应职责目录。

测试放在所属分类同层的 `__test__/`；覆盖多个子分类的测试放在共同上层的 `__test__/`。迁移时同步导入、公开入口、资源地址、文档和旧引用清单。
