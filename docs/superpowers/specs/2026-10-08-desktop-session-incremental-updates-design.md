# Desktop 会话增量更新规格

> 状态：已审阅，按批准范围实施中；即使自动化测试通过，内存峰值仍需同场景性能复测验证。

## 1. 背景与目标

Desktop 主进程通过 `syncEvents` 接收会话状态。当前每个 50ms 合并窗口都会把最新客户端状态重新转换成完整 `DesktopSessionView`，再通过 Electron IPC 发给 Renderer。发送端不等待 Renderer 确认已处理更新，也没有对待处理更新设置上限。

本规格优化 Desktop 会话流式更新链路，保持健康情况下的可见更新节奏：

- 对高频 `session.message.part.delta`，发送带目标 part ID 和新增文本的轻量增量批次，不重新构建或传送完整会话历史。
- 对其他状态变化、首次打开和同步恢复，保留完整 `DesktopSessionView`，继续以它作为权威基线。
- 每订阅至多一条实时 IPC 更新在途；Renderer 将更新应用到本地权威状态后确认。健康时仍按默认 50ms 窗口发送；Renderer 处理落后时，只在主进程保留有界待发数据并合并中间帧。
- 增量只替换 Renderer 中的目标 part，保持未变化消息和 parts 的对象引用，复用现有 transcript 单文本追加快速路径。
- 无法安全应用增量、待发缓冲超限或发生结构变化时，以最新完整快照恢复，不丢最终正文。
- 不改变 daemon/SSE 所有权边界；不为改善性能而固定降到 100ms 或降低模型输出节奏。

这针对的是全量快照反复传输，以及发送速度超过 Renderer 处理速度时可能形成的待处理 IPC 积压。它仍不能证明全部内存都来自 IPC；Renderer 的 DOM、Markdown、堆内存和 GC 行为仍需运行时测量。

### 补充运行时观察

用户观察到，对话输出结束后，内存占用会逐渐下降，最终回到约 1GB。若这是同一个 Renderer 进程、且会话界面仍保持打开的前提下测得，这说明高占用与活跃生成阶段相关，且至少一部分内存可在任务结束后回收；它更支持“生成期间存在较高分配/暂存压力”的假设，而不是“内存持续增长且从不回收”的简单泄漏模型。

这仍不能区分 IPC/视图构建产生的临时对象、流式 Markdown/React 更新产生的临时对象、延迟 GC 或其他任务结束后的清理，也不能排除生成期间长期持有大量对象。规格因此要求分别记录空闲基线、输出期间峰值、任务结束后的回落速度和最终平台值，并保留 heap snapshot 检查；不能仅凭内存回落认定不存在泄漏，也不能把增量传输单独宣称为内存修复。

### 性能录制与生产者/消费者压力

用户提供的 Chromium Performance 录制覆盖约 6.78 秒，其中主线程约 5.32 秒处于忙碌状态、Scripting 约 3.98 秒，并多次经过 `ConversationTranscript` 和 `MessageScroller`。这说明 Renderer 在该场景承担了显著的脚本与渲染工作，能解释输入响应为何可能变慢；该录制不是 heap profile，也没有证明这些时间全部由会话 IPC 引起。

结合当前每 50ms 发送完整视图且没有消费确认的代码，一个需要通过实现验证的根因假设是：主进程持续生产完整更新，而 Renderer 忙于应用状态和绘制；未处理的快照及其序列化数据可能随输出时间积压。用户观察到任务结束后内存回落，与“活跃生产期间的分配/积压压力”相符。增加单飞确认和有界待发缓冲就是验证并限制这类积压的关键措施，不预设它是唯一根因。

作为实现参照，ZCode 保留 30ms 的 continuous 更新，通过 delta 合并，并把每个订阅的缓冲限制在 500 项和 1 MiB；任一上限溢出后设置 `resyncRequired`、停止积累 delta，并在下一次 flush 时发送快照。它的 `inFlight` / `commit` 用于防止同一帧重复预留，并确认传输层已接受发送，不代表 Renderer 已应用更新；目前没有本规格提出的应用级 ACK 等待与超时恢复机制。ZCode 的会话时间线还使用虚拟列表。本阶段借鉴有界缓冲和快照恢复，并额外为 Desktop 定义应用级确认与恢复；不照搬整套协议。历史虚拟化留待第一阶段复测后决定。

