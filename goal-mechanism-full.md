# Codex 桌面应用 Goal 机制完整分析

> 分析对象：`C:\Program Files\WindowsApps\OpenAI.Codex_26.1007.9446.0_x64__2p2nqsd0c76g0`
> 主逻辑来源：`app\resources\app.asar` 内 `build\app-shared-*.js` / `app-primary-*.js` / `app-initial-*.js`（静态提取分析，非运行时观察）
> 分析日期：2026-10-15
> 证据分级：**[obs]** 代码中直接可见；**[inf]** 由代码逻辑推断；**[unk]** 客户端无法确证

---

## 0. 一句话总览

Goal 是**线程（thread/conversation）级的持久目标对象**，由客户端通过 `thread/goal/set` RPC 写到服务端，服务端经 `thread/goal/updated` 推回；设置后客户端会在对话里插入一张合成的 `/goal` 卡片，**不会自动发起下一轮执行**——继续工作发生在空闲时由用户消息或服务端调度驱动。目标完成后客户端会**主动发 `thread/goal/clear` 清掉已完成 goal**，打断当前 turn 时会**把 active goal 自动 pause**。

---

## 1. 核心概念与数据模型

### 1.1 三份会话态字段（客户端 conversation state）

| 字段 | 类型含义 | 何时写入 | 何时清空 |
|------|----------|----------|----------|
| `threadGoal` | 当前目标（active / paused / resumable / complete 等） | set 成功、`thread/goal/updated`、hydrate | `thread/goal/cleared`、set 成功回写 |
| `completedThreadGoal` | 最近一次 complete 的目标快照 | `thread/goal/updated` 且 `status==="complete"` 时复制 | **cleared 事件不清它**；仅被后续 complete 覆盖 |
| `threadGoalResumeConfirmation` | 恢复确认（用于 UI 提示"Resume paused goal?"） | hydrate 时若 flag 开启且 goal 处于 pause 类状态；服务端可能带回 | resume 确认清除、非 pause 类 updated、cleared、暂停前 |

序列化函数 `Z6t`（shared @2623265）**[obs]**：

```js
function Z6t(e){
  return e==null?null:{
    goal: e.threadGoal ?? null,
    completedGoal: e.completedThreadGoal ?? null,
    resumeConfirmation: e.threadGoalResumeConfirmation ?? null
  };
}
```

**[inf]** goal 三元组会随会话快照下发给 UI / 插件等订阅方；`completedGoal` 与 `goal` 分离，说明"正在推进的目标"与"刚完成仅供展示的目标"在状态上是两套。

### 1.2 Goal 对象字段（从调用点反推）

**[obs]** 客户端至少读写：

| 字段 | 出现位置 | 用途 |
|------|----------|------|
| `objective` | `Q6t` 入参、`ENt()` 模板、合成卡 | 目标正文 |
| `status` | `$6t`、updated 处理器、`snn` | 生命周期 |
| `updatedAt` | complete 比对、`e8t.turnStartedAtMs` | 去重与时间线 |
| `id` 等 | 服务端返回后整体回写 `threadGoal` | 服务端主键 **[unk]** 细节 |

**[obs]** `status` 在客户端出现过的取值：

- `active` — 正在推进（设置时客户端只发这个）
- `paused` — 暂停（`$6t`、打断自动 pause 发这个）
- `complete` — 已完成（updated 事件里出现）
- UI 对 **resumable** 有独立文案（@435508 primary），说明服务端状态机还有 `resumable`；客户端把它归入"可恢复"桶

**[inf]** 完整服务端状态枚举客户端未硬编码全集；`active | paused | resumable | complete` 是有证据的最小集合。

### 1.3 与 turn / thread 状态的区别（易混淆）

| 层级 | 状态机 | 代表函数 | 说明 |
|------|--------|----------|------|
| **Turn** | `snn`/`cnn`（shared @2831537） | active/budgetLimited/complete ↔ paused/blocked/usageLimited | 一轮对话的忙闲；**不是 goal** |
| **Thread runtime** | `threadRuntimeStatus` | active 等 | 线程进程/环境态 |
| **Goal** | 服务端权威，客户端跟随 | `threadGoal.status` | 目标生命周期 |

