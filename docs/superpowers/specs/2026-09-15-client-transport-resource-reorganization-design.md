# Client 与传输层重组设计

> 状态：设计已确认。
>
> 本文是业务代码重组阶段 5 的总体规格。阶段 5 只重组 Client HTTP/SSE transport、协议协商、业务 Resource 和 Server route 适配边界；不改变协议、URL、错误、用户行为或阶段 6 的 Desktop/Frontend 状态管理。

## 1. 背景

阶段 0–4 已完成 Services 持久化边界和 Server Application/Runtime 重组。当前新的集中点是 packages/client/src/transport/http-client.ts：

- 约 1854 行；
- 同时拥有 base URL、鉴权、fetch、错误转换、response 解码、上传下载、SSE，以及约 100 个业务 endpoint；
- System、Session、Attachment、Schedule、Terminal、Plugin 等业务方法平铺在 OpenHarnessClient；
- Desktop、Frontend、CLI、Client commands 和 tests 直接依赖完整 OpenHarnessClient；
- http-client.test.ts 也已接近 40 KB，难以判断一项修改影响哪个业务；
- Server routes 已使用阶段 4 Application Service，但个别 Route 仍可能夹带业务判断。

阶段 5 的目标不是发布新协议，而是让 transport 只处理网络，让每个业务 Resource 拥有自己的请求映射，并让旧 Client 方法退化为兼容转发。

## 2. 目标

1. 建立唯一 HttpTransport，拥有 URL、header、fetch、body、错误和 abort。
2. 建立唯一 SSE transport，拥有 frame、cursor、abort 和重连基础语义。
3. 协议协商由 ProtocolClient 独立拥有。
4. endpoint 按业务进入 Resource。
5. OpenHarnessClient 保留现有构造方式和全部平铺方法，通过 Resource 转发。
6. 新内部调用方改用窄 Resource，不依赖完整 Client。
7. Server route 只做 HTTP/SSE 适配，不拥有 Application 业务。
8. 上传、下载 Range 和 stream 不退化为全量缓冲。
9. httpClientFlatCalls 与超大文件指标只减不增。
10. 阶段 5 完成后，阶段 6 可直接消费 Resource 和无状态 Client state，而不必继续依赖万能 HTTP Client。

## 3. 不在本阶段处理

- 不改 URL、method、header、query、body、response、status 或错误 body。
- 不删除 OpenHarnessClient 平铺方法。
- 不改 reducer、sync 算法、React hook、Desktop IPC 或 UI。
- 不修改 Server Application/Runtime 业务。
- 不引入 axios、ky、OpenAPI generator、GraphQL、WebSocket 或新状态库。
- 不建立 BaseResource、ResourceFactory、Service Locator。
- 不为所有响应建立重复 wrapper 类型。
- 不重新命名公共协议类型。
- 不修已知 WSL/node-pty 并发环境问题。

## 4. 核心原则

### 4.1 Transport 不懂业务

Transport 可以知道 HTTP method、URL、header、body、status、JSON、bytes、stream 和 AbortSignal。它不能知道 Session、Goal、Plugin 或 Job 的字段含义。

### 4.2 Resource 拥有 endpoint 映射

Resource 知道路径、请求体、query、decoder 和业务返回类型，但不重复鉴权、fetch 和通用错误处理。

### 4.3 公共兼容优先

旧 client.getSession(id) 等方法保留，内部调用 client.sessions.get(id)。旧方法只转发，不能保留 endpoint 字符串或 decode 规则。

### 4.4 解码靠近业务

通用 responseField/responseArray 可由 transport decode helper 提供；具体 parseSession、decodeJob 等由对应 Resource 调用。Transport 不建立业务 decoder registry。

### 4.5 流式路径保持流式

Attachment upload、download Range、Terminal SSE 和 Event SSE 保持现有流式行为。不得因抽象统一而先 response.arrayBuffer 或读取全部 stream。

### 4.6 最少抽象

每个 Resource 是一个具体类或对象，构造只接 Transport。没有继承层次、泛型 CRUD 或 endpoint 配置表。

## 5. 目标结构

packages/client/src：

