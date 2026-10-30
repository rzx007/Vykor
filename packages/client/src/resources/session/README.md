# 会话与事件资源

访问会话生命周期、附件及事件流。产品管理扩展由私有 [`@vykor/application-client`](../../../../application-client/README.md) 提供。

## 主要文件

| 文件 | 主要导出 |
| --- | --- |
| [attachment-resource.ts](./attachment-resource.ts) | `AttachmentResource` |
| [event-resource.ts](./event-resource.ts) | `EventResource` |
| [session-resource.ts](./session-resource.ts) | `createPromptRequestId`、`SessionResource` |

## 入口与处理步骤

`VykorClient` 将本目录的三个资源分别以 `sessions`、`attachments`、`events` 暴露，主要实现见上表。

调用方创建和配置 Session、提交与排队 Input、控制 Run、查询 Goal 与历史/结果/用量，或上传和读取附件。资源接口构造 HTTP 请求并返回 daemon 的记录；`events` 提供历史查询和 SSE 订阅，状态模块负责快照与事件合并。附件存储扫描/修复/清理、Desktop worktree 绑定清理属于私有应用客户端。

提交、编辑和 resume 都只接受显式 `outputSchema`，发送前检查服务端 `structuredDelivery` 能力。metadata/runMetadata 中的同名字段是服务端记录快照，新请求使用时明确拒绝。resume 沿用原合同，显式字段只能重复原 schema。

## 状态放在哪里

Session、Input、Run、Message、Goal、附件和事件游标由 daemon 保存；同步视图由调用方的状态模块保管。

## 新代码与测试

与本目录职责一起修改的代码放在这里；跨分类的公共入口由上层目录组织。

测试位于 [`__test__/`](./__test__)；只覆盖下级分类的测试放在对应分类的 `__test__/`。
