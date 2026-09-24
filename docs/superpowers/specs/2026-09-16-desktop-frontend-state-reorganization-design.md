# Desktop 与 Frontend 状态边界重组设计

> 状态：设计已确认。
>
> 阶段 6 只重组 Desktop main、renderer store 与 Frontend 同步状态所有权，不改变视觉、交互、IPC、HTTP/SSE 协议或用户行为。

## 1. 背景

阶段 5 已将 Client 拆成 Transport、Protocol 和 Resources。当前集中点转移到消费层：

- apps/frontend/src/hooks/useServerSync.ts 约 1333 行，同时管理 Client、连接、重连、snapshot/event、权限、Jobs、输入和 UI 派生；
- 对应测试约 2848 行；
- Desktop main session-service.ts 约 1152 行，同时管理 daemon 启停、Client 创建、同步订阅、Session 操作和 IPC-facing 状态；
- Renderer session-actions.ts 约 926 行，和 prompt/project/goal/attachment actions 共同读写大型 Zustand 状态；
- Client reducer/sync 已提供跨平台 durable state 基础，但 Desktop/Frontend 仍有局部重复对账和连接规则。

## 2. 目标

1. 明确 durable remote、connection、operation、draft、view 与 platform 状态所有者。
2. 一个 daemon event 只经过一个 durable 对账入口。
3. SSE connection/cursor/retry/router 独立于 React 和 Electron。
4. Frontend hook 只组合 controller 与 React state。
5. Desktop main SessionService 拆成 daemon connection、subscription 和 session operations。
6. Renderer store 按 feature 组织 action，纯对账逻辑可测试。
7. Desktop 与 Web 共享 Client Resource 和纯函数，不共享平台容器。
8. 旧 IPC、hook 返回值和 Zustand public actions 保持兼容。
9. 不进行视觉改版。

## 3. 不处理

- 不改变组件视觉、布局、文案或交互。
- 不改 HTTP/SSE/IPC schema。
- 不引入 Redux、XState、RxJS 或新状态库。
- 不把 Electron API 放进共享 Client。
- 不删除兼容 actions/hooks。
- 不进行阶段 7 公共 API 收口。
- 不合并 Desktop 与 Web 应用。

## 4. 状态分类

Durable remote：Session/Input/Message/Part/Run/Task/Permission/Event cursor。唯一基础模型为 packages/client state reducer/snapshot。

Connection：daemon registry、client instance、connected/reconnecting/error、subscription generation、AbortController、retry timer。由各平台 connection controller 拥有。

Operation：正在执行的 create/update/archive/prompt/upload/job 操作、错误和 optimistic token。由对应 feature store/hook 拥有。

Draft：composer text、attachments、skill/plugin selection、edit state。只在 renderer/frontend composer feature。

View：selected session/project、panel、scroll、filters。只在 UI store。

Platform：window/tray/updater/filesystem/terminal/webview/IPC。只在 Desktop main/preload。

## 5. 6A 状态所有权与纯对账

建立状态矩阵和架构护栏。Client state reducer 是 durable event/snapshot 唯一基础入口。平台层不得手写第二套 Message/Run/Task merge。

提取真正跨 Desktop/Web 的纯函数时，优先放 packages/client/state；只有两个真实调用方使用才共享。React hook、Zustand action 和 Electron listener 不进入 Client 包。

## 6. 6B SSE Connection、Cursor 与 Router

建立无 UI 的同步 controller：

- 输入 Session/Event Resource；
- snapshot-first attach；
- durable cursor；
- live SSE；
- gap catch-up；
- reconnect/backoff；
- abort/generation fencing；
- connected/reconnecting/error 通知；
- 一个 event 调用一次 applyEvent。

可复用 packages/client syncEvents；若其已完整表达，不新建重复 controller，只在平台写生命周期 adapter。

Router 只按 event scope/sessionId 将结果交给目标 feature，不复制 reducer。

