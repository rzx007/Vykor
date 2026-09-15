# Session、Conversation 与 Run 主链路提取设计

> 状态：设计已确认，等待书面规格审阅。
>
> 本文是业务代码重组阶段 3 的总规格。它规定边界、顺序、所有权和验收方式；具体到每个测试和提交的操作步骤由阶段 3A–3D 的实施计划分别描述。

## 1. 背景

阶段 0–2 已经把共享数据库内核以及 Project、Schedule、Workflow、Channel、Goal、Permission、Attachment 从 `SessionStore` 中提取出来。当前 `packages/services/src/session-runtime/store.ts` 仍约 3375 行，剩余主体是系统最核心、耦合最深的三组数据：

- Session：会话本身、父子关系、归档和删除；
- Conversation：Input、Input Attachment Reference、Message、Message Part 和 Event；
- Run：Run、Run Attempt、Session Task 及其状态变化。

这些代码不能继续按“看到一段就搬一段”的方式迁移。读取、单实体写、跨表业务事务和高频增量输出有不同的一致性要求。阶段 3 必须按风险从低到高推进，每一步都保持现有 HTTP、SSE、数据库格式和用户行为兼容。

## 2. 目标

阶段 3 完成后：

1. Session、Conversation、Run 各自拥有明确的 Repository。Repository 是直接读写 SQLite 和同步 read model 的模块。
2. 跨多个实体的业务动作由命名明确的 Transaction 模块拥有。Transaction 在这里指“一个动作里的所有修改一起成功或一起失败”，不是通用业务服务。
3. Message Part 的文本增量、延迟 checkpoint 和强制刷盘由独立的增量输出模块拥有，不混进普通 CRUD。
4. `StorageContext.atomic()` 的事务协调不再由 `SessionStore` 私下实现，数据库内核成为唯一事务协调者。
5. `SessionStore` 对外保留兼容转发，在阶段 3 不造成公共 API 破坏。
6. `SessionStore` 最终只负责依赖组合、兼容转发和 `close()`；它不再包含 Session、Conversation、Run 的业务规则或 SQL。
7. 失败注入测试证明：事务失败时 SQLite 与内存 read model 都回到动作开始前的状态。

## 3. 不在本阶段处理的事项

阶段 3 不处理以下内容：

- 不拆 Server 的 Application Service、Run Executor、Session Lane 或 DaemonApplication；这些属于阶段 4。
- 不迁 Client、Desktop 或前端状态；这些属于阶段 5–6。
- 不删除 `SessionStore` 兼容方法；最终删除属于阶段 8。
- 不改变数据库 schema、storage format、migration 或 HTTP/SSE/IPC 协议。
- 不实现 Attachment lease token、representation claim/recovery 或 durable GC saga。
- 不扩展 Permission 的产品授权规则。
- 不调整 Workflow 两表持久化协议。
- 不修复全仓并发运行时出现的 WSL E2E 超时或 `node-pty AttachConsole failed`；它们作为已知环境竞争问题单独记录。
- 不引入新的依赖注入框架、ORM、事件总线、Unit of Work 框架或通用 Repository 基类。
- 不借迁移机会重新命名公共协议类型、改变错误文本或整理无关目录。

## 4. 设计原则

### 4.1 保持行为，不重新设计产品

本阶段是所有权迁移。现有调用的返回值、排序、过滤、clone 行为、错误类型、错误文本、状态转换、时间戳更新和事件顺序都视为兼容契约。只有测试证明现有行为本身不一致时，才单独记录问题，不在迁移提交中顺手修复。

### 4.2 按职责拆，不按文件大小平均切

文件边界由“谁拥有规则和状态”决定：

- 单实体 SQL 和内存映射属于 Repository；
- 多实体原子动作属于 Transaction；
- 高频文本增量和 checkpoint 属于 Incremental Output；
- 实时等待者、执行句柄和调度策略继续留在 Runtime/Server；
- 旧方法只做一行或很薄的兼容转发。

