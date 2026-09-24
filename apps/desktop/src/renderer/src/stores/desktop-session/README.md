# Desktop 会话 Store：目录职责与运行规则

本目录把 Desktop renderer（桌面端渲染进程）中的会话状态和动作拆开，但仍只创建一个 Zustand store。这样切换会话、IPC 返回和 SSE 更新可以在一次状态写入中对账，又不会让会话 A 的请求把会话 B 的加载状态或错误清掉。

## 目录边界

这里负责 renderer 一侧的会话页面状态：初始化、项目与会话目录、当前会话的权威快照、本地尚未被快照确认的操作、每个输入框自己的附件草稿，以及调用 `window.desktop.sessions`/`window.desktop.attachments` IPC。

这里不负责：

- 不实现 daemon 的会话、排队、幂等 ID 或 cursor 语义；
- 不维护第二个 primary SSE（Server-Sent Events，服务端持续推送的事件流）订阅；
- 不改 Electron main process 的 IPC 协议；
- 不保存完整消息副本。完整 transcript 只来自当前 `sessionView` 的权威快照。

组件从本目录入口导入 `useDesktopSessionStore`；业务代码也保持在本目录。

## 四层状态放在哪里

| 状态层                | 具体字段或位置                                                                 | 实际用途                                                                                   |
| --------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| 应用层                | `loadStatus`、`daemonStatus`、模型与默认配置、`appOperations`                  | 整个 renderer 共用的启动和 daemon 状态；初始化或选项目窗口失败也归这里。                   |
| 目录层                | `projects`、`sessions`、`archivedSessions`、项目/分支字段、`projectOperations` | 记录有哪些项目和会话，以及某个项目操作是否失败；不保存某个会话正在发送的消息。             |
| 导航与 primary 视图层 | `activeSessionId`、`sessionView`、新会话页的已选模型/provider/权限模式         | `sessionView` 只保存当前 active 会话的权威 SSE 快照。                                      |
| 会话运行态层          | `newConversationRuntime` 与 `sessionRuntimes[sessionId]`                       | 保存本地 operation、待 SSE 确认的 prompt、编辑和队列动作；新建会话未拿到 ID 时先用前者。   |
| 输入框草稿层          | `composerDraftsByScope`                                                        | 保存 `new-conversation` 或 `session:<id>` 的文字与附件卡片；只在内存中存在，不写入持久化。 |

`operation` 是一次异步动作的本地记录，带稳定 ID、所属会话和阶段；它不是完整会话数据。页面一律通过 `selectors.ts` 的 selector（把原始状态转换成页面语义的函数）读取 sending、opening 与作用域错误，不能跨会话遍历 operation 表自行判断。

## 文件职责表