## 2. 源码现状与边界

- `SessionSubscriptionService.pumpSession` 当前把 `SyncEventUpdate` 放入固定 50ms 合并器；刷新时调用 `toDesktopSessionView`，再通过 `session:updated` 或 `session:aux-updated` 发送完整视图。
- 当前主、辅更新 IPC 没有 delivery acknowledgement（消费确认，即 Renderer 已同步应用该更新的回执），因此发送端不知道 Renderer 是否跟得上。
- `toDesktopSessionView` 会复制和整理 inputs、messages、parts、runs、tasks 与 permissions。
- 客户端 reducer 对 `session.message.part.delta` 只支持 `text` 和 `reasoning` 字段；增量事件带有 session、message、part 标识和新增字符串， transient delta 不进入持久事件历史。
- 客户端 reducer 对过期的 superseded model part delta 会保持原状态；`syncEvents` 对 reducer 未产生状态变化的事件不 yield。
- 主会话 Renderer 通过 `applySessionUpdate` 对账完整视图；它还会对账运行时操作、刷新项目状态，并可能刷新上下文用量。增量更新必须避开这些完整快照副作用。
- 当前 `mergeOptimisticTranscript` 会复制消息和 parts 数组，但保留其中未变对象的引用；`useTranscriptModel` 已有单文本追加快速路径。保留稳定 part 引用可复用该路径，避免每个完整视图把全部 part 当成新对象。
- 辅助会话通过 `openAux` 建立独立订阅；侧边聊天和 Agent 详情分别持有对应的完整视图。
- IPC 当前主、辅更新分别使用 `session:updated` 和 `session:aux-updated`。同一个订阅的快照与增量必须通过同一事件通道有序发送，不能拆成彼此无序的更新通道。
- 已有的 `desktop-session-stream-coalescing` 规格规定了 50ms 固定窗口、重连立即 flush 和订阅生命周期校验；本规格保留这些约定，只替换 delta-only 窗口的负载。

## 3. 方案比较与选择

### 方案 A：只在 Renderer 节流完整快照

实现简单，但主进程仍会按流式更新反复构建完整 `DesktopSessionView`，IPC 仍携带完整历史，不能解决本规格的主要成本来源。因此不采用。

### 方案 B：增量批次、消费确认和有界积压（采用）

为 `session.message.part.delta` 增加 Desktop 内部的增量消息；健康情况下每个 50ms 窗口发送一次。每订阅只允许一条实时更新在途，Renderer 应用后回执。等待回执时，主进程只累计最多 500 个增量操作或 1 MiB 的待发增量；相邻同目标、同字段的 delta 可拼接。遇到非 delta 状态变化、合并后超限或重连时，清除待发 delta 并只记录“需要快照”和最新客户端状态引用；收到回执后才构建并发送一次最新完整快照。

Renderer 对 part 采用结构共享更新：复制必要的容器，只替换目标 part，保留其他实体引用。增量成功应用后回执；无法应用时回执要求快照恢复。方案只改 Desktop 主进程、preload IPC 契约和 Renderer 接收路径；不改变 daemon、SSE、client reducer 或公开 SDK。

### 方案 C：把所有会话变化都改成实体级 patch

可以进一步减少普通状态变化的快照传输，但要为消息、输入、工具、run、task、permission、删除与 transcript 替换定义 patch 顺序、撤销和恢复语义；增加多个消费者的状态一致性风险。ZCode 的全量 row projection 与虚拟时间线也属于更广范围的改造。现阶段先限制待发 IPC 并减少文本路径的全量成本，只有第一阶段复测仍显示 DOM/Markdown 是主要压力时，才另行设计历史虚拟化或解析优化。

## 4. 行为规格

### 4.1 更新类型

Desktop 内部会话更新改为带标签的联合类型。字段名称是规格示意，实施时应遵循仓库现有 TypeScript 命名和类型组织：

