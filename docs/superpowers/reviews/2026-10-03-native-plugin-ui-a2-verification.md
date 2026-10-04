# Native Plugin UI A2 验收证据

> 状态：当前 A2 后台实现与回归记录；任务 1–7 已经任务审查，最终审查的三项原问题及普通 Run 关闭遗漏均已修复。本次关闭修复完成 69 项定向回归和类型检查，由控制器直接实施与自查，没有重复全分支独立审查。不是 Desktop 首版发布验收；未合并、推送或发布。
> 日期：2026-10-03
> 分支：`codex/plugin-ui-a1`；A2 基线 `1be4f0c7`，本次最终回归基线 `af5f9bc8`。

## 验证范围与实际流程

模型调用已选择插件的 Native Tool 后，可靠事件投影先验证捕获的插件文件，再在保存原工具 Part 的事务中保存可信实例。Client 读取实例或 HTML 时，daemon 重读安装、启用、授权和摘要；动作提交先保存唯一 Run 与实例 revision，再进入既有会话执行队列。实际 Agent 的单工具入口复用参数检查、权限、Hook、超时和取消；结果、动作 Run 和源实例一起结算到 SQLite。动作不创建模型输入或模型 Attempt，不请求模型，也不唤醒 Goal。后续普通模型输入得到有限外部结果摘要。

本次使用已有本地依赖；真实 Native Tool 在独立 Node 进程运行，测试会创建并重开真实 SQLite。HTTP 用生产 Daemon、Hono `app.fetch` 和真实 VykorClient；普通模型流采用固定本地输出，独立 UI 动作的模型客户端会在任何请求时抛错。没有连接模型、外部网站或发布服务，没有新增依赖。

所有下列 pnpm 命令的前缀为 `pnpm --config.manage-package-manager-versions=false`，均在隔离 worktree 提权读取既有本地依赖。先运行 Runtime build，再检查 Server / Desktop 类型。测试名称指向实际执行的测试，而非源码字符串检查。

## 本次命令与结果

| 标记 | 命令（省略上述共同 pnpm 前缀） | 实测结果 |
| --- | --- | --- |
| R1 | `--filter @vykor/core exec vitest run src/engine/checked-tool-execution.test.ts src/engine/query-tool-preparation.reuse.test.ts src/engine/query-tool-limits.test.ts src/engine/integration.test.ts src/engine/tool-workflow.integration.test.ts src/engine/tool-result-feedback.test.ts src/engine/tool-input-reuse.integration.test.ts src/engine/tool-input-alias-conflict.integration.test.ts` | 8 files，161 passed，0 failed |
| R2 | `--filter @vykor/agent-runtime exec vitest run src/agent-run-tool.test.ts src/run-capability-view.test.ts src/run-capability-mcp.test.ts src/run-capability-skills.test.ts src/agent.test.ts src/agent-post-run-child.test.ts src/runtime-integrations.test.ts src/plugin-capability-inventory.test.ts src/plugin-discovery.test.ts src/native-tools/tool-host.test.ts` | 10 files，110 passed，0 failed |
| R3 | `--filter @vykor/server exec vitest run` 后接下列 Server 文件集合 | 20 files，298 passed，0 failed；之后四项真实 UI-15 补充与夹具调整由 R4 重新验证 |
| R4 | `--filter @vykor/server exec vitest run src/application/session/__test__/session-plugin-ui-action.test.ts src/http/__test__/session-plugin-ui.test.ts` | 最终 2 files，53 passed，0 failed（action 41、HTTP 12） |
| R5 | `--filter @vykor/agent-runtime exec vitest run src/agent-run-tool.test.ts` | 最终夹具清理后 13 passed，0 failed |
| R6 | `--filter @vykor/protocol exec vitest run src/plugin-ui.test.ts src/plugin-ui-requests.test.ts src/requests.test.ts` | 3 files，122 passed，0 failed |
| R7 | `--filter @vykor/client exec vitest run src/resources/plugin-ui-resource.test.ts src/__test__/public-api.test.ts` | 2 files，9 passed，0 failed |
| R8 | `--filter @vykor/plugins exec vitest run src/components/ui.test.ts src/components/ui-schema.test.ts src/installation/verify-ui.test.ts` | 3 files，37 passed，0 failed |
| R9 | `--filter @vykor/services exec vitest run src/conversations/conversation-transactions.test.ts` | 52 passed，0 failed |
| R10 | `--filter @vykor/agent-runtime build` | exit 0；kernel 203.9 kb、index 3.6 mb |
| R11 | `--filter @vykor/protocol --filter @vykor/core --filter @vykor/agent-runtime --filter @vykor/server --filter @vykor/client --filter @vykor/services --filter @vykor/plugins --filter @vykor/desktop check-types` | 七个提供 check-types 的包 exit 0；Desktop 使用 R12 的实际脚本 |
| R12 | `--filter @vykor/desktop typecheck` | node / web 两项 tsc 均 exit 0 |
| R13 | `check:client-api` | public API tsc exit 0；Node 契约 31/31；Client 公开出口 4/4 |
| R14 | `test:client-browser` | exit 0；60 modules，49.70 kB；真实浏览器 Client 消费，无 Node 引入 |
| R15 | `exec tsc --noEmit --skipLibCheck --module NodeNext --target ES2022 packages/agent-runtime/test-helpers/native-ui-logs.ts` | test-only 日志夹具类型 exit 0 |
| R16 | `check-docs` | exit 0；Markdown 链接、当前文档入口、源码路径与废弃接口检查通过 |
| R17 | `git diff --check`（非 pnpm 命令） | exit 0；Git LF/CRLF 通知是环境提示，非 UI 生产错误 |
| R18 | `--filter @vykor/server exec vitest run src/http/__test__/plugin-ui-privacy.test.ts src/http/__test__/session-plugin-ui.test.ts` | Task 7 privacy 审查修正后 2 files，16 passed，0 failed（独立注入4、真实 HTTP12）；修改后的 R15 utility tsc 也 exit 0 |

