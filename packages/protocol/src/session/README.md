# 会话数据

定义会话快照、输入、模型配置、目标及会话请求。

## 主要文件

| 文件 | 主要导出 |
| --- | --- |
| [session-goals.ts](./session-goals.ts) | `parseCreateSessionGoalInput`、`parseUpdateSessionGoalInput`、`parseGoalActionInput` |
| [session-input-items.ts](./session-input-items.ts) | 统一导出本分类的类型与函数 |
| [session-model.ts](./session-model.ts) | 统一导出本分类的类型与函数 |
| [session-requests.ts](./session-requests.ts) | `CreateSessionInput`、`ForkSessionInput`、`UpdateSessionInput` |
| [session.ts](./session.ts) | `AgentSessionStateSnapshot`、`SessionStateSnapshot` |

## 入口与处理步骤

主要入口或定义见 [session-goals.ts](./session-goals.ts)。

请求进入会话服务后，服务端按这些字段构造快照和事件；客户端引用相同定义完成解析和展示。

`AgentSessionStateSnapshot` 只包含会话生命周期数据，公开 SDK 将它导出为 `SessionStateSnapshot`。服务端和内部应用使用扩展后的 `SessionStateSnapshot`，保留插件应用附加数据；线上响应格式不变。

## 状态放在哪里

这里只定义和校验传输数据；业务数据由 Services 保存，客户端展示状态由 Client 保存。

## 新代码与测试

与本目录职责一起修改的代码放在这里；跨分类的公共入口由上层目录组织。

测试位于 [`__test__/`](./__test__)；只覆盖下级分类的测试放在对应分类的 `__test__/`。