```ts
type DesktopSessionUpdate =
  | {
      kind: "snapshot";
      subscriptionId: string;
      generation: number;
      deliveryId: string;
      view: DesktopSessionView;
    }
  | {
      kind: "part-delta";
      subscriptionId: string;
      generation: number;
      deliveryId: string;
      sessionId: string;
      deltas: DesktopSessionPartDelta[];
    };

interface DesktopSessionUpdateAck {
  subscriptionId: string;
  generation: number;
  deliveryId: string;
  result: "applied" | "resync-required";
}

interface DesktopSessionUpdateAckResult {
  accepted: boolean;
}

interface DesktopSessionResyncRequest {
  subscriptionId: string;
  generation: number;
  deliveryId: string;
  lastAppliedDeliveryId: string | null;
}

interface DesktopSessionPartDelta {
  seq: number;
  messageId: string;
  partId: string;
  field: "text" | "reasoning";
  delta: string;
  baseLength: number;
  createdAt: number;
  partSeq?: number;
}
```

要求：

1. 每个 delta item 保留其原始事件的 `seq`、message/part ID、字段、新增字符串和时间。批次不得把多个事件拼成一个无序字符串或丢掉中间文本。
2. `baseLength` 是该事件应用前目标 part 的 `text` 长度，按 JavaScript 字符串 `.length`（UTF-16 code units）计算；part 不存在时为 `0`。现有 `syncEvents` 提供 reducer 应用事件后的 state，因此主进程从后状态还原：已有 part 的前长度等于后状态长度减去本次 `delta.length`；首次创建的 part 前长度为 `0`。Renderer 用它确认基线未缺字。
3. `partSeq` 仅在客户端 reducer 因首次 delta 创建新 part 时提供，取 reducer 生成 part 的序号。Renderer 可据此使用与客户端相同的缺省字段建立 `text` 或 `reasoning` part。已有 part 的增量不重复携带累计文本。
4. Renderer 对每个 delta 按 `seq` 升序处理。`seq <= 当前视图 cursor` 的项目视为已由较新快照或重复更新覆盖，直接跳过。成功应用后将视图 cursor 推进到已应用事件的最大 `seq`，不得倒退。
5. delta 应用后将 `syncStatus` 设为 `connected`。主进程的重连通知仍以 `syncStatus: "reconnecting"` 的完整快照传达。
6. 快照分支保持现有 `DesktopSessionView` 字段及 cursor 语义。实时 snapshot 与 delta 都带 `subscriptionId`、单调递增的 `generation` 和唯一 `deliveryId`，并通过同一个 IPC 通道发送，以保持单个订阅内的发送顺序。初次 `open` / `openAux` 调用仍直接返回完整视图，不参与实时 delivery acknowledgement。
7. `deliveryId` 在订阅内唯一；每次同一订阅重新同步时 generation 加一。ACK 只确认当前 generation 中的当前 `deliveryId`；重复、过期或来自已替换订阅的 ACK 必须忽略，不能释放新订阅的发送槽。
8. `DesktopSessionUpdateAck.result === "applied"` 表示 Renderer 已同步地把更新纳入本地权威 store / view ref；不要求等待 React DOM 提交。`"resync-required"` 表示更新没有被部分应用，主进程应作废该 generation 中的旧投递并发送最新完整快照。ACK IPC 返回 `DesktopSessionUpdateAckResult`：`accepted: true` 表示该 ACK 已处理；`false` 表示 delivery 或订阅已过期，Renderer 丢弃该旧更新并等待当前订阅的更新，不重复确认或触发重同步。
9. Renderer 可发 `DesktopSessionResyncRequest` 主动要求同一订阅重新同步。请求必须匹配 Electron `sender`、当前 subscription ID 与 generation，并带上触发 watchdog 的 `deliveryId`。若该 delivery 已被 ACK，主进程按幂等成功处理，不再发快照；若它仍是当前 in-flight delivery，则作废它并开始新 generation 的快照恢复；generation 已过期则返回 `accepted: false`，Renderer 等待当前订阅更新。request ID 不作为权威 cursor。

### 4.2 主进程生产与合并

主进程为每个 primary 和 auxiliary 订阅继续使用固定 50ms 首次入队窗口，不因后续事件重置计时器。

