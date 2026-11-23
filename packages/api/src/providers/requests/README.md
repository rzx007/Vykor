# 请求头与请求生命周期

管理一次模型请求的请求头、建立连接超时、流空闲超时和取消信号。

## 主要文件

- [request-header-templates.ts](request-header-templates.ts)：规范化请求头并展开 sessionId 与 userAgent 模板。
- [retry.ts](retry.ts)：创建一次请求的计时和中止控制器。
- [private-image-request.ts](private-image-request.ts)：使用 SDK 的认证和连接发送临时截图，流式解析时只保留错误分类和重试信息。

## 调用与状态

`normalizeRequestHeaderTemplates`、`expandRequestHeaderTemplates`、`VYKOR_USER_AGENT` 和模板错误类型通过包根公开；`createRequestLifecycle` 由三类客户端内部使用。

先校验请求头名称、重复项及换行，再展开模板。请求启动后计时等待首个事件，首个事件到达后改为流空闲计时，后续事件重置计时；结束时 `dispose` 清理计时器和取消监听。

每次 `createRequestLifecycle` 独立保存 AbortController 和计时器。文件名虽为 retry，请求重试决策属于上层；这里仅提供单次请求的超时与取消信息。

OpenAI 和 Anthropic 收到临时截图时使用 `requestWithPrivateImage`。它沿用 SDK 构建的地址、请求头和连接设置，直接读取流式响应，避免 SDK 调试日志打印请求正文或回显。Codex 使用原生 `fetch` 发送和读取响应。

## 新增代码与测试

同一职责的新代码放在本目录。测试放同层 [__test__/](__test__/)，跨分类场景放它们共同上层的 `__test__/`。