**[obs]** `thread/goal/updated` 处理器用 `snn(goal.status)` 判断"是否 pause 类"来决定是否清 `threadGoalResumeConfirmation`——即 `snn` 的 true 分支（paused/blocked/usageLimited）被复用在 goal 上 **[inf]** 服务端 goal status 与 turn status 枚举有交集，客户端共享了判定函数。

**[obs]** `_fn`（@3149326）turn 启动时 workspace 不可用等会产出 `{status:'paused', reason:Aln}`——这是 **turn 的 paused**，与 goal paused 是两套，文档/UI 必须区分。

---

## 2. 客户端 RPC 协议面

### 2.1 请求（客户端 → 服务端）

| RPC | 方法 | 载荷 | 定义/调用点 |
|-----|------|------|-------------|
| `thread/goal/set` | 设置/改状态 | `{threadId, objective?, status}` | `Q6t` @2623870、`$6t` @2624228、自动 pause @3205858 |
| `thread/goal/clear` | 清除目标 | `{threadId}` | `clearThreadGoal` @3197337、complete 后自动清 @2833962 |
| `thread/goal/get` | 拉取当前 goal | `{threadId}` | hydrate @2936963（**[obs]** 恢复线程后拉取；失败仅 warning） |

**[obs]** **不存在** `thread/goal/resume`：恢复 = 再调 `thread/goal/set` 且 `status:"active"`（或经 `$6t` 改状态）。

**[obs]** set 的两种载荷形状：

1. **首次/替换目标**（`Q6t`）：`{threadId, objective, status:"active"}` — 必带 `objective`
2. **仅改状态**（`$6t`）：`{threadId, status}` — 不带 objective（服务端保留原目标文本）

### 2.2 事件（服务端 → 客户端）

| 事件 | 订阅 map | 处理逻辑 |
|------|----------|----------|
| `thread/goal/updated` | @1936012 `!0` | @2833626：写 `threadGoal`；complete 时写 `completedThreadGoal`；非 pause 类清 resumeConfirmation；**新 complete 自动发 clear** |
| `thread/goal/cleared` | @1936012 `!0` | @2834121：`threadGoal=null`，`threadGoalResumeConfirmation=null`（**不清** `completedThreadGoal`） |

**[obs]** 两事件在通知分发层（@2847445）与 `thread/started`、`thread/status/changed` 等同路由到 `unn(e,o)` 会话更新通道。

### 2.3 返回值约定

**[obs]**

- `thread/goal/set` → `{goal}`：回写为当前 `threadGoal`
- `thread/goal/clear` → 约 `{cleared:boolean}`：`clearThreadGoal` 的守卫分支直接 `Promise.resolve({cleared:!1})` 不发 RPC，说明 UI/调用方按 `cleared` 判断是否成功

---

## 3. 设置 Goal 的完整路径（用户点"设为 Goal"到 UI 出卡）

### 3.1 服务层入口 `Q6t`（shared @2623348 起，`Q6t` 本体 @2623823）

```
用户/插件调用 setThreadGoal(conversationId, {objective, appendTranscriptItem, threadSettings})
  → Q6t(conversation, id, params, history)
```

**[obs]** 步骤：

1. **恢复工作区所有者** `resumeConversationForUnavailableOwner`  
   cwd 缺省 `"/"`，`workspaceRoots:[cwd]`，`collaborationMode` 取会话最近值。
2. **就绪检查**：`status==="not-ready"` 抛 `DB`（`AppServerResumeNotReadyError`）。
3. **断言 follower owner** `assertThreadFollowerOwner`。
4. **设置落盘**（若传了 `threadSettings`）：  
   - 无 settings → `waitForPendingThreadSettingsUpdate`  
   - 有 settings → `updateThreadSettingsForNextTurn`