- 收到有效的 `session.message.part.delta` 时，只记录轻量事件资料及从 reducer 后状态还原的 `baseLength` / 新建 part 的 `partSeq`；不要为该事件调用 `toDesktopSessionView`。
- 每个订阅至多有一条实时更新 in-flight。primary 和每个 auxiliary subscription 分别独立计数；不同订阅之间不互相阻塞。
- 若没有更新在途，一个 50ms 窗口到期时发送一个有序 delta 批次或完整快照，并启动对应 ACK 等待。健康消费者及时 ACK 时，连续输出仍约每 50ms 更新一次，不人为增加固定延迟。
- 若窗口到期时仍有更新在途，不再发送 IPC。将该窗口的增量放入待发缓冲，并从首次待发时刻起维持一个 50ms 合并窗口；后续更新不重置计时器。
- 待发缓冲上限为 500 个 delta item 且新增文本 UTF-8 序列化大小估算不超过 1 MiB，两个条件任一达到上限即进入 `snapshot-required` 状态。相邻的同 message/part/field delta 可以合并为一项，保留最早 `baseLength`、最新 `seq` 和最新时间；不同目标间保持事件顺序。单项超限也直接要求快照。操作数上限同时约束增量对象的额外开销；该字节预算是缓冲数据上限，不等同于精确的 V8 heap 测量值。
- 等待 ACK 期间出现任意非 delta 状态变化、重连 / 强制恢复、或 delta 缓冲超限时，清空待发 delta，置 `snapshot-required`，并只保留最新权威客户端状态引用；不得为每个后续事件反复构建快照。ACK 到达后，若 50ms 窗口已到期，则只对最新状态构建并发送一份快照；否则在该窗口到期时发送。快照 cursor 必须覆盖已丢弃的待发 delta。
- 如果有 delta 缓冲且没有更高优先级的 `snapshot-required`，收到 ACK 后在原 50ms 窗口边界发送一个合并后的 delta 批次。若尚未到边界则继续等待，不额外延迟健康情况下的首次发送。
- `source === "reconnecting"`、迭代器中断后的恢复边界和订阅初始加载都使用完整快照，不发送 delta 作为同步基线。没有 in-flight 更新时，强制 flush 立即发送快照；如果已有更新尚未 ACK，则只设置 `snapshot-required`，不得绕过单 in-flight 限制并发送第二条更新。
- Renderer 收到无法应用的更新时发送 `resync-required` ACK。主进程作废当前 delivery 并提升 generation，清除旧待发 delta，以最新完整快照作为该 generation 的第一条更新；在快照 ACK 前不发送 delta。此 ACK 是应用失败的唯一恢复入口，Renderer 不再为同一失败额外发重同步请求。
- Renderer 收到实时更新时启动该 delivery 的 5 秒 watchdog。成功 ACK 的主进程响应到达后，Renderer 取消 watchdog；若响应未在时限内到达，watchdog 发 `DesktopSessionResyncRequest`。同步 store 应用暂时阻塞 Renderer 主线程时，watchdog 会在主线程恢复调度后检查 ACK 状态，不会在阻塞期间制造额外 IPC。
- 主进程不另设超时定时器，也不自行重发更新。待 ACK 期间只按 500 项 / 1 MiB 上限保留增量；收到 Renderer 的重同步请求时，若原 delivery 已 ACK，则幂等返回成功，不发送快照；若仍在途，则作废旧 delivery、提升 generation，并发送最新完整快照；若 generation 已过期，则返回 `accepted: false`，等待当前订阅更新。这样 ACK 与 watchdog 同时触发时不会重复恢复。
- 若 Renderer 进程已退出，则由现有 WebContents 销毁与订阅重建流程清理旧订阅，新订阅从完整快照开始。
- 主会话的 plugin UI owner snapshot listener 继续忽略文本 delta；非 delta 事件仍按现有时机触发该 listener。
- 订阅替换、关闭、会话删除或 WebContents 销毁时，清除 ACK watchdog、窗口定时器、待发批次和 in-flight 状态。所有定时器发送、ACK 与重新同步请求都校验现有 `isDestroyed`、当前订阅代次和 session 存在性。
- 同一订阅不并行维护一个快照 coalescer 和一个 delta coalescer；每个时间窗的交付类型由窗口内是否出现非 delta 状态变化决定，以免快照与 delta 交错并造成重复追加。
- 快照本身的大小沿用现有契约，不计入 1 MiB delta 缓冲上限；单 in-flight 约束确保不会因不确认而无限累积多个完整快照。若单个权威快照自身仍占用过多内存，应作为后续快照尺寸 / transcript 虚拟化问题另行处理。