| 文件                             | 职责                                                                                                                                                                                                                   |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `types.ts`                       | 共享状态、运行态、operation 和动作接口的唯一类型来源。                                                                                                                                                                 |
| `initial-state.ts`               | 创建初始字段与空 runtime；不注册事件、不读 `localStorage`、不调用 IPC。                                                                                                                                                |
| `store.ts`                       | 组合各 action creator，创建唯一 store，并按引用计数挂接/释放 daemon 与会话 SSE 监听；从 0 个监听重新变为 1 个时，调用专用 resync 为当前 active 会话补快照，不改变用户导航所有权。                                      |
| `selectors.ts`                   | 从当前会话和 runtime 推导页面可用的 sending、opening、局部错误和队列动作。                                                                                                                                             |
| `operation-state.ts`             | 以 operation ID 创建、确认、失败、删除或从新会话 runtime 绑定到真实会话 runtime。                                                                                                                                      |
| `error-state.ts`                 | 规范错误文本，并维护应用/项目范围 operation 的失败与清理。                                                                                                                                                             |
| `session-view-state.ts`          | 校验 active 会话和 cursor，判断快照能否覆盖当前视图，并按稳定 ID 对账 runtime。                                                                                                                                        |
| `session-view-actions.ts`        | 把已接受的 SSE 快照写入目录、导航和对应会话 runtime；这是状态写入动作，不发 IPC。                                                                                                                                      |
| `pending-prompt-state.ts`        | 决定 prompt 放在 transcript 还是 queue，并清理已被 SSE input/run 确认的本地覆盖。                                                                                                                                      |
| `bootstrap-actions.ts`           | 初始化、刷新 bootstrap 数据和 daemon 状态事件。                                                                                                                                                                        |
| `project-details-coordinator.ts` | 管理项目选择和每个项目详情的 generation（每次新意图递增的版本号）；`project-actions.ts` 与 `session-actions.ts` 共用它。打开会话也会领取项目选择所有权，旧 chooser、refresh、分支或打开会话 inspect 都不能覆盖新结果。 |
| `project-actions.ts`             | 选项目、读取 Git、分支和项目设置；详情写入先向 coordinator 领取 generation。只有仍拥有最新 generation 的失败才写到项目 operation 桶，过期请求只清理自己，不能在新操作成功后显示旧错误。                                |
| `project-git-scheduler.ts`       | 对 Git 刷新做延迟合并；在最后一个 store 监听解绑时取消尚未执行的刷新。                                                                                                                                                 |
| `session-actions.ts`             | 新会话、打开、fork、重命名、置顶、归档和删除；管理 primary 导航所有权，按用户总顺序写入默认模型和权限模式，并提供不改变导航的 resync。                                                                                 |
| `prompt-actions.ts`              | 普通发送、命令、编辑、停止和授权回复。                                                                                                                                                                                 |
| `composer-draft-state.ts`        | 纯状态转移：按 scope 保存文字/卡片，处理上传进度、成功、失败、取消、重试和 scope 迁移。                                                                                                                                |
| `attachment-actions.ts`          | picker、图片选择、拖放、剪贴板、上传、取消、重试和移除的副作用入口；真实路径不会进入 store。                                                                                                                           |
| `queued-prompt-actions.ts`       | 提升或取消某一条已进入服务端队列的消息。                                                                                                                                                                               |
| `persistence.ts`                 | 安全读写 active session 的 `localStorage`；存储失败不会阻断聊天。                                                                                                                                                      |
| `helpers.ts`                     | 跨模块的无状态工具，如稳定排序、路径比较、标题与会话工作区推导。                                                                                                                                                       |
| `store-test-fixtures.ts`         | 仅给测试构造稳定的 bootstrap、会话和 window mock，不参与生产运行。                                                                                                                                                     |

## 新会话创建流程

入口是新会话页的 composer，调用 `startSession(content, options)`。

1. **入口 → 创建。** `session-actions.ts` 先在 `newConversationRuntime.operations` 写入 `create-session`，随后调用 `sessions.create`。
2. **调用返回 → 绑定状态。** main process 返回真实 `sessionId` 后，创建 operation 从 `newConversationRuntime` 原子移动到 `sessionRuntimes[sessionId]`；首条普通消息同时写为 `placement: transcript` 的本地 submission。
3. **是否接管页面 → 打开 primary。** 只有这次创建仍拥有当前导航代次时，才调用 `sessions.open(sessionId)`，并把返回 snapshot 写到 `activeSessionId/sessionView`；用户期间改去别的会话时，首条消息仍会发送，但不会抢回 primary。
4. **发送 → 等待 SSE。** 首条消息统一调用 `sendPrompt` 后标成 `accepted`；Skill 引用与正文按顺序放在 `items` 中，由运行时按引用的真实名称和路径加载。打开失败会把错误留在新 session 的 `open-session` owner、向 composer 返回失败并保留草稿。IPC 只表示请求已接收，不能伪造 cursor 或 transcript。
5. **SSE 返回 → 清理。** `applySessionUpdate` 接受同会话、cursor 不倒退的快照；`reconcileRuntimeWithView` 按 input/run ID 清掉已经确认的 submission 与 operation。
6. **失败 → 留给所属页面。** 创建尚未返回 session 时，失败写回 `newConversationRuntime`；已拿到 session 后，失败写到对应 `sessionRuntimes[sessionId]`。SSE 已确认首条消息时，迟到的 IPC 失败不改写为失败。

## 附件从添加到消息展示的流程

附件和文字共用一个 composer scope。新会话固定使用 `new-conversation`，已有会话使用 `session:<sessionId>`，因此来回切换页面时不会把 A 会话的文字或卡片带到 B 会话。

