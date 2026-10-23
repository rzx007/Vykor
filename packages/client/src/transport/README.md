# HTTP 与事件流传输

实现 HTTP 请求、协议握手和 SSE 事件连接。

## 主要文件

| 文件 | 主要导出 |
| --- | --- |
| [http-client.ts](./http-client.ts) | `VykorClient` |
| [http-transport.ts](./http-transport.ts) | `HttpTransportOptions`、`HttpRequestOptions`、`RawRequestOptions` |
| [index.ts](./index.ts) | 统一导出本分类的类型与函数 |
| [sse-transport.ts](./sse-transport.ts) | `SseStreamOptions`、`SseRawFrame`、`parseRawSseFrame` |

## 入口与处理步骤

主要入口或定义见 [index.ts](./index.ts)。

发送请求前完成协议版本检查，再执行 HTTP 或事件流连接，把响应与连接错误交给上层。

## 状态放在哪里

远端业务数据由 daemon 保存；连接、订阅和展示状态保存在客户端对象中。

## 新代码与测试

与本目录职责一起修改的代码放在这里；跨分类的公共入口由上层目录组织。

测试位于 [`__test__/`](./__test__)；只覆盖下级分类的测试放在对应分类的 `__test__/`。