### 4.3 Renderer 应用与恢复

Renderer 提供一个纯状态转换逻辑，将单个 delta 批次应用到匹配的 `DesktopSessionView`。主会话 store、侧边聊天和 Agent 辅助会话都复用这一逻辑，避免各自实现不同的字符串追加规则。store 应用成功后才回 ACK；应用失败、不存在基线或发现不连续时，不得部分应用，回 `resync-required`。

- 只允许把 delta 应用到相同 `sessionId`、存在的 message 和可匹配的 part。
- 对已存在 part，要求 `part.text` 的当前长度等于 `baseLength`；然后只将 `delta` 追加到 `text`，并按现有客户端 reducer 规则更新 `updatedAt`。保留 part 其他字段。
- 对不存在的 part，只允许在 `baseLength === 0` 且收到 `partSeq` 时创建；字段类型按 `field` 设为 `text` 或 `reasoning`，状态为 `running`，文本为本次 delta，时间为 `createdAt`，metadata 为空对象。这与客户端 reducer 首次遇到 delta 时创建 part 的规则一致。
- 用结构共享方式更新：保留未变化 message、part、run 等对象引用，只创建新 transcript / message / parts 容器及目标 part 对象。不能将完整快照 reconciliation 用于增量路径。
- message 不存在、part 长度与 `baseLength` 不符、缺少创建所需字段、session 不匹配或批次内部顺序非法时，不部分应用批次、不推进 cursor；请求该订阅的完整快照以恢复。较旧 item 已由 cursor 覆盖的情况不算错误。
- 主会话切换到其他会话时，现有导航生命周期必须关闭或替换旧 primary subscription；已送达但在关闭后才处理的旧更新按过期 generation 丢弃，不 ACK、不触发恢复，也不占用新订阅发送槽。当前 primary subscription 的 delta 若因暂时缺少基线而无法应用，则发送 `resync-required`。辅助订阅即使暂时不可见，仍按其自身基线应用更新并 ACK。
- primary 恢复使用现有 `sessions.open(sessionId)` / `resyncActiveSessionSnapshot` 路径；auxiliary 恢复使用相同 `subscriptionId` 的 `sessions.openAux`。同一订阅只允许一个恢复请求在途；恢复返回的完整快照按现有 cursor 防倒退规则应用，并取代旧增量基线。
- 增量只改 transcript part 与 cursor/syncStatus，不触发完整快照的运行时操作对账、项目 Git 刷新、goal 刷新或上下文用量刷新。此类副作用依赖非 delta 状态，仍由完整快照路径处理。

### 4.4 主、辅订阅 API

- `sessions.onUpdated` 改为接收 `DesktopSessionUpdate` 联合类型；primary snapshot、primary delta 共用 `session:updated`。Renderer 在 store 同步接收后通过专用 ACK IPC 返回 `DesktopSessionUpdateAck`；watchdog 通过单独 IPC 发 `DesktopSessionResyncRequest`。
- `DesktopAuxSessionUpdate` 改为携带 `subscriptionId` 和 `DesktopSessionUpdate`；辅助 snapshot、辅助 delta 共用 `session:aux-updated`，ACK 与重同步请求都关联该 auxiliary subscription。
- ACK 和重同步请求的 handler 必须根据 Electron `sender`、当前 subscription generation 与 delivery ID 验证来源；不能允许 Renderer 指定任意 session 或替另一个窗口确认 / 重置订阅。无效 / 过期 ACK 与重同步请求返回 `accepted: false`，不改变订阅状态。
- `sessions.open` 与 `sessions.openAux` 继续返回完整 `DesktopSessionView`，因此打开会话的调用方仍以完整视图建立初始基线。
- preload 仅暴露 Desktop 内部 ACK 方法及已有会话更新 listener，不暴露新的 daemon、数据库或文件系统能力。
- 这是 Desktop 私有 API 契约变更，不修改 `@vykor/client`、`@vykor/protocol` 的公开 API，不修改持久化 schema 或事件格式。

## 5. 失败处理与一致性