1. **入口。** 文件选择、图片选择和拖放先由 preload 把文件交给 Electron Main；剪贴板图片以二进制交给 Main。Renderer 只收到安全展示名、大小、媒体类型、`draftId` 和一次性的 `sourceToken`，拿不到真实路径。文件夹入口保留在菜单里，但当前禁用。
2. **状态位置。** `attachment-actions.ts` 把候选项写入 `composerDraftsByScope[scope].attachments`，随后生成 `taskId` 并开始上传。卡片顺序就是用户加入顺序；即使 daemon 对相同内容复用了同一个 asset，多个 UI 卡片也不会自动合并。
3. **上传事件返回。** Main 持有文件流、并发队列和取消控制，通过 `attachments.onUploadEvent` 返回 progress/success/failed/cancelled。`store.ts` 只注册一份引用计数监听；事件必须同时匹配 `scope + draftId + 当前 taskId` 才能改状态，所以重试后的旧事件会被忽略。
4. **发送快照。** 只有文字非空或至少有一张卡片，且所有卡片都是 ready 时才允许发送。点击发送会复制有序的 `{ assetId, intent, displayName }` 快照；上传中的变化不会修改这次请求。纯附件消息允许 `content` 为空。
5. **新会话迁移。** session 创建成功后，`new-conversation` 的文字和附件在一次 store 写入中迁移到 `session:<id>`。创建失败不迁移；打开或首条发送失败时草稿留在新 session scope，避免重新上传和双份卡片。
6. **IPC 与 SSE 对账。** IPC 成功只代表 daemon 接受请求，本地 submission 继续显示。权威 snapshot/SSE 出现同一个 input ID 后，才移除 optimistic 消息；成功清理也只删除仍与发送快照匹配的文字和卡片，发送后新加的附件不会被误删。
7. **历史展示。** 权威消息中的 `attachment`/`transformation` part 直接进入 transcript。安全位图缩略图从 daemon 副本读取，并校验媒体类型和真实文件头；SVG、HTML 或伪装内容只显示文件图标。打开和另存为都走专用附件 IPC，不生成 `file://` 或裸下载 URL。
8. **编辑。** 最近一条用户消息可以只改文字。附件卡片只读，提交时从权威 input 重新取得原有 ordered refs，不从页面反推、不重新上传。

附件草稿不写入 `localStorage`，应用重启后不恢复；已经发送的附件由 daemon 资产和会话引用恢复。支持图片的模型直接接收原生图片；不支持或图片能力未知的模型收到受控附件资源提示，由主 Agent 按需调用 `ImageToText` 做纯本地 OCR。OCR 只能提取可见文字，不能描述图片。PDF/Word/文本提取、工具挂载、分片上传、文件夹遍历和 Blob GC 仍属于后续阶段。

## 普通发送与排队发送流程

入口都是已有会话 composer 的 `sendMessage`。

### 普通发送

1. **入口 → 分类。** `classifyPromptPlacement` 同时看当前会话的权威 run 和本地未确认 submission。两者都没有进行中工作时，固定为 `transcript`。
2. **调用 → 状态写入位置。** 在 `sessionRuntimes[activeSessionId]` 写入 submission 与同 ID 的 `send-prompt` operation，再调用 `sessions.sendPrompt`。
3. **IPC 返回 → 保留覆盖。** 成功后 operation 为 `acknowledged`，submission 为 `accepted`；它们仍保留，直到 SSE 确认 input ID。
4. **SSE 返回 → 清理。** 快照确认 input 后，对账函数删除 submission 和 operation。普通发送不会传给 `PendingPromptQueue`。
5. **失败 → 重试。** 未被 SSE 确认时，把该 submission 标为 `failed` 并保留错误；同内容重试沿用原 ID 和 placement。

### 排队发送

如果已有 pending/running run，或第一条本地 submission 仍是 `submitting/accepted`，第二条会在点击时固定为 `placement: queue`。后续步骤与普通发送相同，但组件会立即把它传给 `PendingPromptQueue`，因此 SSE 尚未到达也有可见反馈。失败的 submission 无论原 placement 都保持可见，方便重试。

服务端快照中的 pending run 也会显示在队列：若没有 running run，最早 pending run 是即将执行的 active candidate，会被隐藏；其余 pending run 才是实际队列。提升/取消只在 `queuedPromptActions[sessionId:runId]` 记录自己的 pending、acknowledged 或 failed 状态，随后由 run 的 SSE 状态确认并清理。

## Primary SSE 所有权与会话切换

