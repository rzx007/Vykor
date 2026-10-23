# 协议客户端

在传输层之上统一处理协议请求和公共数据格式。

## 主要文件

| 文件 | 主要导出 |
| --- | --- |
| [index.ts](./index.ts) | 统一导出本分类的类型与函数 |
| [protocol-client.ts](./protocol-client.ts) | `IncompatibleProtocolError`、`CapabilitiesOptions`、`HealthOptions` |

## 入口与处理步骤

主要入口或定义见 [index.ts](./index.ts)。

资源接口提交操作与参数，协议客户端交给传输层发送，再把返回数据交还资源接口。

## 状态放在哪里

远端业务数据由 daemon 保存；连接、订阅和展示状态保存在客户端对象中。

## 新代码与测试

与本目录职责一起修改的代码放在这里；跨分类的公共入口由上层目录组织。

新增测试放在本目录的 `__test__/`；跨分类用例放在共同目录的 `__test__/`。
