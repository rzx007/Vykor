# 模型请求错误

将 SDK、HTTP 和不完整消息流的错误转换成上层能识别的失败信息。

## 主要文件

- [index.ts](index.ts)：认证、限流、请求及协议错误分类，重试等待时间和统一失败转换。

## 调用与状态

包根公开 `AuthenticationFailure`、`RateLimitFailure`、`RequestFailure`；客户端在内部使用 `toModelRequestFailure`、`protocolFailure`、`streamIncompleteFailure` 等函数。

转换函数读取状态码、服务商错误字段和 Retry-After，生成带失败类别、阶段及是否可重试的 `ModelRequestFailure`，由客户端抛给上层处理。

错误对象携带本次失败的诊断，不维护请求列表或重试队列；是否再次发起请求由调用方决定。

## 新增代码与测试

同一职责的新代码放在本目录。测试放同层 [__test__/](__test__/)，跨分类场景放它们共同上层的 `__test__/`。