5. **发 RPC**：`sendRequest("thread/goal/set",{threadId, objective, status:"active"})` → 得 `{goal}`。
6. **写本地态 + 可选合成卡**：
   - `appendTranscriptItem === false` → 只 `updateConversationState` 写 `threadGoal`
   - 否则 → `t8t(conversation, id, goal, createSearchIslandId())`：写 state **并**插入合成 `/goal` 卡片（带 island id 归组）

**[inf]** `appendTranscriptItem=false` 用于静默改目标（不打断对话流）；默认 true 用于用户可见的设置动作。

### 3.2 合成卡 `t8t`（@2624855）

**[obs]**

1. 若已存在"等价合成卡"则 **return 不重复插入**。等价条件：  
   `status==="completed" && items.length===0 && input.length===1 && a.text===ENt(objective)`
2. 否则用 `e8t` 生成合成 turn，经 `uM([])` 包装后并入对话。

### 3.3 合成 turn 的形状 `e8t`（@2624362）

**[obs]** 关键字段：

```js
{
  params: {
    threadId,
    input: [{type:"text", text: ENt(objective), text_elements: []}],
    cwd: null,
    approvalPolicy, approvalsReviewer, sandboxPolicy,
    model: null,
    effort: "minimal",      // 摘要用最小推理
    summary: "none",        // 不生成摘要
    personality: null,
    ...
  },
  status: "completed",      // 卡片自身是"已完成"的展示态
  turnStartedAtMs: goal.updatedAt * 1e3
}
```

**[inf]** 合成卡不是一次真实执行 turn，而是历史里的一条"用户设定了目标"记录；`effort:"minimal", summary:"none"` 说明即使被当成 turn 处理也刻意压低开销。

### 3.4 目标文本模板 `ENt`

**[obs]** `ENt(objective)` 把用户目标包成展示/提交用文本（渲染进合成卡 `input.text`）。具体 i18n 包装见 primary 中 `/goal` 相关字符串。

### 3.5 Composer 侧 prepare（不改状态机）

**[obs]**（primary）

| 函数 | 位置 | 作用 |
|------|------|------|
| `prepareGoalSubmit` | @1359322、@1387722 | 文本清洗/提交前处理 |
| `prepareThreadGoalSubmit` | @1279195、@1303618 | 同上，thread 语境 |

**[obs]** **不存在独立 prepare 阶段**：这些只是输入框文本预处理；`skipGoalSubmit`（primary @231823）仅在 **handoff / 图片 mask** 场景为 `true`，跳过 goal 提交本身，不是通用"预备目标"阶段。

---

## 4. 改状态 / 暂停 / 恢复 / 清除

### 4.1 改状态 `$6t`（@2624324）

**[obs]**

```
setThreadGoalStatus(id, {status, threadSettings})
  → 若 status==="active"：先 settings 就绪（waitFor 或 update）
  → sendRequest("thread/goal/set", {threadId, status})
  → 写回 threadGoal，threadGoalResumeConfirmation = null
```

**[inf]** 恢复暂停目标 = `$6t({status:"active"})`，不是单独 resume RPC。

### 4.2 清除 `clearThreadGoal`（@3197337）

**[obs]** 守卫逻辑：

```js
clearThreadGoal(conversationId, condition) {
  const conv = getConversation(conversationId);
  // 若给了 condition，且不满足 → 直接 {cleared:false}，不发 RPC
  if (condition != null && (
      conv?.threadGoal?.status !== "active" ||
      (condition.threadSource != null && conv.threadSource !== condition.threadSource)
  )) {
    return Promise.resolve({cleared: false});
  }
  return sendRequest("thread/goal/clear", {threadId});
}
```

**[inf]**

- 无 condition 时总是发 clear（UI 确认后调用）
- 有 condition 时要求：goal 仍是 active，且若 condition 带 `threadSource` 则必须与会话一致——防止过期回调误清他线程/goal
- toast 包装 `X9n`（initial @2801347）失败显示 `composer.threadGoal.clearError`

### 4.3 清除 resume 确认（纯本地）

