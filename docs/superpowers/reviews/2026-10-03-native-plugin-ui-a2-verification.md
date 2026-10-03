# Native Plugin UI A2 验收证据

> 状态：当前 A2 后台实现与回归记录；任务 1–6 已经任务审查，任务 7 审查与独立全分支审查待控制器完成。不是 Desktop 首版发布验收。
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
| UI-21 后台部分 | Runtime 旧绑定/伪造 invoke 不重定向、定义替换撤回；service 当前版本/digest/权限/缺失及其他会话源拒绝；HTTP 真实 global/session 禁用、安装禁用/撤权/漂移、冷 Host 失败、重启 | R2 / R3 / R4，仅后台调用绑定与当前事实验证。实际卸载、重装、reload 后 UI 实例的全链路管理组合未另做专项演练；Desktop 切换挂载撤销不在本次验证范围 |
| UI-22 后台部分 | service 原始 output 保留、无效 UI 不改成功；action readAction 原始 result、失败详情、export、重开/fork 的模型 transcript；HTTP 初始 Run 和后续摘要 | R3 / R4，原文字和持久动作结果可用，无 UI 等待；CLI/TUI 视觉呈现未做人工验收 |
| UI-25 后台部分 | test-only native-ui-logs 逐条检查审计键集合、身份、summary、duration、status 和取消 errorCode；HTTP 正常操作断言 daemon/Native 日志不含 token、HTML、参数正文、安装配置路径；service resolver 失败的安全 unavailable 响应 | R3 / R4 / R5，预期诊断精确匹配，未知 stderr 继续显示并导致失败；未改生产 audit，既有审计 cwd 是操作目录，不是安装路径。没有宣称任意插件自行输出的日志都自动脱敏 |
| UI-26 后台部分 | HTTP `omits the feature for narrow HTTP assemblies without a full backend`、完整 daemon feature=1、真实禁用与 read-only；README、作者指南、Spec 明确 A2 / A3 范围 | R4 / R13 / R14 及文档检查；pluginUi:1 只说明后台可用，静态 inventory 不证明已打开 UI |

## 测试债清理与反向验证

Task 6 报告中的旧 projector 断言已按实际完成行为修正：`updateRun` 不仅提交 completed，还提交 `metadata.toolGeneration=[]` 清理进度。本次先复现原断言 RED（1 failed /25 skipped；唯一差异为这份 metadata），再在 R3 中验证 projector 26/26。生产 projector 没有修改。

Task 3 /5 /6 的预期审计、取消和 Native UI 拒绝诊断现在由 test-only utility 捕获并验证。审计如果多出完整参数字段、身份或 summary 不匹配，测试会失败；未知 stderr 不会被静默吞掉。原生产日志和审计格式保持不变。

同毫秒摘要回归先在原实现通过，再临时反转 Run 顺序证明 RED：预期八项 action ID，实际为空（1 failed /36 skipped）。真实 Native foreign 更新用例临时去掉 componentId 比较也 RED：旧 count=1 被错误写为 0（1 failed /40 skipped）。两项生产变异均原样撤回，最终 R4 全绿。没有为这些补充证据修改生产业务逻辑。

## 尚未验收的范围

A2 尚待任务 7 独立审查与全分支独立审查。未发现需要补接的 A2 后台生产入口；完整 daemon 的 source projection、独立动作、当前事实读取、startup、export 和下次普通输入摘要均由真实消费者覆盖。

UI-17–UI-24 的 Desktop / SDK 部分没有实施或验收：本次浏览器构建是已有 VykorClient 的后台接口消费者，不是 iframe SDK。专用文档协议、隔离 frame / CSP / MessageChannel、mount 撤销、Desktop SSE 呈现、参考插件卡片/侧栏、焦点与键盘、宿主确认和真实 Electron 攻击夹具均不能标记通过。UI-25 任意插件日志、UI-26 完整首版交付也不由本次后台测试代替。

未运行无关全仓库测试、真实模型或人工 CLI/TUI/Electron 演练；不合并、不推送、不发布。
