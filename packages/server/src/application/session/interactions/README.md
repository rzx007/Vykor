# 会话输入与交互

处理用户输入的解析、编辑、队列操作和权限回复。

## 入口与流程

输入物化器把附件、技能与会话引用转换为可执行输入；选择校验器检查引用；交互服务协调输入变更与队列动作，再调用运行服务。

## 状态归属

输入与权限请求通过会话存储保存，操作串行和事件提交由上层 SessionOperationRunner 负责。

## 主要文件

| 文件 | 主要接口或用途 |
| --- | --- |
| [request-selection-validation.ts](./request-selection-validation.ts) | `validateRequestSelection` |
| [session-input-materializer.ts](./session-input-materializer.ts) | `SessionInputCatalogSkill`、`SessionInputSkillCatalog`、`SessionInputConversationCatalog`、`MaterializedSessionInput` 等 |
| [session-interaction-service.ts](./session-interaction-service.ts) | `SessionInteractionService` |
| [session-interaction-types.ts](./session-interaction-types.ts) | `SessionInteractionSessions`、`SessionInteractionConversations`、`SessionInteractionRuns`、`SessionInteractionServiceContext` 等 |

## 测试与维护

输入内容转换和交互动作放在这里；执行排队与取消放在 execution，插件权限策略放在 plugins。

测试放在本分类同层的 `__test__/`；覆盖多个子分类的测试放在共同上层的 `__test__/`。迁移文件时同步导入、公开入口、文档链接与旧引用清单。