1. delta 不可应用时，不忽略后续错误继续叠加，也不构造“看似成功”的空视图；保持当前已确认视图并请求完整快照。
2. 快照恢复成功后，以完整快照为唯一权威基线；其 cursor 之前的迟到 delta 被忽略。
3. 快照恢复失败时，保留现有会话视图并使用仓库已有的错误处理/重试入口，不伪报同步成功；不得在每条后续 delta 上无限并发创建恢复请求。
4. 主进程只在收到当前 `deliveryId` 的合法 ACK 后释放该订阅的 in-flight 槽。重复、无效、迟到或 generation 不匹配的 ACK 不改变状态；记录可诊断计数，但不得因此发送额外更新。
5. Electron IPC 对同一 WebContents、同一 channel 的发送顺序是本设计依赖的投递顺序；主进程仍按 ACK 串行交付。多个订阅之间不要求全局顺序。
6. ACK 长时间未到时，主进程不不断重发消息。它只将待发 delta 限制在硬上限内；Renderer watchdog 未在 5 秒内收到 ACK 接收确认时，发经过校验的同订阅重同步请求，由主进程提升 generation 并以最新快照替代仍在途的 delivery。若该 delivery 已被 ACK，则请求幂等完成，不额外发快照。Renderer 已退出时由销毁 / 重建订阅恢复。
7. 提升 generation 后，旧 generation 的迟到更新在 Renderer 端丢弃，迟到 ACK 在主进程端忽略；同一 IPC channel 的顺序保证新快照排在先前已发送更新之后。
8. 事件 seq 来自全局事件流，session-filtered 流中允许有数值空洞，不能用 `seq === cursor + 1` 判断丢失。缺字检测使用每个 part 的 `baseLength`，cursor 只用于旧事件去重与防倒退。
9. 重连完整快照可能覆盖尚未发送的 delta。由于快照 cursor 包含这些事件，随后到达的同 seq delta 会被 Renderer 安全跳过，不重复追加。
10. 溢出只允许丢弃中间 delta 帧，不允许丢失最终状态：进入 `snapshot-required` 后不得回到 delta 模式；下一次成功交付必须是最新权威快照。

## 6. 非目标

- 不改 SSE 事件协议、daemon、数据库、事件持久化、CLI/TUI 或其他客户端。
- 不把所有会话事件改为增量 patch，不按 token 改变模型输出节奏。
- 不调整 50ms 默认窗口，不增加用户可配置项，不新增依赖。
- 不承诺任意大的单个完整快照都有固定内存上限；本阶段限制 ACK 未返回时的待发积压，不限制完整 transcript 本身的体积。
- 不在本阶段实现 transcript 虚拟列表、Markdown worker、DOM 卸载、React memo 化或一般性的 Renderer 内存管理。
- 不声称仅凭 IPC 改造就修复了所有 Renderer 内存增长。若 IPC 载荷和视图构建明显下降而内存仍上升，应继续采集 heap snapshot 并追查渲染/缓存路径。

## 7. 验收标准

### 自动化契约

1. 健康 Renderer 在单一 50ms 窗口节奏下收到更新；每个 primary / auxiliary subscription 同时至多一条未确认的实时 IPC 更新。
2. 无 ACK 时 IPC 发送次数不增加；待发队列最多 500 项且不超过 1 MiB 的 UTF-8 序列化 delta 文本估算，之后只保留快照标记和最新权威状态引用。
3. ACK 重复、错误 sender、错误 subscription generation 和旧 `deliveryId` 不释放当前 in-flight 槽；合法 ACK 只释放对应 subscription。
4. ACK 后在对应窗口边界发送合并 delta 或最新快照；快照被 ACK 前不得继续发送 delta。溢出、结构变化和 reconnect 都最终交付权威快照。
5. 无 ACK 超过 5 秒不自动重发；Renderer watchdog 未收到 ACK 接收确认后发起重同步。若旧 delivery 仍在途，则旧 generation 被作废并发送一份最新快照；若旧 delivery 已 ACK，则请求幂等完成。测试需让 watchdog 请求与 `applied` ACK、`resync-required` ACK 分别以两种先后顺序到达，验证每种交错最多推进一次 generation、最多发一份恢复快照，且迟到请求 / ACK 不释放或重置新 delivery。
6. delta-only 流不调用 `toDesktopSessionView`；大历史会话的 delta IPC 负载不包含旧 messages、inputs、runs、tasks 或 permissions。
7. 相邻同 part / field 的 delta 可合并且 `baseLength`、`seq`、时间与最终文本正确；不同目标间事件顺序保持不变。
8. primary 和 auxiliary 都覆盖首个完整快照、后续 delta、结构变化回到完整快照、重连完整快照及订阅替换 / 关闭。
9. Renderer 测试覆盖 text/reasoning 追加、UTF-16 `baseLength`、首次创建 part、迟到旧 delta 去重、重复更新不重复追加、缺 part / 错 offset / 错 session / 非法顺序触发一次 `resync-required` 且不部分改写状态。
10. 增量结构共享测试证明未变化 message / part 引用稳定；delta 不触发运行时 operation 对账、项目刷新、goal 刷新或 context usage 刷新；完整快照原有行为保持。
11. Preload 和 Desktop API 类型检查通过；现有所有 `onUpdated`、`onAuxUpdated` 消费者都显式处理更新联合类型、ACK 与重同步请求。