### 4.3 单一写入入口

同一份数据不能同时由新 Repository 和旧 Store 逻辑修改。一个方法迁移后，原实现必须从 Store 删除；Store 只能转发到新所有者。禁止复制实现后让两套逻辑并存。

### 4.4 事务边界优先于目录整齐

如果一个业务动作修改多张表，它必须由一个 Transaction 入口完成。调用方不能先调用 `inputs.create()`，再调用 `runs.create()` 来模拟原子 admission。目录少一个文件不如事务正确重要。

### 4.5 最小抽象

只创建当前确实需要的三个 Repository、一组按业务动作命名的 Transaction 和一个增量输出模块。不会建立通用 `BaseRepository`、泛型 CRUD、服务定位器或为未来数据库准备适配接口。

## 5. 当前运行模型

### 5.1 入口

Server 及 Services 内部目前主要通过 `SessionStore` 平铺方法访问数据。测试也大量直接构造 Store，用它创建 Session、Input、Message 和 Run。

### 5.2 状态位置

`StorageContext` 共享以下对象：

- `SessionDatabase`：`better-sqlite3` 连接和数据库生命周期；
- `SessionState`：当前进程使用的内存 read model；
- `MutationBuffer`：记录需要落盘的 Session/Conversation/Run 变更；
- `DurableEventSequence`：生成持久事件序号；
- `DeltaCheckpoint`：记录尚未完整刷盘的 Message Part 文本增量；
- `atomic()`：事务入口；
- `assertWritable()`：owner fence 写权限检查。

### 5.3 当前返回路径

普通写操作先更新 read model 和 mutation buffer，然后由 Store 的保存逻辑写回 SQLite。事务动作在 `atomic()` 中组合多项修改。增量输出可以先更新内存并累积 checkpoint，达到阈值、Run 结束或 Store 关闭时再完整刷盘。SSE 和查询从 Store 暴露的状态读取结果。

### 5.4 当前主要风险

- 把方法搬到不同 Repository 后，跨实体动作可能发生半提交；
- SQLite 回滚了，但内存对象没有恢复；
- mutation buffer 或 delta checkpoint 在失败后残留脏标记；
- terminal Run 已提交，但最后一段文本仍未刷盘；
- 事件在事务提交前被观察者看到；
- Task 变化后，进程内等待者没有收到唤醒；
- 多人同时编辑 `store.ts`，产生大范围冲突或丢失规则。

## 6. 目标模块结构

阶段 3 计划形成以下结构：

```text
packages/services/src/
├── database/
│   ├── storage-context.ts
│   ├── transaction-coordinator.ts
│   ├── mutation-buffer.ts
│   ├── read-model.ts
│   └── delta-checkpoint.ts
├── sessions/
│   ├── session-repository.ts
│   ├── session-repository.test.ts
│   └── index.ts
├── conversations/
│   ├── conversation-repository.ts
│   ├── conversation-repository.test.ts
│   ├── conversation-transactions.ts
│   ├── conversation-transactions.test.ts
│   ├── incremental-output.ts
│   ├── incremental-output.test.ts
│   └── index.ts
├── runs/
│   ├── run-repository.ts
│   ├── run-repository.test.ts
│   └── index.ts
└── session-runtime/
    ├── store.ts
    ├── store-state.ts
    └── __test__/
```

只有实际承担跨域动作时才创建 `conversation-transactions.ts`。不再为 Session 和 Run 各建一个空的 Transaction 外壳。跨 Session、Conversation、Run 的动作统一放在这个文件中，并按动作命名导出。

## 7. 模块所有权

### 7.1 SessionRepository

拥有：

- `getSession`、`listSessions`、`listChildSessions`；
- `createSession`；
- Session 字段更新、归档状态转换；
- Session 单行 mutation 标记；
- Session 查询的过滤、排序和 clone。