**[obs]** `clearThreadGoalResumeConfirmation`（@3197575）：只 `threadGoalResumeConfirmation = null`，**无 RPC**。  
toast 包装 `Z9n` 失败 → `composer.threadGoal.resumeConfirmation.dismissError`。

### 4.4 打断 turn 时的自动暂停（@3205858）★

**[obs]** 中断路径节选：

```js
const goalActive = getConversation(id)?.threadGoal?.status === "active";
const pause = async (opts) => {
  const {goal} = await sendRequest("thread/goal/set",
    {threadId, status: "paused"}, opts);
  updateConversationState(id, e => {
    e.threadGoal = goal;
    e.threadGoalResumeConfirmation = null;
  });
};
if (goalActive && reason === "system") await pause();
else if (goalActive && reason === "user-stop") {
  try {
    await pause({priority: "critical", timeoutMs: 500});
  } catch (err) {
    log.warning("Failed to pause thread goal before interrupt", ...);
  }
}
// 然后才执行真正的 interrupt $7t(...)
```

**[inf]** 设计意图：中断前先让服务端把 goal 标成 paused，避免打断后服务端仍按 active 目标继续跑；`user-stop` 用 `priority:"critical"` + 500ms 超时——超时只 warning，**不阻塞打断**。

### 4.5 服务 facade 一览（@2504777–2504905、@3197337）

**[obs]** 线程服务暴露：

- `setThreadGoal` → `Q6t`
- `setThreadGoalStatus` → `$6t`
- `clearThreadGoal`
- `clearThreadGoalResumeConfirmation`

---

## 5. 服务端推送驱动的状态同步

### 5.1 `thread/goal/updated`（@2833626）★

**[obs]** 完整逻辑（整理）：

```
params: {threadId, goal}
1. 规范化 threadId → Y(threadId)
2. o = (goal.status === "complete")
     && 会话存在
     && 会话.completedThreadGoal?.updatedAt !== goal.updatedAt
3. updateConversationState:
     threadGoal = goal
     completedThreadGoal = (goal.status === "complete") ? goal : null
     若 !snn(goal.status)  // 非 pause 类
       threadGoalResumeConfirmation = null
4. 若 o（新的 complete）:
     sendRequest("thread/goal/clear", {threadId})
       .catch → logger.error("Failed to clear completed thread goal")
```

**关键行为 [inf]**

| 观察 | 推论 |
|------|------|
| complete 且 `updatedAt` 变化时自动发 clear | **目标完成后客户端自动清除服务端 goal**，避免 active goal 常驻 |
| `completedThreadGoal` 在 clear 的 `cleared` 事件里不清 | UI 可继续展示"刚完成的目标"，直到被下一次 complete 覆盖或会话丢弃 |
| `snn` 为 false 时清 resumeConfirmation | active/complete/budgetLimited 不需要"恢复提示" |

### 5.2 `thread/goal/cleared`（@2834121）

**[obs]**

```
threadGoal = null
threadGoalResumeConfirmation = null
// completedThreadGoal 保持不变
```

**[inf]** 手动 Clear Goal 后，进行中目标消失，但"已完成目标"历史展示字段仍可独立存在。

---

## 6. 线程恢复时的 Goal 水合（hydrate）

### 6.1 恢复后主动 get（@2936963）

**[obs]** 线程 resume 成功后：

```
sendRequest('thread/goal/get', {threadId})
失败 → 仅 warning "Failed to hydrate thread goal after resume"
仅当某 feature flag === !0 时执行
```

**[inf]** get 是可选增强路径，失败不阻断恢复主流程。

### 6.2 水合写入状态（@2941893）

**[obs]**

```
if (getOk) {
  conversation.threadGoal = result.goal;
  conversation.threadGoalResumeConfirmation =
    (flagY === true && result.goal != null && snn(result.goal.status))
      ? result.goal
      : null;
}
```

**[inf]** 仅当产品 flag 开启且 goal 处于 pause 类状态时，才把 goal 同时塞进 `threadGoalResumeConfirmation`，驱动"Resume paused goal?"提示。

