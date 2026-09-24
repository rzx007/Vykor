# Client 阶段 5A：Transport Kernel 实现计划

> **面向 AI 代理的工作者：** 使用 superpowers:executing-plans 批量实现本计划。按用户要求，先完成本波次生产代码，只做必要类型快检；阶段 5 全部实现后统一运行测试和集中修复。使用复选框跟踪进度。

**目标：** 从 http-client.ts 提取唯一 HTTP 与 SSE 传输内核，不移动业务 endpoint。

**架构：** HttpTransport 处理 URL、鉴权、fetch、body、通用错误和响应；SseTransport 处理 frame、cursor、abort 和连接。业务 decoder 和 endpoint 仍暂留旧 Client。

**技术栈：** TypeScript、Fetch API、ReadableStream、TextDecoder、AbortSignal、Vitest。

---

## 文件

- 创建 packages/client/src/transport/http-transport.ts
- 创建 packages/client/src/transport/sse-transport.ts
- 创建 packages/client/src/transport/response.ts（只有 field/array/error helper 确实共用时）
- 修改 packages/client/src/transport/http-client.ts
- 修改 packages/client/src/transport/index.ts
- 最终统一修改 transport tests

## 批量实现

- [ ] 记录 normalizeDaemonBaseUrl、headers、request、throwResponseError、SSE parser、Range helper 的现有签名和调用点。
- [ ] 创建 HttpTransportOptions：baseUrl、token、fetch。
- [ ] 将 baseUrl/token/fetchImpl 和 header 构造迁入 HttpTransport。
- [ ] 提供 requestUnknown、requestJson<T>、requestResponse、requestEmpty；仅实现现有调用需要的选项。
- [ ] 保持 GET 默认、JSON content-type、Bearer token、AbortSignal、204/空 body 和非 2xx 错误语义。
- [ ] VykorApiError 仍公开，status/body/message/name 不变。
- [ ] normalizeDaemonBaseUrl 保持凭据、query、fragment 和协议拒绝行为。
- [ ] 创建 SseTransport，迁入 streamServerSentEvents 与 frame parser。
- [ ] 保持 data 多行拼接、event/id/retry、CRLF、空 frame、malformed data、abort 和 Last-Event-ID 行为。
- [ ] 保持 Attachment 原始 upload body、download Response/Range 和 duplex 能力，不能统一成 JSON。
- [ ] VykorClient 构造一个 HttpTransport/SseTransport；旧 endpoint 暂时通过内核请求。
- [ ] 删除 http-client.ts 中第二套 request/header/error/SSE 实现。
- [ ] 快检：packages/client TypeScript；不跑 Client 全量测试。
- [ ] 提交：refactor(client): extract http and sse transport kernel

## 阶段末统一测试清单

- URL 规范化全部边界；
- auth/no-auth/extra headers；
- JSON、empty、binary/stream；
- error JSON/text/unreadable body；
- abort；
- SSE 单/多行、cursor、retry、断流；
- upload 不缓冲，Range header 不变化；
- 兼容导出路径不变。

## 审核重点

Transport 不导入 Resource；不懂业务字段；没有通用 endpoint DSL；流式路径未缓冲；旧 Client 只剩一个 transport 实例。