不拥有：

- session tree 递归删除；
- archive 时中断 Run/Task；
- fork 历史；
- Prompt admission；
- Server 的 Session lane、实时 handle 或关闭协调。

### 7.2 ConversationRepository

拥有：

- Input 查询；
- Input Attachment Reference 查询和计数；
- Message 与 Message Part 查询；
- Event 查询和最新 event sequence；
- 单个 Message 创建；
- 单个 Message Part upsert；
- 单个 durable Event append；
- 对应的 row 语义、排序、过滤、clone 和 mutation 标记。

不拥有：

- 带附件限制和幂等规则的 Prompt admission；
- transcript 整体替换；
- replay/edit/fork；
- Message Part delta checkpoint；
- SSE 发布策略。

### 7.3 RunRepository

拥有：

- Run、Run Attempt、Session Task 的查询；
- 单个 Run 创建和更新；
- 单个 Run Attempt 创建和更新；
- 单个 Session Task 创建和更新；
- 状态转换校验、时间戳和单实体 mutation 标记。

不拥有：

- admission + Run；
- terminal Run 与 active Attempt/Part 的联合收尾；
- startup recovery；
- Session Task 等待者集合；
- Run 排队、执行、取消和 Agent 生命周期策略。

### 7.4 ConversationTransactions

拥有必须一起成功或一起失败的动作：

- Prompt admission，包括附件引用、幂等检查、标题初始化和事件；
- admission + Run；
- replace transcript + admission；
- replay Run；
- replace latest prompt；
- fork Session with history；
- delete Session tree；
- 中断 active Run/Task/Attempt 以及关联 running Part；
- startup terminalization 和 closing Session 收尾；
-需要横跨 Session、Conversation、Run 的恢复动作。

Transaction 可以组合三个 Repository，但不能调用 Server 服务。它只处理持久状态的一致性，不拥有排队、Agent 执行或用户交互策略。

### 7.5 IncrementalOutput

拥有：

- `appendMessagePartDelta`；
- `flushMessagePartDeltas`；
- delta byte/interval 阈值判断；
- dirty part 集合；
- Message、Session 更新时间传播；
- terminal、事务结束和 close 前的强制刷盘规则。

它使用 `DeltaCheckpoint` 和 ConversationRepository，但不决定 SSE payload，也不执行 Run 状态机。

### 7.6 TransactionCoordinator

拥有 `StorageContext.atomic()` 的具体实现：

1. 最外层事务开始时保存 read model、mutation buffer、event sequence 和 delta checkpoint 的可恢复快照；
2. 嵌套调用复用同一个最外层事务；
3. 成功时按既有顺序刷盘并提交；
4. 失败时回滚 SQLite，同时恢复内存状态和所有脏标记；
5. owner fence 检查继续覆盖所有持久化写；
6. 只有提交成功的结果才能被后续查询和发布流程观察。

协调器属于 database 内核，不依赖 Session、Conversation、Run Repository。具体 flush 回调通过窄函数注入，不能反向导入 `SessionStore`。

## 8. 四个迁移波次

### 8.1 阶段 3A：只读查询

先创建三个 Repository，只迁移读取方法。此时写操作仍由 Store 实现。

目的：

- 用最低风险验证目录、构造方式和公开导出；
- 固定排序、过滤、clone 和 not-found 行为；
- 为后续写操作提供唯一读入口；
- 先迁移一组 Server 窄 capability，降低 `context.store.*` 平铺调用。

3A 不允许改变 mutation、transaction、delta 或事件写入。

### 8.2 阶段 3B：单实体写

在 3A 合入后迁移不会要求多个实体共同提交的写操作。

目的：

- 把实体自身校验和状态转换放回相应 Repository；
- 保持 mutation buffer、时间戳、clone 和错误语义；
- 让 Store 写方法变成兼容转发；
- 为 Transaction 提供可组合的内部原语。