renderer 只有一处订阅入口：`store.ts` 的 `attachDesktopSessionEvents`。第一个调用者注册 `sessions.onUpdated`，后续调用只增加计数；最后一个清理函数解除订阅并取消 Git 刷新，因而不会留下重复监听。若曾全部解绑，下一次从 0 变为 1 时调用 `resyncActiveSessionSnapshot` 对仍是 active 的会话补快照；它不会推进导航代次、不会替换在途 `open-session`，同一轮的第二个引用也不会重复打开。

所有权威 durable `SessionView` 状态更新统一收口于唯一的对账入口 `applySessionUpdate`：
- 所有来自 IPC 的权威快照（`sessions.onUpdated` 与 `resyncActiveSessionSnapshot`）必须经过该入口完成受控写入；
- 各 feature actions（prompt、attachment、goal、project）只修改其自身的 operation/draft/view 临时交互状态，不直接绕过权威入口伪造持久化 terminal 状态；
- 打开会话 `openSession` 在验证 generation 与 operation 所有权后，仅将初次权威 snapshot 与项目工作区原子写入，随后由 `applySessionUpdate` 负责后续所有增量对账；
- Notification 监听器（`notification-observer.ts`）纯粹作为只读观察者消费状态变更，不二次分发或重新应用事件。

打开会话的流程如下：

1. **入口 → 标记所有者。** 路由或侧边栏调用 `openSession(sessionId)`；它推进导航代次，在该会话 runtime 写 `open-session` operation，并先把该 ID 设为 active。
2. **调用 → 获取 primary snapshot。** `openPrimarySession` 调用唯一的 `sessions.open(sessionId)`。
3. **返回 → 只让当前请求写入。** 只有 active ID 仍相同、operation ID 仍是 pending 时，返回 snapshot 才能写入 `sessionView`。重复打开同一会话时，旧 `open-session` operation 先被移除。
4. **SSE 返回 → 防倒退。** `acceptActiveSessionView` 只接受 active 会话、且 cursor 不小于当前 cursor 的更新；背景会话更新和旧 cursor 直接忽略。
5. **清理位置。** 成功的打开 operation 被删除；请求失败只在它自己的 runtime 留失败。fork、归档、删除和新建会话都会推进导航代次，迟到的请求不能抢回 primary。

## IPC/SSE 对账顺序

IPC 说明 renderer 请求有没有被接受；SSE/snapshot 才是会话的权威事实。两者可按任意顺序到达。

| 到达顺序     | 状态写入与返回处理                                                                                                                                         |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| IPC 先成功   | operation/submission 进入 `acknowledged/accepted`，保留本地覆盖；SSE 含相同稳定 ID 后由对账函数删除它。                                                    |
| SSE 先成功   | `applySessionUpdate` 先按 input/run/operation ID 清理覆盖；后续 IPC 成功只处理自己的 ID，后续 IPC 失败先检查是否已确认，已确认就按成功清理，不反转为失败。 |
| 用户切换会话 | 旧请求仍只更新旧 `sessionRuntimes[oldId]`；active selector 只读取新会话 runtime，因此新页面不会被锁住或显示旧错误。                                        |
| 快速连续发送 | 第一条未被 SSE 确认时仍算进行中工作；第二条被固定为 queue，两个 input ID 分别由 SSE 接管，不相互覆盖。                                                     |

## Operation 与错误生命周期

operation 的阶段是 `pending`、`acknowledged`、`failed`。

| 阶段           | 何时写入                                                                              | 后续处理                                                                 |
| -------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `pending`      | 点击动作时，由 `beginOperation` 或 scoped operation helper 以唯一 ID 写入所属 scope。 | 页面 selector 只锁需要锁的控件。                                         |
| `acknowledged` | IPC 接收成功但仍要等 SSE 证实结果时。                                                 | SSE 对账到稳定 ID 后删除。                                               |
| `failed`       | IPC 失败且 SSE 尚未证明成功时。                                                       | 错误留在最具体的 owner，重试同类动作会清掉旧失败；成功或明确清理时移除。 |

完成后不需要 SSE 的操作（例如编辑、停止、授权回复和项目动作）在 IPC 完成时删除。Slash Skill 不再创建单独的命令 operation，而是作为普通 prompt submission 跟随 input/run 对账。失败操作不进入全局 `error`：应用失败在 `appOperations`，项目失败在 `projectOperations[projectId]`，新会话失败在 `newConversationRuntime`，会话失败在 `sessionRuntimes[sessionId]`，prompt/排队项的错误跟随各自实体。这样切换会话不会串错错误。

