# 按记录恢复事务 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 普通事务不再深复制全局会话历史，只备份第一次改动的记录，并保持完整失败恢复。

**Architecture:** database 层提供通用 TransactionJournal 和 atomicWrite。Repository 明确捕获实际写入；内存持久层与临时控制容器捕获自身数据。全部写入口接入后切换协调器，并在提交回调之前解除备份。

**Tech Stack:** TypeScript、现有 Vitest、better-sqlite3、Drizzle，无新依赖。

**Spec:** `docs/superpowers/specs/2026-10-07-transaction-record-rollback-design.md`

## Global Constraints

- 隔离工作区：`D:/code/personal-project/OpenHarness-ts/.worktrees/transaction-record-rollback-20261007`。
- 不减少历史、截断输出、更改刷新间隔或修改 UI；不增加依赖、数据库迁移、Proxy 或公开客户端/HTTP API。
- 先观察新增回归失败，再实现，执行相关测试；实现阶段不自动提交，后续按用户明确授权审核后提交；不推送或发布。
- 每个任务只编辑自己的文件，不派生子代理。实际测试使用 `node ../../node_modules/vitest/vitest.mjs run <files> --maxWorkers 1`，工作目录为对应 package。
- 外层提交后的回调接收的数据必须留存；失败通知、旧事件引用、临时删除的路由和所有权检查不能退步。

## Task 1: 通用按键恢复工具

**Files:** 创建 `packages/services/src/database/transaction-journal.ts`、`transaction-journal.test.ts`、`atomic-write.ts`、`atomic-write.test.ts`；修改 `storage-context.ts` 增加 optional rollback 字段。暂不改 coordinator 或移除 transactionState。

**Interfaces:** 提供 spec 中的六个 journal 方法与 atomicWrite 签名。`capture` 对象键和 `captureMap` Map 键首次保存深复制旧值；`captureEvents` 只保存原数组引用/长度；`previous` 读取已捕获旧值；`rollback` 逆序恢复，执行所有恢复项后汇总错误；`clear` 丢弃所有备份。helper 执行 `const result = storage.atomic(work); save?.(); return result;`，保留 post-commit save。

- [x] 写嵌套字段、多次修改、原本不存在、删除后重建、Map、events append/filter、clear/previous 和恢复错误继续执行的单测；helper 验证 work 失败不 save，成功在 atomic 返回之后 save。
- [x] 运行两份新增测试，确认尚无实现时失败。
- [x] 实现通用工具，捕获去重必须按 target+key，值用 structuredClone；不遍历未捕获目标。
- [x] 运行测试及检查，写 Task 1 报告，供独立审查。

```ts
const rows = { one: { nested: { value: 1 } } };
const journal = new TransactionJournal();
journal.capture(rows, "one");
rows.one.nested.value = 2;
journal.capture(rows, "one");
journal.rollback();
expect(rows.one.nested.value).toBe(1);
```

## Task 2: 可靠业务和流式写入口

**Files:** 修改 `sessions/session-repository.ts`、`runs/run-repository.ts`、`permissions/permission-repository.ts`、`conversations/conversation-repository.ts`、`conversation-transactions.ts`、`conversation-tree-operations.ts`、`incremental-output.ts`、`projects/project-repository.ts`；可新增 `conversations/record-rollback.test.ts` 与调整相关单测。不改 database/coordinator、chat-persistence、goals、store。

**Interfaces:** 消费 Task 1 的 `atomicWrite(storage, work, save)` 与 `storage.rollback?.capture(table, id)`。

- [x] 补独立 Session/Run/Message/Part 写失败的内存和重开验证、权限 nested payload、旧事件独立、读取事件不修改排序、重建/删除记录的回归。
- [x] 运行回归确认失败，再接入以下捕获清单。
- [x] 可靠独立写方法进入 atomicWrite 后才修改，保留原有 no-op 短路；流式入口仅捕获、不为每个增量创建新事务。
- [x] 全部捕获在首次字段写入/删除/赋值前。核心 old-value 去重由 journal 负责。
- [x] 入队 payload 使用 structuredClone；保留事件返回值隔离；事件查询使用数组副本，历史不得原地改动。
- [x] 运行相关测试，写 Task 2 报告并审查。

捕获清单：Session 写 sessions；Message 写 messages+session；Part 写 parts+message+session；Run 写 runs+session；Attempt 写 attempts；Task 写 tasks+session，必须在 runId 首次变化前捕获；Permission 写 permissions（包含 payload.answer）；admission 写 inputs/inputAttachments/session；replace/edit/delete 捕获每个被删除或新增键及 session；project.rebindDirectory 捕获改 cwd 的 session；增量捕获 run 或 part/message/session。

```ts
storage.rollback?.capture(storage.state.sessions, session.id);
session.title = title;
// 原有 mutation 标记和事件不变。
```

## Task 3: 临时持久化和控制行

**Files:** 修改 `database/chat-persistence.ts`、`temporary-control-records.ts`、`goals/goal-repository.ts`、`session-runtime/projection-settlements.ts`、`session-runtime/store.ts`（仅控制容器初始化）；新增或调整对应测试。不改 Task 2 文件。