3B 禁止把 `admitPrompt`、fork、delete tree、transcript replace 或联合 recovery 拆成调用方的多步操作。

### 8.3 阶段 3C：跨域 Transaction Script

Transaction Script 是“把一个完整业务动作按固定顺序执行的函数”。它不是一个新的应用层，也不承载 HTTP 或 Agent 策略。

目的：

- 迁移所有跨 Session、Conversation、Run 的原子动作；
- 把事务协调器从 Store 下沉到 database；
- 用明确失败点证明 SQLite 和 read model 不会半提交；
- 保持幂等、附件引用、标题、事件和状态收尾规则。

每个复杂事务单独迁移、测试、提交。不得一次搬完整个 3C。

### 8.4 阶段 3D：增量输出与 checkpoint

最后迁移高频文本 delta。这一部分单独实施，因为它允许“内存已更新、SQLite 稍后落盘”，与普通 CRUD 的立即持久化语义不同。

目的：

- 独立拥有 delta 累积和阈值刷新；
- 保证 Run terminal、Store close 和必要事务边界前完整刷盘；
- 保证重启后读取到的文本不缺最后一段；
- 保持 SSE 对 transient 与 durable 状态的现有区分。

## 9. 数据流

### 9.1 普通读取

```text
Server/Services caller
  → narrow capability 或 SessionStore 兼容方法
  → 对应 Repository
  → StorageContext.state
  → clone 后返回
```

Repository 继续以 read model 为主要读取来源，不在阶段 3 改为每次查询 SQLite。

### 9.2 单实体写入

```text
caller
  → Repository write
  → assertWritable
  → 校验当前实体和状态转换
  → 更新 read model
  → 标记 mutation
  → 由既有保存边界写入 SQLite
  → clone 后返回
```

### 9.3 跨域动作

```text
caller
  → ConversationTransactions.<businessAction>()
  → StorageContext.atomic()
  → 组合 Session/Conversation/Run Repository 内部原语
  → 写 mutation/event/delta 状态
  → 最外层 transaction coordinator flush + commit
  → 提交成功后返回结果
```

任一步抛错时，SQLite、read model、mutation buffer、event sequence 和 delta checkpoint 必须一起恢复。

### 9.4 增量输出

```text
runtime projection
  → IncrementalOutput.appendDelta()
  → 更新内存中的 Part 文本
  → 记录 dirty part 和累计字节
  → 达到阈值时 flush
  → terminal/close 时无条件 flush
```

## 10. 兼容层

阶段 3 中 `SessionStore` 继续构造并公开领域入口，形式与阶段 2 已有的 `store.projects`、`store.goals`、`store.attachments` 保持一致：

- `store.sessions`；
- `store.conversations`；
- `store.runs`；
- 仅在确有调用价值时公开 `store.conversationTransactions` 和 `store.incrementalOutput`；否则保持私有并由兼容方法转发。

公开与否以当前调用方需要为准，不为了“结构对称”扩大 API。

所有旧平铺方法在阶段 3 保留。迁移后的旧方法只能：

1. 做必要的输入形状兼容；
2. 调用新入口；
3. 原样返回结果。

旧方法不得保留 SQL、状态转换或 mutation 规则。

## 11. 错误与回滚语义

必须保留以下错误行为：

- Session、Message、Run、Attempt、Task 不存在时的既有错误；
- archived/closing Session 的可变性限制；
- terminal Run 和 terminal Attempt 不允许反向转换；
- Message 与 Session 不匹配；
- Run、Input 与 Session 不匹配；
- child Session 与 parent 关系不合法；
- 重复 id、重复 sequence 和幂等 request 冲突；
- Prompt 附件不存在、已删除、未 ready、超限或重复请求内容不一致；
- owner fence 失效时拒绝写入。

失败注入至少覆盖这些位置：