### 6.3 水合竞态守卫（@2943884）★

**[obs]** 恢复流程会：

1. 记下 `yt = 当前 threadGoal`
2. `beginThreadGoalHydration(id)` 拿 hydration token
3. promise 返回后：  
   - token 过期 → 直接 return  
   - `当前 threadGoal !== yt`（用户在水合期间改过）→ **不覆盖**  
   - 否则写入新 goal，`resumeConfirmation = null`

**[inf]** 防止慢 get 覆盖用户刚设置/清除的目标。

---

## 7. UI 表现

### 7.1 合成 `/goal` 转录卡

**[obs]**

- 插入：`t8t` + `ENt` + island 分组（`createSearchIslandId`）
- 去重：等价已存在则不插
- Footer 动作：`$7e`（primary @873080）`isActionAvailable` + `onClearGoal`；tooltip "Clear goal" @880019

### 7.2 确认对话框（primary）

| 场景 | i18n id 前缀 | 标题 | 条件 |
|------|--------------|------|------|
| 替换目标 | `composer.threadGoal.replaceConfirmation` | "Replace current goal?" | 已有目标时再设新目标 |
| 恢复暂停 | `composer.threadGoal.resumeConfirmation` | "Resume paused goal?" | `status==='paused'` |
| 恢复 resumable | `composer.threadGoal.resumableTitle` | "Resume goal?" | 其他可恢复态 |

**[obs]** 恢复副文案："ChatGPT will keep working toward this goal when the chat is idle" — **[inf]** 明确产品语义：恢复后**等聊天空闲时**继续推进，而非立刻强制下一轮。

### 7.3 Toast（initial）

| 包装函数 | i18n id | 文案 |
|----------|---------|------|
| `J9n` | `composer.threadGoal.setError` | "Failed to set goal" |
| `Y9n` | `composer.threadGoal.statusUpdateError` | "Failed to update goal" |
| `X9n` | `composer.threadGoal.clearError` | "Failed to clear goal" |
| `Z9n` | `composer.threadGoal.resumeConfirmation.dismissError` | "Failed to dismiss goal prompt" |

### 7.4 忙因（primary @2494982）

**[obs]** `threadGoal?.status==='active'` → 忙因 `{kind:'active-goal'}`，与 `queued-follow-up` / `pending-request` / `active-runtime` / `active-turn` 并列。

**[inf]** UI 在有 active goal 时把线程标为"忙/占用"，可能影响是否允许新 turn 或是否展示"继续"入口。

### 7.5 路由

**[obs]** RouteScope（@5026334）：`GOAL:"goal"` 与 `PLAN:"plan"` 是**独立** route kind（另有 BROWSER/DIFF/MCP_APP/SOURCES/TIMELINE/DIGEST）。

**[inf]** Goal 有独立视图路由，与 Plan 并列、互不包含。

---

## 8. 执行语义：设置后到底跑不跑？

### 8.1 结论

**[obs]** 设置 goal 的全部客户端路径只有：

1. 发 `thread/goal/set` active
2. 写本地 state
3. 插入展示用合成卡

**没有任何**客户端代码在 set 成功后自动调用 turn 启动 / `codex/event` 发起下一轮。

### 8.2 "空闲时继续"的机制归属

**[obs]** UI 副文案写 "when the chat is idle"；打断前先 pause goal；complete 后自动 clear。

**[inf]** 持续推进循环在**服务端**（Codex backend）：active goal + 线程 idle → 服务端调度下一轮（可能仍经客户端 turn 管道，但触发源不是客户端 set 代码）。客户端静态分析无法看到服务端调度器 → **[unk]** 服务端触发条件（轮次上限、工具失败重试、token 预算等）。

### 8.3 已排除的"客户端自动续跑"机制