**Interfaces:** 消费 journal.capture/captureMap/captureEvents/previous；MemoryChatPersistence 与 TemporaryControlRecords 接收可选 `() => TransactionJournal | undefined` 获取当前 frame；控制容器提供显式 `capture(map, key)` 供业务写入口调用，不包办业务 set/delete。

- [x] 补内存记录删除/重建、临时 delta 和 Map 更新/删除的按键回滚测试，确认新行为未实现时失败。
- [x] Memory commit/checkpoint/delete 每个键写前捕获，events 用 captureEvents，nextEventSeq 用 capture；保留显式 snapshot/load/restore API。
- [x] 控制容器删除五类 Map 键前捕获；GoalRepository 十处 set、projection-settlements 五处 set 捕获键；存储构造 getter 指向 storage.rollback。
- [x] Router 当前行优先，其次 journal.previous，最后暂留 transactionState fallback，直到 Task 4 移除。
- [x] 运行临时聊天、控制、goal/settlement 回归；写 Task 3 报告并审查。

```ts
const previous = storage.rollback?.previous(storage.state.sessions, sessionId);
const session = storage.state.sessions[sessionId] ?? previous ?? storage.transactionState?.sessions[sessionId];
```

## Task 4: 协调器切换和全局回归

**Files:** 修改 `database/transaction-coordinator.ts`、`storage-context.ts`、`chat-persistence.ts`（只移除旧 fallback）、`transaction-coordinator.test.ts`、`session-runtime/store.ts`（仅移除失败后整库 reload）、`session-runtime/store-save.test.ts`；可新增 `transaction-record-rollback.test.ts`、适配 Task 2 的 manual journal 测试。

**Interfaces:** 先 assertWritable，再建立外层 frame 并 captureEvents(storage.state)，保留 eventSequence/checkpoint/mutations 的小型快照；嵌套复用 frame。移除全 state/memory/control snapshot 和 transactionState。失败先解除 frame，再逆序恢复并还原小型状态；提交成功先 clear/解除 frame，再执行原有 deferred callbacks。save 失败直接传播协调器异常，不重载整库或清空既有待写文本。

- [x] 更新旧全量备份测试为零次全局 state 复制；补无关 getter 不访问、两个临时会话只备份改动一方、旧归属删除路由、after-commit accepted 数据与失败恢复。
- [x] 补 after-commit 接收正式文本后 checkpoint 保存失败的回归：已显示文字和 dirty part 仍保留，去掉故障后可 flush；补省略 save 的 admission/replace 在 owner 被接管后不得提交。
- [x] 跑新性能回归确认旧协调器失败；切换到 journal。
- [x] 运行 services 存储相关完整测试及 server 投影测试；修复遗漏写入口，不通过降低断言掩盖问题。
- [x] 独立审查所有原地写入和事件引用，验证现有边界与完整回滚。
- [x] 做隔离对照：同样历史量下记录全局 clone 次数、捕获记录数、标题更新耗时；不承诺固定整机降幅。
- [x] 对比主目录改动，保留重叠的 clearWorktreeBinding；仅带回本次文件与设计/计划，完成主目录必要验证。

```ts
const previousJournal = storage.rollback;
const journal = new TransactionJournal();
storage.rollback = journal;
journal.captureEvents(storage.state);
// 原有 SQLite work / persist / commit。
storage.rollback = previousJournal;
journal.clear();
// 然后执行既有提交回调。
```

## 交付验证（2026-10-07）

- 主目录 services 存储相关 8 个目录：34 个测试文件、348 项通过；包含新增权限共享对象与工作目录绑定回滚测试。
- 主目录 server 消息投影、工作目录绑定接口与持久化边界：5 个文件、65 项通过。
- 主目录 services `tsc --noEmit` 通过；本次文件 `git diff --check` 通过。
- 28 个任务文件与已审查隔离版本一致；会话仓库保留用户新增导入、错误、校验和 no-op，只为实际维护写入补事务及逐记录捕获。整体审查及主目录重叠限定复查通过。
- 同进程交替测量旧、新 SessionStore，2,000 条各 4,096 字符的历史 part，预热后各 6 轮：旧版每轮全局复制 1 次，耗时中位数 29.38 ms，堆内存增量中位数 21.29 MiB；新版全局复制 0 次，1.68 ms、0.47 MiB。这是合成标题更新的临时分配数据，不代表整机常驻内存降幅。
- 未减少历史、截断流式输出、降低刷新频率，未新增依赖、数据库迁移或公开 API；实现阶段未提交或发布。

## 提交前复核（2026-10-07）

- 用户随后明确要求审核、必要修订并提交；两路独立审查未发现阻断问题，不扩大实现范围。一处事件返回值的重复复制属于非阻断的后续简化建议，本轮保留。
- 提交的独立版本重新验证：services 存储相关 32 个文件、341 项通过；server 消息投影 3 个文件、52 项通过；services `tsc --noEmit` 通过。
- 本次提交只包含事务优化及对应文档/测试。会话仓库按不含其它功能的隔离版本暂存；主目录已有的工作目录绑定维护操作、其事务保护与专门测试仍保留在工作区，待与该功能未提交的协议/接口依赖一起提交。
- 不推送、不删除隔离工作区，不改动其它未提交功能。