- read model 已改、mutation 尚未 flush；
- 部分 mutation SQL 已运行；
- durable event sequence 已分配；
- delta checkpoint 已标脏；
- transaction callback 即将返回；
- SQLite commit 失败。

每个位置都要验证：重新读取内存状态无变化；关闭并重新打开数据库后状态也无变化；失败的事件序号不会以错误数据形式出现。

## 12. 并发、等待者和事件可见性

阶段 3 不建立新的并发模型，但必须保持以下现有语义：

- `waitForSessionTaskChange` 的 listener 集合仍由 Store/Runtime 生命周期拥有；Repository 只返回 durable Task 数据。
- Task 更新成功后才通知等待者；失败或回滚不能产生虚假通知。
- durable Event 只有事务提交后才能进入对外可见路径。
- 明确的 transient SSE 事件可以不落库，但不能伪装成 durable Event。
- `latestEventSeq()` 继续跨重启单调，不复用已提交序号。
- 嵌套 `atomic()` 不得提前提交、提前 flush 或提前发布。

如果现有通知发生在 Store 方法内部，迁移时使用“提交后回调”或由最外层兼容入口在成功返回后通知；不能让 Repository 直接依赖 listener 集合。

## 13. 测试策略

### 13.1 Repository 测试

每个 Repository 的测试直接构造真实临时 SQLite Store/StorageContext，验证：

- 查询过滤与稳定排序；
- 返回对象是 clone，调用者修改不会污染 read model；
- 单实体创建和更新；
- 状态转换与错误文本；
- 关闭重开后数据一致；
- owner fence；
- 对应 mutation 只触及预期实体。

### 13.2 Transaction 测试

每个业务动作至少有：

- 正常成功路径；
- 幂等重试路径；
- 业务校验失败路径；
- 中途失败注入；
- 关闭重开验证；
- 事件和附件引用等伴随数据验证。

### 13.3 增量输出测试

至少覆盖：

- 未达阈值时只更新内存；
- 达到 byte threshold 后刷盘；
- 达到 interval threshold 后刷盘；
- 显式 flush；
- terminal Run 前 flush；
- close 前 flush；
- transaction rollback 后恢复 dirty 状态；
- 重启读取完整文本；
- Message 和 Session 的 `updatedAt` 同步更新。

### 13.4 兼容和集成测试

- 既有 `SessionStore` 测试必须继续通过；
- Server Session/Run/Permission/Goal/Attachment 相关测试必须通过；
- Services 和 Server typecheck 必须通过；
- architecture checker 和 checker 自身测试必须通过；
- docs checker 与 `git diff --check` 必须通过。

全仓 `pnpm test` 可以作为补充证据。若只出现已确认的 WSL/node-pty 并发环境问题，应附完整命令和失败签名，不把它描述为阶段 3 通过，也不要求阶段 3 实现者修改业务代码规避。

## 14. 架构护栏

阶段 3 每个合入单元都必须满足：

- `scripts/architecture-baseline.json` 中 `sessionStoreFlatCalls` 只能下降，不能为了通过检查调高；
- 新 Repository 不得导入 `SessionStore`；
- database 不得导入 sessions、conversations、runs 或 server；
- transactions 可以依赖 Repository 和 database，不得依赖 server；
- server route 不新增对 Repository 的直接依赖；阶段 4 才统一收口 Application Service；
- 新代码不得新增 `context.store.*` 平铺调用；
- 不新增笼统的 `utils.ts`、`helpers.ts` 或 `common.ts`；
- 单个提交不得同时做文件移动、行为修复和公共协议变更。

## 15. 多人分派与 Git 规则

阶段 3 的四个波次必须串行合入：

```text
3A → 3B → 3C → 3D → 阶段 3 集成审核
```

原因是四个波次都会修改 `SessionStore`、公共导出和测试基线。并行实现会让事务所有权和兼容转发产生冲突。

每位执行者必须：