| 候选 | 结论 | 证据 |
|------|------|------|
| `skipGoalSubmit` | 仅 handoff/图片 mask 跳过提交 | primary @231823 |
| `din()` / `features.sleep_tool` | 仅 isAeon && !isDurable，后台持久线程休眠续起 | shared @2885843 |
| AEON 相关 | 12 处全为 UI 呈现 | shared 多处 |
| `continuationInput` | 仅 `thread.status.type==="idle"` 时取用 | shared @3026187 |
| `udn`/`ddn` | 只检测 `placeholder===\`aeon-continuation\`` | shared @3070701 |
| `autoContinue`/`keepGoing`/`nextTurn` | mech-context 全文 0 命中 | 扫描 |
| `Qin` | AEON+durable → `orchestrator_skills:!0` 等，非 goal | shared @2907510 |
| turnTrigger | 功能开关 + handoff 标签，非自动续跑 | shared @1861126、primary @231823 |

---

## 9. 与 Plan / AEON / token 预算的关系

### 9.1 Plan 独立

**[obs]** Plan 走 `turn/plan/updated` 事件；RouteScope 有独立 `PLAN`；与 goal 状态字段无交集。

**[inf]** Goal 是"要达成什么"，Plan 是"打算怎么做"的步骤列表；可并存、互不驱动。

### 9.2 AEON / durable

**[obs]**

- `thread/startAeon` 独立 RPC，`priority:"critical"`，durable 语义
- isDurable config 注入 `features.code_mode.direct_only_tool_namespaces:["mcp__codex_apps__hotline"]`
- Goal 代码路径与 AEON 字符串无交集

**[inf]** Goal 不是 AEON 的实现；AEON 是另一套持久线程产品面。

### 9.3 token 预算

**[obs]**

- `token_budget` 仅 history notes 压缩（`Drn` 注入 `use_history_notes_extension:!0`）
- UI 层 26 关键词 × 5 文件 × goal 相关扫描 = **0** 客户端工具限额
- zod `maxTurns≤100 / maxItemsPerTurn≤500`（shared @2775087）= **可请求的分页上限**
- `tmi={maxTurns:5,maxItemsPerTurn:100}`（initial @4274646）= **后台 subagent 水合截断**，非 goal 限额
- goal 状态里出现过的 `budgetLimited`（在 `snn` 分支）**[inf]** 来自服务端用量/预算信号，不是客户端配置的工具次数上限

**[unk]** 服务端对单个 goal 的工具调用次数 / 最大 turn 数 / token 硬顶。

---

## 10. 错误处理

**[obs]**

| 错误 | 位置 | 含义 |
|------|------|------|
| `DB` / `AppServerResumeNotReadyError` | shared @2623265 类定义 | set 前工作区未就绪 |
| `goal_not_found` | shared @2018777 | 错误映射文案 |
| hydrate get 失败 | @2936963 | warning，不阻断恢复 |
| 自动 clear 失败 | @2833962 | error log "Failed to clear completed thread goal" |
| 打断前 pause 失败 | @3205858 | warning "Failed to pause thread goal before interrupt"，继续打断 |
| toast 四条 | initial @2801347 | set/status/clear/dismiss 失败提示 |

---

## 11. 端到端时序（汇总）

### 11.1 用户设置目标

```
Composer 输入 → prepareThreadGoalSubmit（文本清洗）
  → [若已有目标] Replace confirmation
  → setThreadGoal → Q6t
      resume owner → assert follower → settings
      → RPC thread/goal/set {objective, status:active}
      → 写 threadGoal
      → t8t 插入 /goal 合成卡（island）
  → 服务端稍后 thread/goal/updated 广播（全客户端一致）
```

### 11.2 服务端推进（推断的黑盒边界）

```
idle + active goal → [服务端调度 unknown] → 走正常 turn 通道
  → 若被打断（system / user-stop）
      → 客户端先 thread/goal/set paused
      → 再 interrupt turn
  → 若完成
      → thread/goal/updated {status:complete}
      → 客户端记 completedThreadGoal
      → 客户端自动 thread/goal/clear
      → thread/goal/cleared → threadGoal=null
```

### 11.3 用户恢复暂停目标

