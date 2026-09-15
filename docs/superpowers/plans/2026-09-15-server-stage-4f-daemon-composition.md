# Server 阶段 4F：DaemonApplication 组合根收缩实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（- [ ]）语法来跟踪进度。

**目标：** 把 Scheduled Task 执行、输入/插件装配和服务构造细节移出 DaemonApplication，使它只负责组合、启动、ready、close 和兼容公开属性。

**架构：** 使用少量纯 assembly function 或职责明确的现有 Service，不为每个 new 创建 builder。DaemonApplication 仍实现 DurableAgentApplication，公开属性和生命周期行为不变。

**技术栈：** TypeScript、Vitest、现有 Application/Runtime Services、pnpm、架构检查。

---

## 最终允许职责

DaemonApplication 可以保留：
- options、store、owner lease/heartbeat；
- 各公开 Service 的 readonly 引用；
- startupRecovery Promise；
- readyState、closePromise；
- 构造/ready/close；
- 极薄 trace/log 适配。

必须移出：
- Scheduled Task 完整执行 callback；
- Agent 输入物化、插件/技能发现长流程；
- context usage live assembler 的业务逻辑；
- attachment tool 细节；
- recovery 具体步骤；
- projection mapping；
- Session/Run 业务判断。

### 任务 1：固定 Daemon 生命周期与公开表面

- [ ] **步骤 1：列公开属性和构造副作用**

记录 DurableAgentApplication 所有属性、ready 状态、owner heartbeat、startup recovery、schedule start、close 顺序。

- [ ] **步骤 2：补 characterization**

测试构造不提前 ready、recovery 成功/失败、重复 ready、重复 close、ownsStore true/false、一个/多个 close failure 聚合、heartbeat release。

- [ ] **步骤 3：运行旧实现并提交**

运行 daemon application/default-node/http readiness/shutdown 测试。
提交：git commit -m "test(server): lock daemon composition lifecycle"

### 任务 2：提取 Scheduled Task 执行服务

**文件：**
- 创建 application/schedule/scheduled-task-executor.ts/test.ts 或放入现有 daemon/scheduled-task-service 邻近目录，按已有所有权选择一个，不建重复 scheduler。

- [ ] **步骤 1：从 Daemon 构造提取分支表**

覆盖 worktree 创建/复用、git repo 检查、chat destination、Session create/reuse、model、network permission、admission、await、结果、清理空 worktree。

- [ ] **步骤 2：写服务红灯**

输入 ScheduledTaskRecord 和 execution context，输出现有 Scheduled Run 结果。失败路径保持 error 和清理行为。

- [ ] **步骤 3：实现最小服务**

复用 Project/Session/Admission capability 与 WorktreeManager。Scheduler 只负责计时和 claim，Executor 执行一次 task。

- [ ] **步骤 4：Daemon 改为注入 executor callback**

构造区域删除长函数，只保留 execute: task => scheduledExecutor.execute(task)。

- [ ] **步骤 5：验证提交**

提交：git commit -m "refactor(server): extract scheduled task execution"

### 任务 3：提取 Session 运行装配依赖

- [ ] **步骤 1：识别三类 callback**

context usage assembler、plugin/skill discovery、attachment/tool creation。分别判断已有 Service 能否承接；能承接就加窄方法，不新建 coordinator。

- [ ] **步骤 2：写当前行为测试**

覆盖无 AgentPool、settings missing、warm/acquire、skill catalog missing、plugin capability unavailable、attachment authorization/size。

- [ ] **步骤 3：提取纯 factory/function**

纯依赖装配使用函数；需要状态和生命周期才使用 class。函数参数必须是命名 capability，不接 DaemonApplication。

- [ ] **步骤 4：替换 Daemon 长 callback**

Daemon 只绑定返回函数；业务判断位于对应 Session/Plugin/Attachment service。

- [ ] **步骤 5：验证提交**

提交：git commit -m "refactor(server): extract session runtime assembly"

### 任务 4：提取 Application/Runtime assembly

- [ ] **步骤 1：建立依赖拓扑测试**

用 fake options 构造 assembly，断言 Query/Command/Admission/Control/Executor/Projection/Recovery 使用同一实例，避免重复 service 和重复 listener。

- [ ] **步骤 2：实现少量 assembly function**

按顺序返回 durableCapabilities、runtimeServices、applicationServices。不要建立 fluent builder 或容器。

- [ ] **步骤 3：处理循环依赖**

优先通过回调晚绑定或窄接口，不用 any、不用 mutable service locator。若必须两阶段绑定，在一个 assembly 文件显式完成并加测试。

- [ ] **步骤 4：Daemon 构造只赋值**

构造函数调用 assembly 并把结果赋给公开 readonly 字段；不含业务 if/loop，生命周期 if 除外。

- [ ] **步骤 5：验证提交**

提交：git commit -m "refactor(server): extract daemon service assembly"

### 任务 5：收缩 close 与 ready

- [ ] **步骤 1：写关闭顺序失败测试**

operation gate → run drain → schedules/background/terminal/agent → settlement → heartbeat/lease → store。每一步可抛错，后续仍尝试；一个错误原样抛，多个聚合。

- [ ] **步骤 2：提取 close helper（仅确有收益）**

若 closeWork 仍清晰可保留在 Daemon；不要为了行数创建 LifecycleManager。只删除已经迁出的业务收尾。

- [ ] **步骤 3：ready 只 await recovery**

readyState 转换、失败缓存、closing/closed 错误保持原文。

- [ ] **步骤 4：验证重复调用**

两次 close 返回同一 Promise；ready/close 竞态与现有语义一致；ownsStore=false 不关闭外部 Store。

- [ ] **步骤 5：提交**

提交：git commit -m "refactor(server): reduce daemon lifecycle to composition"

### 任务 6：阶段 4 总验收

- [ ] **步骤 1：生产搜索**

运行：
rg -n "context\.store\.|store: SessionStore" packages/server/src/application packages/server/src/runtime -g "*.ts" -g "!*.test.ts"
rg -n "SessionStore|Repository" packages/server/src/http/routes -g "*.ts"
rg -n "DaemonApplication" packages/server/src/application packages/server/src/runtime -g "*.ts" -g "!daemon-application.ts"

所有保留结果逐条写明兼容原因。

- [ ] **步骤 2：指标**

记录 DaemonApplication、SessionApplicationService、SessionRunEngine 行数；完整 Store context 和 context.store.* 数；architecture baseline。不得为达数字继续无关拆分。

- [ ] **步骤 3：全验证**

运行：
pnpm --filter @openharness/server test
pnpm --filter @openharness/server check-types
pnpm --filter @openharness/services test
pnpm check-types
node --test scripts/architecture-boundaries.test.mjs
pnpm check:architecture
node scripts/check-docs.mjs
git diff --check

全仓 pnpm test 可补充；WSL/node-pty 已知并发问题按既定规则单列。

- [ ] **步骤 4：两轮审核**

规格审核后质量审核，Critical/Important 修复并复审。重点做 restart、shutdown、SSE 和 queue/interrupt 集成检查。

- [ ] **步骤 5：更新文档**

architecture-migration-status 标阶段 0–4 完成、阶段 5 未开始；总体规格记录真实 commit、测试数量、指标和偏离。

- [ ] **步骤 6：提交**

提交：git commit -m "chore: complete server application runtime reorganization"

## 审核重点

Daemon 只组合和生命周期；公开接口不变；没有 builder/container 过度设计；一个服务只构造一次；循环依赖没有用 any 掩盖；close/recovery 错误语义完整。