### 运行时性能验证

在与基线相同的长会话和长时间输出场景下记录主进程构建视图次数、IPC 消息数/字节数、待发项数/字节数、ACK 等待时长、超时 / `snapshot-required` 次数以及 Renderer 内存；对同一进程分别记录输出前空闲基线、输出期间峰值、输出结束后的回落过程和稳定值：

- delta-only 流不得因每次 delta 窗口重新构建完整视图；消息体大小应随本窗口新增文本量增长，而不随已有会话历史增长。
- 人为延迟 Renderer ACK 时，主进程待发积压必须在 500 项 / 1 MiB 内停止增长；恢复 ACK 或触发 watchdog 重同步后，最终文本与状态必须和权威快照一致。ACK 超过 5 秒时只产生停滞告警，不得产生周期性重发；模拟 Renderer 进程退出时，旧订阅必须清理且新订阅从快照恢复。
- 健康状态下约 50ms 的用户可见更新节奏和最终文本必须与基线一致，不丢字、不重字，重连后与 daemon 快照一致。
- 与旧实现对比累计 IPC 字节数和 full-view 构建次数；delta-only 场景这两项应显著下降。对照记录中需注明会话消息数、运行时长和新增文本量，避免只比较不同工作量的两次运行。
- 同时观察 Renderer private memory / heap snapshot 及主线程忙碌时间 / 输入延迟。GC 后堆内存或 private memory 是否继续增长、以及任务结束后回落到什么平台值应单独报告；如果这些指标没有改善，不得把积压受限等同于“内存问题已修复”，并应基于录制证据决定是否另立 transcript 虚拟化 / Markdown 渲染优化规格。

## 8. 实现涉及的代码面

预计需要修改以下 Desktop 内部边界；最终文件名和辅助函数应遵循实施时仓库现有组织：

- `apps/desktop/src/shared/session-types.ts`：定义更新联合类型、delta item、ACK、ACK 确认结果与重同步请求结构。
- `apps/desktop/src/shared/desktop-api-contract.ts`、`apps/desktop/src/shared/ipc-channels.ts`、`apps/desktop/src/preload/desktop-api.ts`：更新主、辅更新事件、带接收确认结果的 ACK 和重同步 IPC 类型。
- `apps/desktop/src/main/features/session/session-subscription-service.ts` 与 `session-update-coalescer.ts`：实现每订阅单 in-flight、generation / ACK 校验、watchdog 超时标记、有界 delta 缓冲、主动重同步、快照 fallback 和生命周期清理。
- `apps/desktop/src/renderer/src/stores/desktop-session/session-view-actions.ts` 及相邻 store API：按更新类型应用快照或增量，结构共享，并在同步应用成功 / 失败后 ACK；watchdog 恢复后发重同步请求，避免 delta 触发完整快照副作用。
- `apps/desktop/src/renderer/src/components/desktop/tools/side-chat-panel.tsx`、Agent 辅助会话接收逻辑及相关模型：消费新的 auxiliary 更新联合类型。
- 对应 coalescer、订阅服务、Renderer store、辅助会话与 preload 测试；覆盖缓冲上限、ACK 生命周期与恢复一致性。

本阶段不应修改此前性能分析中记录的会话数据库，也不应为验证而重启或结束用户正在运行的 Vykor 进程。
