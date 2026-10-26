# 会话与事件资源

访问会话、附件及事件流相关接口。

## 主要文件

| 文件 | 主要导出 |
| --- | --- |
| [attachment-resource.ts](./attachment-resource.ts) | `AttachmentResource` |
| [event-resource.ts](./event-resource.ts) | `EventResource` |
| [session-resource.ts](./session-resource.ts) | `createPromptRequestId`、`SessionResource` |

## 入口与处理步骤

主要入口或定义见 [attachment-resource.ts](./attachment-resource.ts)。

调用方提交会话操作或附件请求，资源接口构造协议请求并返回服务端结果；事件入口把后续更新交给状态模块。

提交、编辑和 resume 都只接受显式 `outputSchema`，发送前检查服务端 `structuredDelivery` 能力。metadata/runMetadata 中的同名字段是服务端记录快照，新请求使用时明确拒绝。resume 沿用原合同，显式字段只能重复原 schema。

## 状态放在哪里

远端业务数据由 daemon 保存；连接、订阅和展示状态保存在客户端对象中。

## 新代码与测试

与本目录职责一起修改的代码放在这里；跨分类的公共入口由上层目录组织。

测试位于 [`__test__/`](./__test__)；只覆盖下级分类的测试放在对应分类的 `__test__/`。

人工核对通过 `client.sessions.listUnknownToolOperations(sessionId)` 列出同根会话树的 unknown，以及原 Run 已结束但仍为 dispatching 的操作，`inspectToolOperation(sessionId, operationId)` 读取有界输入及结果预览，再通过 `reconcileToolOperation` 提交版本和人工核对证据。dispatching 附带 `recoveryHint`，需按提示排查存储、等待调用结束、确认旧 daemon 停止并重启恢复，不能直接人工解除。详情可能含原工具数据，仅供已认证宿主查看，不自动注入模型。它们不向模型注册新工具，也不会自动重试操作。

```ts
const pending = await client.sessions.listUnknownToolOperations(sessionId);
const detail = await client.sessions.inspectToolOperation(sessionId, pending[0]!.operationId);
const updated = await client.sessions.reconcileToolOperation(sessionId, detail.operationId, {
  expectedRevision: detail.revision,
  outcome: "not_applied",
  evidence: "人工只读查询确认目标记录不存在",
});
```

`unknown` 仅保存证据；`applied` 没有经核实且明确标记 completed 的 `ToolExecutionResult` 时仍为 unknown。存在真实响应时可在同一请求提供 `result`（保留原 `toolUseId`、`toolName`，以及响应中已有的 operation/attempt 身份）。400 表示输入不合规；409 可能表示修订冲突、原运行仍活跃、底层调用尚未结束或回执需要启动恢复。收到拒绝后按响应提示处理，再重新读取和核对，不能自动重提。
