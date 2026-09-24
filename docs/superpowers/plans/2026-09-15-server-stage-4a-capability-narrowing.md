# Server 阶段 4A：简单 Application Service 能力收口实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（- [ ]）语法来跟踪进度。

**目标：** 把已有简单 Application Service 从完整 SessionStore/宽 context 收窄为实际使用的 capability，并建立 Route 禁止直连持久化的护栏。

**架构：** 不新建替代服务；复用 Project、Attachment、Channel、Retention、Event、Terminal、Job、Schedule 和 default services。每个构造参数只暴露该服务真实调用的方法，DaemonApplication 负责一次性接线。

**技术栈：** TypeScript、Vitest、SessionStore 领域入口、pnpm、现有 architecture-boundaries 脚本。

---

## 开工条件与边界

- 基于包含设计 commit bae19ba7 的最新 main。
- 不改变任何 Service 公共方法、HTTP/SSE、错误文本或调度行为。
- 不创建 BaseService、capability factory 或 Service Locator。
- Pick<SessionStore, ...> 可作为类型来源，但对象不得持有完整 Store。
- 每个服务先固定行为，再收窄 context；同一提交不顺手拆 Session/Run 主链路。

## 文件范围

主要修改：
- packages/server/src/application/events/application-event-service.ts
- packages/server/src/application/retention/application-retention-service.ts
- packages/server/src/application/channel/channel-application-service.ts
- packages/server/src/application/project-application-service.ts
- packages/server/src/application/attachment-resource/*
- packages/server/src/terminal/daemon-terminal-service.ts
- packages/server/src/jobs/daemon-job-service.ts
- packages/server/src/daemon/scheduled-task-service.ts
- packages/server/src/application/default-services/*
- packages/server/src/application/daemon-application.ts
- scripts/architecture-boundaries.mjs 及测试和 baseline
- docs/architecture-migration-status.md

### 任务 1：固定简单服务契约和当前依赖表

**文件：**
- 修改上述服务现有测试
- 创建 docs 内交付记录不需要新增生产文件

- [ ] **步骤 1：生成调用清单**

运行：rg -n "context\.store\.|this\.store\.|store:" packages/server/src/application packages/server/src/jobs packages/server/src/daemon packages/server/src/terminal -g "*.ts" -g "!*.test.ts"

对每个服务记录：读取方法、写方法、live runtime、事件发布和错误类型。

- [ ] **步骤 2：补 Characterization 测试**

Event 测 afterSeq/cursor/abort；Retention 测 policy/时间戳；Channel 测重复 delivery；Terminal/Job/Schedule 测 task 状态与关闭；default services 测依赖失败映射。新增断言必须在旧实现通过。

- [ ] **步骤 3：运行基线**

运行：pnpm --filter @vykor/server test -- src/application/events src/application/retention src/application/channel src/application/default-services src/jobs src/daemon src/terminal

预期：新增契约测试全绿。

- [ ] **步骤 4：提交护栏**

提交：git commit -m "test(server): lock simple application service contracts"

### 任务 2：收窄 Event、Retention、Project、Channel

**文件：**
- 修改四个服务及其测试
- 修改 daemon-application.ts 接线

- [ ] **步骤 1：先写类型契约测试**

用 satisfies 或构造 fixture 证明 Event 只需要 listEvents/latestEventSeq，Retention 只需要 applyRetention/listRetentionAudits，Project 只用 ProjectOperations，Channel 只用 getInput/getSession 和 channel operations。

- [ ] **步骤 2：确认完整 Store fixture 不再是必需**

把测试 fake 改成只有所需方法；先让 TypeScript 因现 context 过宽失败。

- [ ] **步骤 3：定义就地 capability**

示例：

    export interface ApplicationEventStore {
      listEvents(options?: ListEventsOptions): SessionEventRecord[];
      latestEventSeq(): number;
    }

接口放在使用它的文件，不建 common capabilities.ts。

- [ ] **步骤 4：修改构造和 Daemon 接线**

传 store.conversations 或对象字面量；若方法 this 绑定敏感，使用箭头包装。Channel 分别传 channels 和 sessionQueries，不传 store。

- [ ] **步骤 5：验证并提交**

运行：pnpm --filter @vykor/server test -- src/application/events src/application/retention src/application/channel src/application/__test__/project-application-service.test.ts
运行：pnpm --filter @vykor/server check-types
提交：git commit -m "refactor(server): narrow simple application capabilities"

### 任务 3：收窄 Terminal、Job、Schedule、Background Shell

**文件：**
- 修改 terminal/daemon-terminal-service.ts
- 修改 jobs/daemon-job-service.ts
- 修改 daemon/scheduled-task-service.ts
- 修改 application/session/background-shell-service.ts
- 修改对应测试和 Daemon 接线

- [ ] **步骤 1：建立四张 capability 表**

把 Session 查询、Task 持久化、Schedule 持久化、live process/terminal 操作分栏。一个 capability 不得同时含 schedule 与 terminal 方法。

- [ ] **步骤 2：用最小 fake 写失败的构造测试**

测试 fixture 只提供实际方法。现 context 若要求完整 Store，类型检查应失败，作为红灯。

- [ ] **步骤 3：收窄接口**

Task capability 包含 get/list/reserve/transition/update；Session capability 只含 get/list；Schedule capability 使用 store.schedules；live runtime 保持原依赖。

- [ ] **步骤 4：验证状态和 close**

运行对应四组测试，断言 pending/running/terminal、重复 request、abort、close 顺序不变。

- [ ] **步骤 5：提交**

提交：git commit -m "refactor(server): narrow task and terminal capabilities"

### 任务 4：收窄 Attachment、AgentPool 和 default services

**文件：**
- 修改 application/attachment-resource、attachment-tools、agent/agent-pool.ts
- 修改 application/default-services 中仍持宽 context 的文件
- 修改 Daemon 接线和测试

- [ ] **步骤 1：区分数据与工具依赖**

Attachment asset 查询走 store.attachments；Session reference 查询走 conversations；blob/read tool 走 AttachmentApplicationService。AgentPool 只需要 Session/listMessages/listParts 查询，不得更新 durable 状态。

- [ ] **步骤 2：写最小 fixture 测试**

构造对象不提供 Store 其他方法；测试 AgentPool acquire/release 和 attachment authorization 行为。

- [ ] **步骤 3：替换宽 context**

每个 default service 只接收 settings/auth/plugin/skill 的真实依赖。不要创建一个新的 DefaultServicesContext 把所有依赖重新打包。

- [ ] **步骤 4：验证**

运行：pnpm --filter @vykor/server test -- src/application/attachment-resource src/application/attachment-tools src/application/agent src/application/default-services

- [ ] **步骤 5：提交**

提交：git commit -m "refactor(server): narrow attachment and agent query capabilities"

### 任务 5：Route 和 capability 架构护栏

**文件：**
- 修改 scripts/architecture-boundaries.mjs
- 修改 scripts/architecture-boundaries.test.mjs
- 按条件修改 architecture-baseline.json
- 修改 docs/architecture-migration-status.md

- [ ] **步骤 1：写失败的 fixture 测试**

临时 Route 导入 SessionStore、sessions repository、conversation repository、run repository，断言 checker 报错。临时 Application Service 导入 DaemonApplication，Runtime 导入 http/routes，也必须报错。

- [ ] **步骤 2：运行红灯**

运行：node --test scripts/architecture-boundaries.test.mjs

预期：新 fixture 未被识别而失败。

- [ ] **步骤 3：实现文本级最窄规则**

复用现 checker，不引入 AST 依赖。兼容 default-node-application 创建 Store 的入口明确白名单，不把 Route 加白名单。

- [ ] **步骤 4：计算真实基线**

运行 checker --write-baseline，仅保留下降值。记录宽 Store context 数和 context.store.* 数，不得上调。

- [ ] **步骤 5：最终验证**

运行：
pnpm --filter @vykor/server test
pnpm --filter @vykor/server check-types
pnpm --filter @vykor/services test
node --test scripts/architecture-boundaries.test.mjs
pnpm check:architecture
node scripts/check-docs.mjs
git diff --check

- [ ] **步骤 6：更新状态和提交**

只标记 4A 完成、4B–4F 未开始，记录真实测试和指标。
提交：git commit -m "chore: close server capability narrowing stage"

## 审核重点

确认没有新空服务；旧行为未变；Route 不直连 Store/Repository；每个 context 确实变窄；没有用 any 或对象扩展运算符偷偷传完整 Store；baseline 只下降。