- transport/http-transport.ts：请求、header、query、错误、JSON/empty/response。
- transport/sse-transport.ts：SSE frame 和连接。
- transport/url.ts：仅当 URL/range helper 独立复用时存在。
- protocol/protocol-client.ts：health、capabilities、兼容检查。
- resources/system-resource.ts。
- resources/project-resource.ts。
- resources/plugin-resource.ts。
- resources/session-resource.ts。
- resources/attachment-resource.ts。
- resources/permission-resource.ts。
- resources/schedule-resource.ts。
- resources/job-resource.ts。
- resources/terminal-resource.ts。
- resources/channel-resource.ts。
- resources/event-resource.ts。
- transport/http-client.ts：OpenHarnessClient 组合根和兼容转发。
- state 与 commands 保持目录，阶段 5 仅收窄其 Client 依赖。

实际 Resource 数量按真实共享规则合并。方法很少且共同变化的 Memory/Profile/Dream 可放 SystemResource；不得为一个方法强制建文件。

## 6. 5A Transport Kernel

HttpTransport 拥有：

- normalizeDaemonBaseUrl；
- baseUrl/token/fetchImpl；
- auth header；
- URL path 与 URLSearchParams；
- request JSON；
- response JSON/empty/Response；
- OpenHarnessApiError；
- responseField/responseArray；
- AbortSignal 透传；
- content-type 处理。

API 可以是：

    request<T>(path, options): Promise<T>
    requestUnknown(path, options): Promise<unknown>
    requestResponse(path, options): Promise<Response>
    headers(extra?): Headers

只实现真实 Resource 所需能力，不为未来 method 建 DSL。

SseTransport 拥有：

- fetch stream；
- text decoder；
- SSE data/event/id/retry 行解析；
- 空行 frame 完成；
- Last-Event-ID/cursor；
- abort；
- reconnect delay 基础语义；
- streamServerSentEvents 兼容导出。

5A 不移动业务 endpoint。

## 7. 5B Protocol Client

ProtocolClient 拥有：

- health；
- capabilities；
- parseServerCapabilities；
- CURRENT_PROTOCOL_VERSION；
- checkProtocolCompatibility；
- IncompatibleProtocolError；
- supportsFeature 的调用约定。

协议协商结果不建立全局可变缓存；调用方显式调用 capabilities，保持现有请求语义。Resource 不自行调用 capabilities，避免每次业务请求多一次网络。

## 8. 5C 基础 Resources

按耦合由低到高迁移：

- System：commands、settings、context、memory、profile、dream；
- Provider：providers、models、custom/catalog provider；
- Auth：status/login/logout；
- Project：list/inspect/rename/pin/shell/rebind/archive/init；
- Plugin：list/enable/disable/install/preview/uninstall/reload；
- Skill/Hook/Git：list/remove/diff/branch/status/commit。

每个 Resource：

- 只接 HttpTransport；
- 保持 endpoint 字符串和 encodeURIComponent；
- 保持 query 参数是否省略；
- 使用现有协议 decoder；
- 有独立测试文件；
- 不导入 OpenHarnessClient。

## 9. 5D Session Resource

SessionResource 拥有：

- list/get/create/update/fork/archive/delete；
- getState；
- listMessages/listMessageParts；
- admit/edit/promote/cancel/resume/interrupt；
- compact/rewind/remember/export/usage；
- Goal get/create/update/action。

保持 createPromptRequestId 行为和 caller-stable request id。Session commands 改依赖 SessionResource capability；state sync 只依赖 Session/Event Resource 的窄读取/流接口。

SessionResource 不拥有 reducer、busy 状态、当前选中 Session 或 UI 命令解析。

## 10. 5E 外部与执行 Resources

AttachmentResource：

- upload 原始 body；
- filename/content-type header；
- ReadableStream duplex；
- get/download Range；
- delete/scan/repair/gc。

PermissionResource：

- list/reply。

ScheduleResource：

- status/list/get/create/update/remove/trigger/runs/unread。

JobResource：

- list/background shell/read/wait/send/cancel。

TerminalResource：

- create/list/get/read/write/resize/signal/close；
- Terminal event stream。

ChannelResource：

- handle message、record delivery、status、pending deliveries。

EventResource：

- list durable events；
- SSE stream。

Terminal/Event 可以共享 SseTransport，但各自调用 decoder。

## 11. 5F OpenHarnessClient 兼容门面

OpenHarnessClient 构造：