## 7. 6C Frontend Hook

将 useServerSync 拆成：

- client factory/connection lifecycle；
- remote state subscription；
- permission selection；
- Jobs polling/stream adapter；
- React view model；
- action callbacks。

Hook 对外返回结构保持。每个子模块接受窄 Resource capability。React effect 只负责订阅/清理，不实现业务 merge。

## 8. 6D Desktop Main Session Service

拆分：

- DaemonConnectionService：registry、spawn/connect/verify、client refresh。
- SessionSubscriptionService：syncEvents、generation、abort、snapshot/event 通知 IPC。
- SessionOperations：Session/Prompt/Permission/Goal/Job 等 Resource 调用。
- SessionService：兼容门面和少量组合。

不创建通用 container。现有 IPC handlers 继续依赖 SessionService public surface，内部转发。

## 9. 6E Renderer Store

规则：

- durable SessionView 只能由 snapshot/event reconciliation 更新；
- optimistic action 通过 token/operation state，不直接伪造 durable terminal 状态；
- prompt/project/goal/attachment action 各自只改本 feature；
- notification observer 只观察变化，不二次应用事件；
- selectors 纯函数；
- runtime cleanup 清 live/view/operation，不删除 durable 数据，除非明确 logout/reset。

保留现有 Zustand store 和 action names，逐步让旧大 action 文件转发。

## 10. 6F 收尾

- 迁移调用方到新 controller/feature；
- 旧 Hook/Service/Store actions 保留兼容转发；
- 删除无调用重复 merge/helper；
- 更新目录 README；
- 架构规则禁止 renderer 导入 Desktop main、Frontend 导入 Electron、平台层复制 client reducer；
- 状态文档标 0–6 完成、阶段 7 未开始。

## 11. 错误与并发

- 旧 subscription 的迟到事件受 generation fence 拒绝；
- abort 不记录为用户错误；
- reconnect 不清空已确认 durable state；
- snapshot cursor 比当前旧时不得回退；
- event seq 重复/旧值保持幂等；
- permission 只显示当前 session 最早 pending；
- optimistic 失败恢复局部 operation/draft，不重建整个 store；
- daemon restart 使用新 Client 和 snapshot 重建，不复用旧 stream。

## 12. 测试节奏

按用户要求：

1. 6A–6F 先完成生产代码；
2. 期间只做必要类型快检；
3. 全部完成后统一测试；
4. 集中修复；
5. 最终统一审查。

最终覆盖：

- Client state/sync；
- Frontend useServerSync 与 App；
- Desktop main Session/IPC；
- Renderer store integration/actions/selectors；
- Desktop/Frontend types；
- architecture/docs/diff；
- restart、reconnect、stale event、abort、optimistic rollback。

## 13. 架构护栏

- Frontend 不导入 Electron/Desktop main。
- Renderer 不导入 Desktop main 实现。
- Desktop main 不导入 renderer store。
- Platform adapter 不复制 applyEvent/applySessionSnapshot。
- 新 feature 不接完整 VykorClient，使用 Resource capability。
- useServerSync 与 SessionService 大文件行数记录趋势，不以硬阈值驱动无关拆分。
- 旧兼容入口调用只减不增。

## 14. 分派顺序

6A 状态矩阵与纯规则 → 6B sync controller → 6C Frontend → 6D Desktop main → 6E Renderer → 6F 集成。

6C、6D 可在 6B 接口固定后并行；6E 依赖 Desktop subscription event shape；6F 串行。

## 15. 完成条件

- event/snapshot 只有一个 durable 对账入口；
- connection/cursor/router 与 UI 框架分离；
- Frontend Hook 主要做组合；
- Desktop SessionService 主要做兼容组合；
- Renderer action 按 feature 且不重复业务；
- IPC/hook/store public surface 和视觉行为兼容；
- Desktop/Frontend/Client 测试与类型、架构、文档通过；
- 阶段 7 未提前开始。