## 新增状态或动作的放置检查清单

- [ ] 先判断 owner：全局应用、某个项目、当前导航，还是具体 session/new conversation。
- [ ] 共享类型只放在 `types.ts`；初始字段放在 `initial-state.ts`。
- [ ] 纯判断、cursor、placement 或对账规则放到对应 `*-state.ts`；不要把它们复制进 action 或组件。
- [ ] 需要 IPC 的用户动作放到职责相符的 `*-actions.ts`，通过 `set/get` 更新 store，不直接调用另一个 action 模块内部函数。
- [ ] 每个异步动作使用稳定 operation ID，并只确认、失败或删除自己的 ID；跨模型/权限的默认设置和跨入口的项目详情必须共用最新意图协调器。
- [ ] 会影响页面 pending/error 的规则增加到 `selectors.ts`；组件不遍历 operation 表自己拼规则。
- [ ] 需要 SSE 确认时，同时覆盖「IPC 先到」「SSE 先到」「切换会话后返回」测试。
- [ ] 新文件保持依赖向上：`types` 与纯状态模块不导入 action 或 store；action 由 `store.ts` 组合，目录入口和组件只消费它们。

## 不可破坏约束

1. 背景会话不能调用 primary `sessions.open`。
2. 旧 operation 只能结束自己的 ID，不能结束较新的 loading/sending。
3. SSE 已确认成功后，迟到的 IPC 失败不能改回失败。
4. 一个会话的错误不能显示到另一个会话。
5. active view 只接受同一 session 且 cursor 不更旧的更新。
6. 普通发送不能短暂出现在 `PendingPromptQueue`。
7. 真正排队的消息在 SSE 到达前必须立即可见。
8. 快速连续发送时，未确认的本地 submission 仍算进行中工作。
9. 组件通过 selector 取得 operation 语义，不自行遍历 operation 表。
10. renderer 不生成假的服务端 cursor，也不伪造权威 transcript。
11. operation、submission 与 queued action 用稳定 ID 对账。
12. 成功 operation 会清理；失败状态有明确可见 owner，不能无界积累。
13. renderer 永远不保存附件真实路径；上传错误也不能包含路径、授权值、source token 或堆栈。
14. production 构建在 daemon 声明附件能力时默认开放；`VYKOR_DESKTOP_ATTACHMENTS=0` 关闭时 picker、drop、paste 和附件发送入口都不能绕过，但纯文字发送保持原流程。

## 测试归属

| 测试文件                                                   | 主要保护的规则                                                                                           |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `operation-state.test.ts`、`error-state.test.ts`           | operation ID 所有权、失败隔离和清理。                                                                    |
| `pending-prompt-state.test.ts`                             | placement、稳定队列 action key 与 SSE 队列对账。                                                         |
| `session-view-state.test.ts`                               | active session 与 cursor 防倒退、runtime 对账范围。                                                      |
| `runtime-cleanup.test.ts`                                  | primary 离开后，只释放已确认的本地覆盖，保留仍在执行或失败的状态。                                       |
| `selectors.test.ts`                                        | 新会话/当前会话的 sending、opening 和错误作用域。                                                        |
| `prompt-actions.test.ts`                                   | 发送、快速连续发送、编辑、停止、授权、排队操作、后台成功后的覆盖清理，以及 SSE 先确认后的迟到 IPC 失败。 |
| `session-actions.test.ts`                                  | 新建/打开/fork/归档/删除的导航所有权、后台创建清理和 primary 防抢占。                                    |
| `project-actions.test.ts`、`project-git-scheduler.test.ts` | bootstrap、项目错误隔离、项目响应过期和 Git 刷新清理。                                                   |
| `store.integration.test.ts`                                | 监听器只订阅一次且可释放重挂、跨模块快速发送、SSE/IPC 对账与跨会话错误隔离。                             |
| `permission-card.test.ts`                                  | 单个授权项 pending 时禁用两种决定，并在卡片内显示该项错误。                                              |

修改这些规则时，优先在对应职责测试中增加断言；跨模块竞态才放入 `store.integration.test.ts`。