1. 建立一个 HttpTransport；
2. 建立一个 SseTransport；
3. 构造 ProtocolClient 和 Resources；
4. 暴露 readonly protocol/sessions/...；
5. 保留旧平铺方法。

兼容方法示例：

    getSession(id, options) {
      return this.sessions.get(id, options);
    }

禁止旧方法继续拼 path、构造 body、调用 fetch 或 decode。

迁移内部调用方顺序：

- packages/client/src/commands；
- packages/client/src/state/sync；
- CLI 新代码；
- Desktop main feature service；
- Frontend hook 最后，只做类型依赖收窄，不重组状态。

阶段 5 不要求所有外部调用方立即改成新语法。现有公共调用可留给阶段 7–8。

## 12. Server Route 边界

只审计和修复明确越界：

Route 可以：

- 解析 path/query/header/body；
- 校验传输格式；
- 调用 DurableAgentApplication 命名服务；
- 映射 ApplicationError 到 HTTP；
- 写 JSON/bytes/SSE。

Route 不可以：

- 直接 Store/Repository；
- 决定 Run 状态转换；
- 实现 queue/steer/retry；
- 复制 Application 权限或附件引用规则；
- 保存业务状态。

已经是纯适配器的 Route 不移动。

## 13. 错误语义

OpenHarnessApiError 保持 name、status、body 和 message。网络错误、AbortError、JSON parse error 和 ProtocolDataError 不统一包成新的通用错误。

规则：

- 非 2xx 走唯一 throwResponseError；
- 错误 body 读取失败保持现语义；
- 204/empty response 不强行 json；
- decoder 错误保留字段 path；
- upload/download stream 错误不被吞；
- SSE malformed frame 的跳过/抛错行为保持现状。

## 14. 测试策略与新执行节奏

按用户确认的新节奏：

1. 先完成一个波次生产代码；
2. 只做必要 type quick check；
3. 5A–5F 全部完成后统一测试；
4. 一次性集中修复失败；
5. 最后统一代码审查。

最终测试：

- Client 全量；
- Server HTTP route；
- Desktop main feature；
- CLI；
- 全仓 types；
- architecture/docs/diff；
- 上传流、Range、SSE、abort、协议不兼容专项。

测试所有权：

- Transport：网络格式和错误；
- Resource：路径/body/query/decoder；
- Facade：转发一致；
- Commands/Sync：只依赖窄 Resource；
- Server Route：协议适配。

## 15. 架构护栏

- Resource 不得导入 OpenHarnessClient。
- Resource 不得直接 import Server。
- Transport 不得 import Client 业务 types 以外的 Resource。
- http-client.ts 新业务 endpoint 字符串只减不增。
- 新内部模块不得接受完整 OpenHarnessClient，除兼容公共入口和明确外部适配。
- Server Route 不得 import Store/Repository。
- httpClientFlatCalls 只能下降。
- 禁止 any 绕过 Resource capability。

## 16. 多人分派

顺序：5A → 5B → 5C → 5D → 5E → 5F。

5C 不同 Resource 可以并行实现，但 http-client.ts 接线和 index 导出由一个集成人修改。5D/5E 可能共享 Transport 测试，先约定公开方法再并行。5F 必须基于全部 Resource 合入后的 main。

每个执行者报告：

- 起始 commit；
- 迁移方法表；
- endpoint 数；
- 兼容方法；
- 测试命令和数量；
- http-client 行数；
- flat call 基线；
- 未迁调用方；
- 越界声明。

## 17. 完成条件

- Transport 不含业务 endpoint。
- ProtocolClient 是协议协商唯一所有者。
- 所有平铺 endpoint 已进入 Resource。
- OpenHarnessClient 只组合和转发。
- commands/sync 使用窄 capability。
- Server Route 不拥有业务状态机。
- HTTP/SSE/上传/下载/Range 行为兼容。
- Client/Server/Desktop/CLI/Types/Architecture/Docs 验证通过。
- httpClientFlatCalls 和大文件指标下降且 baseline 未上调。
- 阶段状态标记 0–5 完成、阶段 6 未开始。

## 18. 后续边界

阶段 6 才拆 Desktop/Frontend state、SSE connection/cursor/router、selector 和 feature UI。阶段 7–8 才集中处理公共 API deprecated 和删除平铺兼容方法。
