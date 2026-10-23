# 消息渠道

定义渠道配置、投递与运行状态。

## 主要文件

| 文件 | 主要导出 |
| --- | --- |
| [channel-runtime.ts](./channel-runtime.ts) | `ChannelRuntimeState`、`ChannelDomain`、`ChannelConnectorRuntimeStatus` |
| [channel.ts](./channel.ts) | `DurableChannelMessageInput`、`DurableChannelMessageResult`、`RecordChannelDeliveryInput` |

## 入口与处理步骤

主要入口或定义见 [channel-runtime.ts](./channel-runtime.ts)。

渠道服务产生配置和运行信息，客户端按这些定义读取，控制请求经校验后回到渠道服务。

## 状态放在哪里

这里只定义和校验传输数据；业务数据由 Services 保存，客户端展示状态由 Client 保存。

## 新代码与测试

与本目录职责一起修改的代码放在这里；跨分类的公共入口由上层目录组织。

测试位于 [`__test__/`](./__test__)；只覆盖下级分类的测试放在对应分类的 `__test__/`。
