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
