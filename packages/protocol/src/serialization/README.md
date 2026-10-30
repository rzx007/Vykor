# JSON 与序列化

统一 JSON 数据检查、规范编码和协议序列化。

## 主要文件

| 文件 | 主要导出 |
| --- | --- |
| [json.ts](./json.ts) | `isUuid`、`isNonnegativeInteger` |
| [serialization.ts](./serialization.ts) | `ProtocolDataError`、`decodeSessionEventRecord`、`deserializeSessionEventRecord` |

## 入口与处理步骤

主要入口或定义见 [json.ts](./json.ts)。

调用方传入待编码或检查的数据，执行 JSON 约束与大小等检查，再返回编码结果或校验结果。

`decodeAgentSessionStateSnapshot` 复用会话快照校验，并只返回生命周期字段，供公开 SDK 使用。`decodeSessionStateSnapshot` 保留应用附加字段，供内部应用和服务端使用；两者共用同一套字段校验。

## 状态放在哪里

这里只定义和校验传输数据；业务数据由 Services 保存，客户端展示状态由 Client 保存。

## 新代码与测试

与本目录职责一起修改的代码放在这里；跨分类的公共入口由上层目录组织。

测试位于 [`__test__/`](./__test__)；只覆盖下级分类的测试放在对应分类的 `__test__/`。