R3 的完整文件集合（均相对 `packages/server`）：

```text
src/application/session/__test__/session-plugin-ui-action.test.ts
src/application/session/__test__/session-plugin-ui-service.test.ts
src/application/session/__test__/session-run-engine.test.ts
src/application/session/__test__/session-run-executor.test.ts
src/application/session/__test__/session-interaction-service.test.ts
src/application/session/__test__/session-interaction-service-edit.test.ts
src/application/session/__test__/session-maintenance-service.test.ts
src/application/session/__test__/run-admission-service.test.ts
src/application/session/__test__/transcript-projection.test.ts
src/application/recovery/startup-recovery-service.test.ts
src/application/agent/__test__/agent-transcript.test.ts
src/application/agent/__test__/daemon-agent-event-projector.test.ts
src/application/agent/__test__/tool-progress-projection.test.ts
src/application/agent/__test__/projection-settlement-recovery.test.ts
src/session/__test__/export-session.test.ts
src/runtime/__test__/run-coordinator.test.ts
src/http/__test__/session-plugin-ui.test.ts
src/http/support.test.ts
src/http/protocol-middleware.test.ts
src/http/routes/protocol-validation.test.ts
```

## 验收项与具体消费者

下表中的 `action`、`service`、`HTTP` 分别为上述 Server 的 `session-plugin-ui-action.test.ts`、`session-plugin-ui-service.test.ts`、`http/__test__/session-plugin-ui.test.ts`；`Runtime` 为 `agent-run-tool.test.ts`。同一测试被多项引用，不重复计数。