1. 从最新 `main` 创建独立 worktree 和 `codex/` 前缀分支；
2. 只执行被分配计划中的任务；
3. 每个可独立测试的交付物单独 commit；
4. 在交付前 rebase 或合并最新 `main` 并重新验证；
5. 提交 commit 列表、实际修改文件、测试命令、测试数量、失败签名和已知风险；
6. 不自行合入下一波次的预备代码。

同一波次可以并行做只读分析和测试清单，但只允许一个实现分支修改共享生产文件。若确实要把 3A 内的三个 Repository 分给三人，协调者必须先固定公共构造接口和导出文件，再让每人仅修改自己的领域目录；`store.ts` 和公共 `index.ts` 最后由单一集成人统一接线。

## 16. 每个任务的交付模板

执行者交付时必须提供：

```text
任务：阶段 3X / 任务编号和名称
基线：开始时 main commit
结果：完成 / 部分完成 / 阻塞
提交：按时间顺序列出 commit hash 和标题
文件：创建、修改、删除的文件
行为：保持了哪些契约，是否发现规格外问题
验证：逐条列出命令、退出码、测试数量
失败：完整失败名称和首个根因；区分业务回归与已知环境问题
架构：旧平铺调用下降数量，baseline 是否更新
风险：仍需审核者重点检查的代码
越界：明确声明没有夹带下一阶段或产品功能变更
```

缺少实际命令和退出码的“测试通过”不能作为验收证据。

## 17. 审核顺序

每个任务采用两轮审核：

1. 规格审核：检查是否做全、是否越界、兼容语义是否完整；
2. 质量审核：检查事务、错误路径、测试质量、依赖方向和可维护性。

Important 及以上问题必须修复并复审。Suggestion 可以记录但不能在当前迁移中演变为无关重构。审核者尤其检查：

- 原 Store 实现是否真的删除，只剩转发；
- clone、排序、时间戳和错误文本是否变化；
- 是否有事务拆成多个公开调用；
- 回滚是否同时覆盖 SQLite 和内存；
- listener 或 SSE 是否在 commit 前收到状态；
- terminal/close 是否漏刷 delta；
- architecture baseline 是否被人为调高；
- 是否创建了只有一个实现、没有现实需要的抽象层。

## 18. 阶段完成条件

只有同时满足以下条件，阶段 3 才能标记完成：

- 3A、3B、3C、3D 均独立完成并通过两轮审核；
- Session、Conversation、Run Repository 成为相应数据的唯一实现所有者；
- 跨域业务动作全部通过 Transaction 入口执行；
- `StorageContext.atomic()` 的协调实现不再依赖 Store；
- 增量输出和 checkpoint 从普通 Store CRUD 中移出；
- `SessionStore` 只剩组合、兼容转发、进程内 listener 协调和 `close()`；
- Store 不再包含上述三域的 SQL 和状态转换规则；
- 失败注入证明 SQLite、read model、mutation buffer、event sequence 和 delta checkpoint 不会半提交；
- terminal 和 close 场景证明最后一段输出已经持久化；
- 旧 API、数据库格式、HTTP、SSE 和用户行为兼容；
- architecture baseline 实际下降且未提高任何旧调用上限；
- 定向测试、类型检查、架构检查和文档检查全部通过；
- `docs/architecture-migration-status.md` 更新为阶段 3 完成，并记录真实证据；
- 主分支可继续构建、测试和发布。

## 19. 后续阶段边界

阶段 3 完成后，阶段 4 才开始把 Server 路由和 Runtime 从万能 Application/Store 入口迁向明确的 Session Query、Run Admission、Run Control、Session Lane、Run Executor、Projection、Recovery 和 Maintenance 服务。

阶段 3 不应提前完成阶段 4 的工作。它只提供稳定、窄而清楚的持久化能力，让下一阶段能够在不理解 `SessionStore` 内部细节的情况下组合业务流程。
