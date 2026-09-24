# Client 阶段 5E：执行与外部 Resources 实现计划

> **面向 AI 代理的工作者：** 批量完成 Attachment、Permission、Schedule、Job、Terminal、Channel、Event Resource，再统一测试。

**目标：** 迁移剩余执行、外部集成和流式 endpoint，保持 upload/download/SSE 的流式与错误行为。

**架构：** 普通 Resource 使用 HttpTransport；Terminal/Event stream 使用 SseTransport 和各自 decoder。Attachment 原始 body/Response 不经过 JSON 抽象。

**技术栈：** TypeScript、Fetch/ReadableStream、HttpTransport、SseTransport、protocol decoders。

---

## 文件

- attachment-resource.ts
- permission-resource.ts
- schedule-resource.ts
- job-resource.ts
- terminal-resource.ts
- channel-resource.ts
- event-resource.ts
- resources/index.ts

## 批量实现

- [ ] Attachment：upload/get/download/delete/scan/repair/gc。
- [ ] 保持 filename encode、content-type、ReadableStream duplex、Range、Response headers 和下载 body。
- [ ] Permission：list/reply，保持 filters 和 reply body。
- [ ] Schedule：status/list/get/create/update/remove/trigger/runs/unread。
- [ ] Job：list/background shell/read/wait/send/cancel，保持 cursor/range/timeout 和 decodeJob*。
- [ ] Terminal：create/list/get/read/write/resize/signal/close。
- [ ] Terminal stream 使用 SseTransport + decodeTerminalEvent。
- [ ] Channel：handle message/record delivery/status/pending。
- [ ] Event：list durable、stream；保持 afterSeq/Last-Event-ID。
- [ ] VykorClient 公开所有 Resource；旧方法一行转发。
- [ ] Desktop feature service 可逐步改用 resource property，但不重组 IPC/状态。
- [ ] CLI 新代码可用 Resource；公共调用保留。
- [ ] 快检 Client/Server/CLI/Desktop 类型。
- [ ] 按 Attachment、Execution、Stream/Channel 三个提交点提交。
- [ ] 确认 http-client.ts 不含剩余业务 endpoint。

## 统一测试清单

- upload stream 未预读；
- download Range/suffix/open range；
- Job read/wait cursor；
- Terminal binary/text event；
- Event cursor/reconnect/abort；
- Schedule CRUD 与 optional fields；
- Channel idempotency/status；
- facade/direct resource 一致。

## 审核重点

流式不缓冲；Terminal/Event decoder 不混；Range 边界不变；旧 Client 只转发；Desktop 不提前进入阶段 6。