| 验收 | 实际行为与测试名称 | 证据及界限 |
| --- | --- | --- |
| UI-05 | Runtime `captures approved UI provenance without exposing it to baseline`、`withdraws invalid UI action … while keeping Native tools usable`；run-capability-view `does not admit a UI action with invalid provenance`（builtin、MCP、other plugin、无来源） | R2 / R5，真实注册来源、冻结定义与真实 Native 调用；其他来源拒绝由捕获视图验证 |
| UI-06 | Core tool-result-feedback 外部保留 metadata 过滤；Protocol plugin-ui-requests 严格身份/JSON/revision/state 读取；service `never authorizes copied, mismatched, uncommitted or removed source Parts`、`rejects durable source corruption`；HTTP `enforces auth, Origin, ownership, strict JSON and byte limits without invoking` | R1 / R3 / R4 / R6，字段在 Part、Run、HTTP 和 Client 中有实际消费者；不依赖客户端身份声明 |
| UI-07 | service `persists host identity in the source Part, preserving raw output, and reads after SQLite reopen`、事务回滚/重复 delivery/无效 proposal 案例；HTTP `rechecks a warm linked source after the Native tool changes files, keeping successful text but no new instance` | R3 / R4，可靠投影与真实数据库；无效 UI 保留业务成功文字 |
| UI-08 | HTTP `wires source capture, authenticated Client actions, durable retries, summaries and export through the real daemon` 初始普通 Run；Runtime `executes a real Native child … without history or models` | R4 / R5，初始模型 Run 在没有挂载 UI 时完成；UI 动作模型调用计数不变 |
| UI-09 | checked-tool-execution `prevents side effects after … rejection`、`uses ordinary approval before invocation`、`reports timeout with an unknown outcome and aborts the invocation`；tool-workflow `serializes same-group execution while other tools can release the first call`、取消/可靠失败/Hook 案例；Runtime 真实权限与 close/signal；HTTP `uses the real permission broker and never runs a denied Native action` | R1 / R2 / R4，原模型批次与独立动作共用受检执行；覆盖 preparation、reuse、permission、hook、组序、超时、批次取消 |
| UI-10 | action `atomically admits one deterministic Run and rejects changed retries before availability checks`、`executes the real Native tool once … after reopen/fork`、`accepts boundary-depth args and canonical retries independently of object key order`；HTTP restart / HTTP abort 后相同 Client 请求重试 | R3 / R4，实际副作用计数为一次，requestId 改参冲突 |
| UI-11 | action `owns admitted args across awaits and rejects another client's stale revision`、`rejects new … actions without executing a tool`（busy、revision、archived、resolved、dismissed 等）、最终 await 边界重查 | R3 / R4，两份请求模拟客户端竞争；真实 operation gate 和会话队列，不是两个真实 Desktop 窗口 |
| UI-12 | action `converges admission … failure without a Native side effect`（transaction / queue）、`does not invoke after the durable before-invoke transaction fails`、`retains unknown and old data when final result saving fails after the real side effect` | R3 / R4，事务/入队/结果保存故障注入，真实副作用与 pending 收敛 |
| UI-13 | action `recovers … from reopened SQLite without inventing an invocation`（pending、running-before-tool、running-after-tool）；HTTP `settles durable … actions through the real startup callback before ordinary interruption` | R3 / R4，真实重开和生产 startup callback；unknown 不重放 |
| UI-14 | action `dismisses idempotently without tools, allowing unknown but rejecting changed revisions`、活动取消/禁止运行中 dismiss、`allows dismiss while a normal Run is busy and plugin rendering is disabled`；HTTP `retains admitted Native work after its HTTP caller aborts and safely retries` | R3 / R4，后台 dismiss 与 Run cancel 分开，客户端断开不撤销准入动作；renderer 关闭显示待 A3 |
| UI-15 | action `preserves the real Native … result while guarding UI data updates`（valid / malformed / foreign / error），真实 resolve 成功、permission/arguments not_started、活动取消 unknown、final-save failure | R3 / R4，新四项均走实际 Native 子进程；非法更新保留旧 data，成功 keep-open / resolve 与失败状态准确；返回 isError 的已启动调用遵循共享执行器 unknown 语义 |
| UI-16 | action `derives bounded external-data summaries from durable actions since the previous model Run`、`keeps same-millisecond summary boundaries and last-eight admission order after SQLite reopen`；HTTP 的下一次普通模型输入、fork/cold transcript/export；goalsSettled 为 0 | R3 / R4，最多八项/8000 Unicode 字符，明确外部数据，失败/unknown 不当成功；同毫秒真实 SQLite 重开稳定，模型 Run 阻断旧摘要 |
| UI-21 后台部分 | Runtime 旧绑定/伪造 invoke 不重定向、定义替换撤回；service 当前版本/digest/权限/缺失及其他会话源拒绝；HTTP 真实 global/session 禁用、安装禁用/撤权/漂移、冷 Host 失败、重启；F1 新增 get/document 与全局维护、reload、卸载、关闭的交错 | R2 / R3 / R4 / F1，仅后台调用绑定与当前事实验证。真实 reload/卸载的读取竞争和清理已覆盖，重装及其他全链路管理组合未穷举；Desktop 切换挂载撤销不在本次验证范围 |
| UI-22 后台部分 | service 原始 output 保留、无效 UI 不改成功；action readAction 原始 result、失败详情、export、重开/fork 的模型 transcript；HTTP 初始 Run 和后续摘要 | R3 / R4，原文字和持久动作结果可用，无 UI 等待；CLI/TUI 视觉呈现未做人工验收 |
| UI-25 后台部分 | test-only native-ui-logs 逐条检查审计键集合、身份、summary、duration、status 和取消 errorCode；HTTP 按实际字符串值检查结构化 daemon 日志、解析后的 Native 审计及公开实例响应，不受 JSON 对 Windows 路径、引号或控制字符的转义影响；service resolver 失败的安全 unavailable 响应 | R3 / R4 / R5 与下述 privacy 修正证据，检查 token、HTML、参数正文、安装配置路径；预期诊断精确匹配，未知 stderr 继续显示并导致失败。未改生产 audit，既有审计 cwd 是操作目录，不是安装路径；不宣称任意插件自行输出的日志都自动脱敏 |
| UI-26 后台部分 | HTTP `omits the feature for narrow HTTP assemblies without a full backend`、完整 daemon feature=1、真实禁用与 read-only；README、作者指南、Spec 明确 A2 / A3 范围 | R4 / R13 / R14 及文档检查；pluginUi:1 只说明后台可用，静态 inventory 不证明已打开 UI |

