# Codex Goal 机制逆向分析 — 最终结论

分析对象：`C:\Program Files\WindowsApps\OpenAI.Codex_26.1007.9446.0_x64__2p2nqsd0c76g0\app\resources\app.asar`
方法：REA 静态提取 `app.vite\build\` 共 15 个 JS 文件到 `%TEMP%\codex-asar\build\`，关键词上下文扫描 + 逐段判读。
所有结论按 observation（直接看到的代码）/ inference（基于代码的推断）/ unknown（客户端无法确证）分级。

---

## 问题一：Goal 是否有独立的"准备阶段"（prepare）？

**结论：没有独立的执行前准备阶段。只存在提交文本前的本地清洗（composer 层面的文本准备），不涉及任何后台会话、预热或沙箱准备。**

- observation — 代码里仅有两个"prepare"函数，都在 UI 输入框（composer）层：
  - `prepareGoalSubmit`（`app-primary-cd52df2361eb.js` @1359322、@1387722）：把输入框文本清洗成可提交的 goal 描述，剔除占位符、合并图片 mask 等。
  - `prepareThreadGoalSubmit`（@1279195、@1303618）：同上，针对"向已有会话追加 goal"的场景。
- observation — `skipGoalSubmit` 标志只在"handoff、图片 mask"等场景跳过提交，与任何准备流程无关。
- observation — 全部提取文件中没有 "prepareSession / warmup / preflight" 之类的 goal 前置阶段。
- inference — 所谓 prepare 就是输入框的文本加工，用户按下提交后直接发起网络请求，无本地等待的独立阶段。

## 问题二：是否存在工具调用次数限制？

**结论：客户端（UI 与主进程 JS）没有任何"每次对话最多允许调用 N 次工具"的限制。若生产环境存在此类限制，只能在服务端（Codex 后端），客户端静态分析无法确证。**

分层证据：

| 层级 | 发现 | 定性 |
|---|---|---|
| UI 全量 | `tool_call_limit / max_tool_calls / toolCallLimit` 26 个关键词 × 5 个文件 = 0 命中 | observation：UI 层不存在工具限额 |
| 轮次触发器 | `turnTrigger` 只记录"是什么触发了这一轮"（用户输入、后台线程等），不含 goal 专属的触发规则 | observation |
| token 预算 | `token_budget` 与 `tokenBudgetHistoryNotes` 仅用于"把历史压缩成 notes 塞回上下文"的省 token 手段，不影响工具调用 | observation — `Drn`（L201）注入 `use_history_notes_extension:!0` |
| 后台 subagent | `tmi={maxTurns:5,maxItemsPerTurn:100}`（`app-initial` @4274646）：后台子线程水合时，最多加载 5 轮 / 每轮 100 条历史项，**是显示截断，不是执行限额** | observation |
| 客户端可请求参数 | zod schema `maxTurns≤100 / maxItemsPerTurn≤500`（app-shared @2775087）：客户端可向服务端声明的历史分页上限 | observation |
| 原生侧 | `app\Codex.exe` 仅 20KB 薄壳，真实后端不在本地进程内 | observation |
| 服务端 | 运行时若存在"最多 N 次工具调用"，判定发生在 Codex 后端 | unknown |

## 问题三：目标（Goal）如何进入执行？

**结论：Goal 在客户端只负责"提交 + 本地状态展示"，真正进入执行、是否继续下一轮、是否结束，全部由服务端驱动。客户端不存在自动续跑循环。**

流程（observation，入口 → 请求 → 状态 → 结果返回）：

1. 用户在输入框写目标 → `prepareGoalSubmit` 清洗文本。
2. 客户端 `sendRequest("thread/goal/set", {threadId, objective, status:"active"})`（app-shared @2623823）发给服务端。
3. 服务端返回 `goal` 对象 → 客户端写入本地会话状态 `threadGoal`（active | paused | resumable）。
4. `t8t`（@2624855）仅向本地转录里追加一条合成的 `/goal` 卡片，是显示，不是执行步骤。
5. `e8t`（@2624362）用 `effort:"minimal", summary:"none"` 组装展示摘要，同样是 UI 层。
6. 服务端执行完毕后推送 `thread/goal/updated`（@2833626）；若 status=complete，客户端只做历史水合/清理，不会自动发起下一轮。
7. 失败时服务端错误 `goal_not_found`（"no goal exists"，@2018777）被映射为 UI 提示。

关于"是否自动多轮"的三个机制，全部排除：

- **sleep_tool（睡眠工具）**：`din()`（app-shared @2885843）在 `isAeon && !isDurable` 时注入 `features.sleep_tool:!0`。它是**后台持久线程休眠后被服务端唤醒再继续**的机制，不是"当前对话自动继续下一轮"。
- **AEON 标志**：12 处命中全部是 UI 呈现/转录过滤（如 `isAeonThread`、历史位置键），无一参与执行循环。
- **continuationInput（续跑输入）**：@3026187 明确只在 `thread.status.type === "idle"`（线程空闲）时才取用；活跃执行中不会触发。
- **autoContinue / keepGoing / nextTurn**：mech-context.txt 256 行上下文全部扫描，0 命中。

附加发现（observation）：
- Plan 与 Goal 是两套独立状态（`command:plan-mode` 与 `command:goal` 并列）。
- `thread/startAeon` 是一条独立 RPC（hostId===durable 时触发，priority:"critical"），用于持久后台线程。
- isDurable 线程的 config 与普通线程不同：`features.code_mode.direct_only_tool_namespaces:["mcp__codex_apps__hotline"]`。

---

## 一句话总结

Goal 没有独立准备阶段（只有输入框文本清洗）；客户端没有工具次数限制（若有只能在服务端，本地无法确证）；Goal 通过 `thread/goal/set` RPC 提交后由服务端驱动执行，客户端只负责显示状态——sleep_tool / AEON / continuationInput 都不是"自动继续下一轮"的机制。