```
UI "Resume paused goal?"（或 Resumable "Resume goal?"）
  → setThreadGoalStatus → $6t {status:active}
  → RPC thread/goal/set {status:active}
  → resumeConfirmation = null
  → 等空闲时服务端继续（文案语义）
```

### 11.4 打开历史线程

```
resume thread → thread/goal/get（flag 开）
  → 成功：threadGoal=goal；若 pause 类且 flag → resumeConfirmation=goal
  → 竞态：hydration token + goal 未变才写入
```

---

## 12. 问题三问的答案（定稿）

### Q1 是否存在独立 prepare 阶段？

**否。** 仅有 composer 文本清洗 `prepareGoalSubmit` / `prepareThreadGoalSubmit`；`skipGoalSubmit` 只在 handoff/图片 mask 跳过提交。真正的"准备"是 `Q6t` 内的 resume owner + settings 就绪。

### Q2 客户端是否有工具调用限额？

**否（UI 层）。** 客户端无 goal 工具次数配置。`token_budget` 管历史压缩；`maxTurns`/`maxItemsPerTurn` 是分页与 subagent 水合参数。若存在运行时限额在服务端 → unknown。

### Q3 Goal 的执行入口是什么？

**客户端只负责状态同步：** `thread/goal/set` 写入 → 本地 `threadGoal` → 合成卡展示；服务端经 `thread/goal/updated` 推回并（推断）在 idle 时调度执行。客户端**不**自动开 turn。完成后客户端自动 `thread/goal/clear`；打断时自动 pause。

---

## 13. 证据索引（关键 offset）

| 主题 | 文件 | 约略 offset |
|------|------|-------------|
| 订阅 map goal/cleared,updated | app-shared | @1936012 |
| goal 错误映射 | app-shared | @2018777 |
| Z6t 三元组 | app-shared | @2623265 |
| Q6t set 全流程 | app-shared | @2623348–2624228 |
| $6t 改状态 | app-shared | @2624324 |
| t8t 合成卡 | app-shared | @2624855 |
| e8t 合成 turn | app-shared | @2624362 |
| snn/cnn turn 状态机 | app-shared | @2831537 |
| thread/goal/updated 处理器 | app-shared | @2833626 |
| thread/goal/cleared 处理器 | app-shared | @2834121 |
| 通知路由 unn | app-shared | @2847445 |
| hydrate 写入 | app-shared | @2941893 |
| hydrate 竞态 | app-shared | @2943884 |
| 打断自动 pause | app-shared | @3205858 |
| 服务方法定义 | app-shared | @3197337–3197649 |
| 服务 facade getters | app-shared | @2504777–2504905 |
| skipGoalSubmit | app-primary | @231823 |
| prepare*Submit | app-primary | @1279195, @1359322 等 |
| clear goal footer | app-primary | @873080, @880019 |
| replace/resume 确认 UI | app-primary | @433334, @435508 |
| active-goal 忙因 | app-primary | @2494982 |
| RouteScope GOAL | app-primary | @5026334 |
| toast 包装 | app-initial | @2801347 |
| subagent maxTurns | app-initial | @4274646 |
| turnTrigger flag/version | app-shared / app-initial | @1861126 / @4914698 |

---

## 14. 残留 Unknown

1. **[unk]** 服务端 goal 调度器：idle 后何时/按何种轮次或预算自动继续。
2. **[unk]** goal 对象完整服务端字段（id、依赖 turn 列表、工具预算等）。
3. **[unk]** `thread/goal/get` 在非 hydrate 场景是否还有调用点（本轮 regex 扫描被 8 条上限截断，get 未出现在前 8 条，但 hydrate 路径已有独立证据）。
4. **[unk]** `resumable` 与 `paused` 在服务端如何互相转换。
5. **[unk]** 多设备/多客户端下 updated/clear 的并发仲裁（仅见 updatedAt 去重与 hydration token）。

---

*本文档全部基于对 asar 内压缩 JS 的静态分析与 offset 引用；未启动应用，未观察真实 RPC 流量。*