## 测试债清理与反向验证

Task 6 报告中的旧 projector 断言已按实际完成行为修正：`updateRun` 不仅提交 completed，还提交 `metadata.toolGeneration=[]` 清理进度。本次先复现原断言 RED（1 failed /25 skipped；唯一差异为这份 metadata），再在 R3 中验证 projector 26/26。生产 projector 没有修改。

Task 3 /5 /6 的预期审计、取消和 Native UI 拒绝诊断现在由 test-only utility 捕获并验证。审计如果多出完整参数字段、身份或 summary 不匹配，测试会失败；未知 stderr 不会被静默吞掉。原生产日志和审计格式保持不变。

同毫秒摘要回归先在原实现通过，再临时反转 Run 顺序证明 RED：预期八项 action ID，实际为空（1 failed /36 skipped）。真实 Native foreign 更新用例临时去掉 componentId 比较也 RED：旧 count=1 被错误写为 0（1 failed /40 skipped）。两项生产变异均原样撤回，最终 R4 全绿。没有为这些补充证据修改生产业务逻辑。

Task 7 审查指出旧 privacy 断言把裸安装路径与 JSON 字符串比较，Windows 转义后可能漏检，公开响应 root 和包含引号/控制字符的 HTML/参数也有同类问题。这是测试漏检，未发现生产泄露。现改为递归检查实际字符串值，并先解析 Native 审计 JSON。独立手写 Windows 安装路径、带引号/换行/制表符的 HTML 和参数分别注入结构化日志、Native 审计和公开响应；旧检测器 RED 为 3 failed /1 passed（错误地未抛错），修正后独立注入4/4、真实 HTTP12/12 均通过，见 R18。生产日志未修改。

## 最终分支审查的生命周期修复

修复基线为 `dda3daff`。P1 的根因是 `shutdown()` 等执行租约释放后才取消 Run，权限等待或 Native 调用因此无法自行结束。现在同步封住 operation gate 的新入口，先执行现有 `stopAndDrain()`，再等租约排空并关闭 Runtime。执行器的完整租约及 SQLite 原子结算未削弱。

P2 的根因是生产当前事实 resolver 直接准备 AgentPool，绕过维护入口和 daemon 就绪状态。现在从读取设置前至完成安装、文档验证与 Agent 准备都持有同一个既有 gate；准备前和异步解析完成后重验 ready。维护或关闭期间的 GET 实例沿用安全 unavailable 数据，文档沿用 503 / `plugin_ui_unavailable`；正常运行时已验证快照遇到 Host 注册失败仍可只读。没有增加锁、队列或伪造 Native 绑定。作者指南末尾过时的“只有静态接口”说明也已修正。

有效 RED：真实权限等待与 Native 调用中的关闭两项都在 3 秒断言时仍未完成，测试主动取消后才能清理；全局维护后 GET 错误返回 available；关闭期新 GET 返回可操作、文档返回 200，Runtime 准备中的新读取会继续等待；暂停 get/document 的设置读取时，实际 reload 与 uninstall 均返回 200，预期都是 409。初次管理夹具缺服务导致的 501，以及新测试误用客户端错误对象顶层 `code` 的断言不计为产品缺陷证据。

