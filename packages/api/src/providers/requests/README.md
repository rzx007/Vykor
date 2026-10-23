# 请求头与请求生命周期

管理一次模型请求的请求头、建立连接超时、流空闲超时和取消信号。

## 主要文件

- [request-header-templates.ts](request-header-templates.ts)：规范化请求头并展开 sessionId 与 userAgent 模板。
- [retry.ts](retry.ts)：创建一次请求的计时和中止控制器。

## 调用与状态

`normalizeRequestHeaderTemplates`、`expandRequestHeaderTemplates`、`VYKOR_USER_AGENT` 和模板错误类型通过包根公开；`createRequestLifecycle` 由三类客户端内部使用。

先校验请求头名称、重复项及换行，再展开模板。请求启动后计时等待首个事件，首个事件到达后改为流空闲计时，后续事件重置计时；结束时 `dispose` 清理计时器和取消监听。

每次 `createRequestLifecycle` 独立保存 AbortController 和计时器。文件名虽为 retry，请求重试决策属于上层；这里仅提供单次请求的超时与取消信息。

## 新增代码与测试

同一职责的新代码放在本目录。测试放同层 [__test__/](__test__/)，跨分类场景放它们共同上层的 `__test__/`。