| 标记 | 命令（仍使用本文统一 pnpm 前缀；本地提权，无网络） | 实测结果 |
| --- | --- | --- |
| F1 | `--filter @vykor/server exec vitest run src/http/__test__/session-plugin-ui.test.ts` | 21 passed / 0 failed；其中新增 9 项真实生命周期交错。保留原 Host 失败只读、源投影、重试、恢复、导出和模型摘要回归 |
| F2 | `--filter @vykor/server exec vitest run` 后接下列 11 文件 | 170 passed / 0 failed；普通模型 Run、control、gate、AgentPool、UI service/action、startup 与真实插件管理回归 |
| F3 | F1 命令加 `-t 'closes the daemon during\|blocks real UI reads\|protects an in-flight\|drains UI'` | 自查增加旧 Native Host 的 `hostCount=0` / `registeredToolCount=0` 后，9 passed / 12 skipped / 0 failed |
| F4 | F1 命令加 `-t 'closes the daemon during'` | 在重开 SQLite、尚未运行 startup recovery 时核对 Run、工具 Part、源实例和权限已结算，2 passed / 19 skipped / 0 failed；副作用次数仍为 0 / 1，unknown 不重放 |
| F5 | `--filter @vykor/server check-types`；`check-docs`；`git diff --check`（最后一项直接 Git） | 类型检查 exit 0；文档检查 376 文件通过；无空白错误 |

F2 文件：`src/application/control/__test__/daemon-operation-gate.test.ts`、`src/application/control/__test__/daemon-control-service.test.ts`、`src/application/agent/__test__/agent-pool.test.ts`、`src/application/session/__test__/session-operation-runner.test.ts`、`src/application/session/__test__/run-control-service.test.ts`、`src/application/session/__test__/session-run-engine.test.ts`、`src/application/session/__test__/session-run-executor.test.ts`、`src/application/session/__test__/session-plugin-ui-service.test.ts`、`src/application/session/__test__/session-plugin-ui-action.test.ts`、`src/application/recovery/startup-recovery-service.test.ts`、`src/http/routes/plugin-lifecycle.test.ts`。

上述 F1 / F2 是修复者的实测证据。控制器还独立运行了 Core checked/workflow 45/45、实际 HTTP21 与 privacy4 共25/25、gate/control/run-control/run-engine37/37，以及提交后的权限等待/Native 调用关闭2/2；Server 类型检查 exit0。关闭2项是上述 HTTP 用例的重跑，不重复计数。这些通过结果不能覆盖下述复审新增的交错。

## 上一轮独立修复复审：遗留问题（下节已修复）

全分支审查范围为 `4bafd311..dda3daff`；一次性修复提交为 `4ae7f72d`；独立修复复审范围为 `dda3daff..4ae7f72d`。原 P1（UI 关闭相互等待）、P2（UI 读取绕过维护）和作者指南 Minor 均判为 ADDRESSED，但修复新增一个 Important：关闭的取消快照可能漏掉已经进入准入、仍在准备技能内容的普通输入。

实际交错：普通 `steer` 输入先持有运行入口并暂停在 `run-admission-work.ts` 的 `await materializeSteerInput`；关闭同步封入口，`stopAndDrain()` 只取消调用当时的 Run；技能读取随后完成，原输入没有再次检查关闭状态，继续创建并入队普通 Run；准入释放入口后，关闭直接清理 AgentPool 并返回，新 Run 却仍活动。`RunAdmissionService.prepareRunExecution` 同样没有停止检查。旧关闭顺序会在准入释放后捕获这个 Run，但直接恢复旧顺序又会重新触发 UI 权限等待死锁，不能作为修复。

复审者做了一个有界、无文件修改的诊断，使用真实 `DaemonOperationGate`、`DaemonControlService`、`SessionOperationRunner`、`RunAdmissionService`、`RunControlService`、`SessionRunEngine`，搭配内存记录和等待取消的注入执行器。当前顺序输出：

```json
{"shutdownReturned":true,"poolClosed":true,"executorStarted":true,"aborted":false,"activeRunId":"r"}
```

相同交错在旧顺序输出：

```json
{"oldOrder":true,"shutdownReturned":true,"poolClosed":true,"executorStarted":true,"aborted":true,"activeRunId":null}
```

这证明关闭返回时执行已进入且没有收到取消；没有调用真实模型，不把此诊断宣称为实际模型请求或 SQLite 持久悬空验证。控制器按源码交叉确认，接受该问题为影响既有普通运行的真实回归，不作为无害问题推迟。

下一步范围：阻止或安全结算关闭期间恢复的在途普通准入，并保证所有准入工作均取消、排空；保留立即取消已运行 UI 动作、完整执行保护和原子结果保存。新增真实普通输入技能准备与关闭交错回归，同时覆盖 UI 权限等待/Native 调用、普通关闭控制及异常路径。无需重做 UI 架构或提前实施 A3。

上一轮按 subagent-driven-development 的一次最终修复及一次复审上限收尾；当时没有第二轮修复，没有删除计划现场，也没有宣称最终验收通过。用户随后明确要求修复，并要求提高效率，按下节完成单点修复。

## 后续单点修复：关闭排空不遗漏晚入队任务

本次以 `2ed0e722` 为基线，控制器直接修复，不重新执行已完成的 A2 任务或多轮分支审查。生产代码仅改两处：

- `DaemonControlService.shutdown()` 保留立即封入口、取消活动 UI 的步骤；等原入口全部释放后，再扫描、取消并排空当时的任务，最后关闭 AgentPool。这包含技能准备完成后才入队的旧输入。
- `RunControlService.stopAndDrain()` 只合并正在执行的排空请求，完成或失败后清掉该 Promise；后续调用必须重新扫描，不能复用已经完成的旧取消快照。权限等待、Native 调用和结果保存期间的完整运行保护不变，没有新增锁或队列。

新增自动回归使用真实运行入口、会话准入、Run 控制、执行队列和 SQLite，暂停技能准备，让第一次取消扫描完成，再允许普通 Run 入队。断言清理 AgentPool 前已无活动 Run、执行收到取消、持久状态为 interrupted；关闭并重开 SQLite 后再次确认。执行器是等待取消的本地注入执行器，不调用实际模型。另一项用例验证最后一次排空失败仍清理运行环境并正确返回错误。

改生产代码前，聚焦命令 `--filter @vykor/server exec vitest run src/application/control/__test__/daemon-control-service.test.ts -t 'normal run admitted|cancellation after admission'` 得到 **2 failed /8 skipped**：清理运行环境时仍有活动任务，以及最后排空的失败被漏掉。随后做最小修复；所有下列 pnpm 命令仍使用本文统一前缀、现有本地依赖，无网络。

| 标记 | 命令（省略共同 pnpm 前缀） | 本次结果 |
| --- | --- | --- |
| G1 | `--filter @vykor/server exec vitest run src/application/control/__test__/daemon-control-service.test.ts src/application/control/__test__/daemon-operation-gate.test.ts src/application/session/__test__/run-control-service.test.ts src/application/session/__test__/run-admission-service.test.ts src/application/session/__test__/session-run-assembly.test.ts` | 5 files，60 passed /0 failed；包含新增真实关闭交错与错误清理 |
| G2 | `--filter @vykor/server exec vitest run src/http/__test__/session-plugin-ui.test.ts -t 'closes the daemon during|blocks real UI reads|protects an in-flight|drains UI'` | 9 passed /12 skipped /0 failed；真实 UI 权限等待、Native 调用、维护、reload/uninstall 和读取关闭交错 |
| G3 | `--filter @vykor/server check-types` | exit0 |

本次 69 个不同测试通过。控制器自查确认：第一阶段取消仍在等待运行入口之前；第二阶段仅在入口关闭且旧入口已释放后扫描，晚入队任务会被取消并等待；两阶段错误都汇总，运行环境清理仍执行；原运行检查和持久结算没有被替换。按用户要求只验证影响范围，没有重跑无关全仓测试或新一轮全分支独立审查。

## 尚未验收的范围

A2 已报告的原三项最终审查问题及普通 Run 关闭回归已修复并完成范围内回归；最后的单点修复由控制器自查，未另做独立全分支审查。完整 daemon 的 source projection、独立动作、当前事实读取、startup、export 和下次普通输入摘要均有真实消费者覆盖，不能据此宣称所有管理组合已穷举。

UI-17–UI-24 的 Desktop / SDK 部分没有实施或验收：本次浏览器构建是已有 VykorClient 的后台接口消费者，不是 iframe SDK。专用文档协议、隔离 frame / CSP / MessageChannel、mount 撤销、Desktop SSE 呈现、参考插件卡片/侧栏、焦点与键盘、宿主确认和真实 Electron 攻击夹具均不能标记通过。UI-25 任意插件日志、UI-26 完整首版交付也不由本次后台测试代替。

未运行无关全仓库测试、真实模型或人工 CLI/TUI/Electron 演练；不合并、不推送、不发布。
