# P3：Agent 定义、团队和 Workflow 宿主收敛记录

> 状态：当前阶段实施与验证记录。对应 T04–T06 / M07–M14；P0–P3 已完成，P4–P6 未启动。范围和后续任务见[实施计划](../plans/2026-10-21-agent-package-convergence.md)。

日期：2026-10-22。本轮保留原有文件记录、SQLite schema、HTTP/SSE 和模型工具结果格式，没有迁移真实用户文件。

## 1. 职责和代码位置

| 职责 | 当前位置 | 实际边界 |
| --- | --- | --- |
| 唯一 AgentDefinition、内置角色、纯文件内容解析 | coordinator `src/definitions/`，正式入口 `/definitions` | 接收显式内容；不读用户目录或本机配置，不注册进程全局插件角色 |
| 用户 Agent 文件发现和覆盖顺序 | agent-runtime `src/node/definitions.ts` | Node 读取目录，按 builtin → user → plugin 得到目录；实际 Run 使用已经捕获的可用角色集合 |
| TeamRegistry、TeamPort | coordinator `src/teams/`，正式入口 `/teams` | 普通实例；每棵根树创建一个，递归 child 借用；同名团队不跨根树共享 |
| Workflow 计划、调度、输入解析、快照解码和 Repository 接口 | coordinator `src/workflow/`，正式入口 `/workflow` | 不做文件 I/O、不找默认 Agent/Team、不保存活动运行目录 |
| 文件仓库与活动 Workflow | agent-runtime `src/node/workflow/{file-workflow-run-repository,workflow-host}.ts` | Host 实例拥有后台 Promise、取消传播、worker 收尾和终态写入；文件仓库只处理已有格式的记录 |
| Workflow worker、动作、结果展示 | agent-runtime `src/node/workflow/{agent-workflow-runner,workflow-actions,workflow-presentation}.ts` | Node 安装 child / 外部执行后端和 Git 汇总；工具只校验输入、传入本轮信息并调用一次 invoke |
| child 等待结果转换及有界等待 | agent-runtime `src/node/children/child-task-adapter.ts` | 唯一实现；删除 tools 中旧实现和临时副本 |
| 本地 Job 聚合 | agent-runtime `src/node/jobs/local-agent-job-host.ts` | 使用同一执行 owner、child 目录和绑定后的 Workflow jobs 视图；不再另管一份 Workflow 状态 |
| 默认工具选择、来源标记和宿主接线 | agent-runtime `src/node/tools/{default-tool-registry,tool-ports}.ts` | Node 创建配置、Skills、MCP、Channel 等实现，再注入工具工厂 |
| 模型工具 | tools 各目录及 `src/ports/` | Agent、Team、Workflow、Jobs、Terminal、Schedule、Config、Skill、MCP、Feishu 接收显式接口；缺少接口时不偷用 context 中的宿主或创建默认实现 |
| daemon Workflow 仓库及应用生命周期 | Server `application/workflow/`、`application/daemon-application.ts` | SQLite 仓库留在 Server；应用创建唯一 Host，loader、Jobs、恢复和关闭共享它 |

正式 Node Workflow 入口为 `@vykor/agent-runtime/node/workflow`，导出 WorkflowHost、FileWorkflowRunRepository 和 worker 工厂。CLI 已切换到这个入口。coordinator 旧定义加载文件、team 单例、workflow/store，以及 tools 的默认 registry、LocalAgentJobHost、Workflow runner / presentation / input 和 child-task 旧路径全部删除，没有转发别名。

tools 不再依赖 auth、mcp、skills、services 实现包；包清单和锁文件同步删除这四项依赖。原来依赖工具 execute identity 的来源检查继续使用原定义，调用注入对象的方法保留接收者。

## 2. 谁创建、复用和关闭

| 场景 | 创建与复用 | 关闭责任 |
| --- | --- | --- |
| standalone Node 根 Agent | 创建自己的 TeamRegistry 和 WorkflowHostDirectory；同仓库复用一个 Host，child 借用目录 | 每个 Agent 关闭自己的 session 视图；根 Agent 最后关闭目录中的私有 Host |
| daemon | DaemonApplication 创建一个 SQLite WorkflowHost；Agent loader、DaemonJobService 和启动恢复共用 | Agent 回收只关闭自己的 session 视图；应用关闭所有活动 Workflow，再释放执行 owner 和存储 |
| 注入现有 Host | Node 根树借用调用方的 Host，绑定当前 session | 根树不关闭借用的 Host；调用方关闭它 |
| 独立 Workflow CLI | 命令入口显式创建文件仓库和 Host，停止后端由参数传入 | finally 等待 Host 和本次创建的执行资源关闭 |

Agent.close 的具体顺序现在是：打断当前 Run → 等待维护结束 → 取消并等待本 session 的后台 Workflow → 关闭子 Agent → 释放其余能力 → 排空可靠事件 → 关闭 Runtime。各阶段失败仍继续后续清理，最后统一返回错误。先收尾 Workflow 能避免子 Agent 已被移除后才取消，导致取消记录被误写为普通失败。

Team 的两个真实根实例回归覆盖同名团队、不同成员、child 共享本树，以及删除 A 不影响 B。Workflow 的内存、文件、SQLite 适配共用 `tests/workflow/lifecycle-scenarios.ts`，覆盖运行、恢复、历史、时间线、取消和关闭隔离。

## 3. 必须保留的行为

- 返回后台 jobId 前同步保存初始快照并完成 claim；Job ID 仍为 `workflow:<runId>`，仓库里的 runId 保持原值。
- 绑定视图校验 session；读、恢复、历史和时间线不能越过 owner。关闭一个视图不取消其他 session 的 Workflow。
- `scope.signal` 代表拥有后台工作的 Run；请求 `signal` 只代表本次调用/等待。请求结束或等待取消不会自动杀掉已经返回的后台工作。
- 明确取消、父 Run 取消和 Host.close 都等待 worker 收尾和终态保存。快照读取或保存失败会传播错误，同时排空已经启动的 worker；不会假报完成。
- 执行和恢复都按本轮捕获的角色集合验证任务。即使集合为空，也不能回退到宿主全部插件角色。requiredMcpServers 和父子工具范围继续传递。
- `persist: false` 使用内存仓库，不写文件；文件版 JSON/NDJSON、SQLite generation 和既有启动恢复规则保持原样。

文件 claim 仍只记录进程信息，不能提供跨进程互斥。SQLite 的 generation 也不等于完整的跨进程执行排他保证。本轮没有新增文件锁、claim 格式或数据表；独立 CLI 不会接管另一个进程内的活动 Host。

## 4. 架构检查与留给 P4 的边界

currentPhase 已推进到 P3。过渡例外从 P2 的 619 条降至 **597 条**：P4 558、P5 13、P6 26；P0–P3 到期例外为零。没有扩大目标依赖矩阵，也没有重新批量生成白名单。

删除已消失的关系，并对文件拆分、工厂改名和类型符号组变化逐项更新记录。P4/T07 尚未迁移 ToolContext、ToolResult、ChildController 等执行类型，因此新工具接口和对应测试仍有精确登记的 core 类型引用。core 的角色绑定改为引用唯一 AgentDefinition；其类型依赖和 Kernel 的可达声明继续精确登记到 P4，未复制第二份角色类型来绕过问题。

WorkflowInvocation 在 P3 显式携带可信的本轮 children 和 definitions，保留 child 权限与插件角色隔离；这些字段来自执行上下文，模型不能构造 Host、Repository 或授权绑定。通用上下文和 Kernel 的完整切换仍按 T07 原子实施，本阶段没有提前声称完成。

新增规则禁止 tools 引入 auth/mcp/skills/services/agent-runtime 实现、coordinator 定义和调度目录使用 Node 内置能力，以及恢复已删除的宿主路径。检查器对重复类型分支使用同一次遍历的 visited 集合，避免类型交叉引用造成指数级扫描；18 层交叉引用及循环导出反例仍能识别全部禁止来源。

旧 SessionStore 聚合调用检查结果为 104，低于既有上限 109；共享工作区的其他修改也可能影响这个计数，不将全部下降归因于 P3。

## 5. 验证证据

按要求先完成编码，再集中验证；修复只补验受影响范围。测试去重后共 **1,112 项通过，1 项跳过**。

| 范围 | 结果 |
| --- | --- |
| Runtime / Node / SDK / 插件隔离 / Team | 229 项通过；首轮 211 项，关闭补验新增覆盖 18 项；包含真实 PTY、Jobs、Workflow 和真实 child 关闭 |
| tools 全套 | 667 项通过、1 项跳过；跳过项是 Windows 不适用的 Unix 文件 mode 保留测试 |
| coordinator 全套 | 98 项通过 |
| Server Workflow 仓库、Host、Jobs、继续执行竞争、persona 设置 | 46 项通过 |
| CLI Workflow 与 debug | 15 项通过 |
| core MCP 工具授权 | 17 项通过 |
| plugins Agent 文件组件 | 1 项通过 |
| 架构检查反例 | 39 项通过 |
| 全 workspace 类型检查 | 67/67 个任务通过；最后再检查 Runtime、Server、CLI 类型 |
| Runtime 构建 | Node、Kernel、Workflow bundle 和声明构建通过；tools build 按现有空构建脚本退出 0，其代码由类型检查覆盖 |
| 编译后正式入口 | 从 CLI 使用 ESM 导入正式 Node Workflow 子入口，完成持久运行、读取 `workflow:` Job ID 和关闭 |
| 依赖、文档及差异检查 | 离线 frozen-lockfile 安装、文档检查、git diff --check 通过 |

主要命令如下，Vitest 使用 `--maxWorkers=2` 控制本机负载：

```powershell
pnpm --filter @vykor/coordinator test
pnpm --filter @vykor/tools exec vitest run --maxWorkers=2
pnpm --filter @vykor/agent-runtime exec vitest run src/node src/sdk.test.ts src/default-runtime.test.ts src/inherited-tool-policy.test.ts src/capability-resolution.test.ts src/run-capability-mcp.test.ts src/multi-plugin-execution.test.ts src/plugin-child-followup.test.ts src/team-root-isolation.test.ts --maxWorkers=2
pnpm --filter @vykor/agent-runtime exec vitest run src/run-capability-lifecycle.test.ts src/execution-ownership.test.ts src/kernel.test.ts src/node/workflow/workflow-host.test.ts src/node/workflow/agent-workflow-close.test.ts --maxWorkers=2
pnpm --filter @vykor/agent-runtime exec vitest run src/node/workflow/agent-workflow-runner.test.ts src/node/workflow/agent-workflow-close.test.ts --maxWorkers=2
pnpm --filter @vykor/server exec vitest run src/application/workflow src/jobs/daemon-job-service.test.ts src/jobs/daemon-job-continue-race.test.ts src/personalization-settings.test.ts --maxWorkers=2
pnpm --filter @rzx/ohs exec vitest run src/commands/workflow.test.ts src/commands/debug.test.ts --maxWorkers=2
pnpm --filter @vykor/core exec vitest run src/engine/mcp-proxy-authorization.test.ts --maxWorkers=2
pnpm --filter @vykor/plugins exec vitest run src/components/agents.test.ts --maxWorkers=2
pnpm exec turbo check-types --concurrency=1
pnpm --filter @vykor/agent-runtime --filter @vykor/server --filter @rzx/ohs check-types
pnpm --filter @vykor/tools build
pnpm --filter @vykor/agent-runtime build
node --test scripts/architecture-boundaries.test.mjs
node scripts/architecture-boundaries.mjs
pnpm install --offline --frozen-lockfile
node scripts/check-docs.mjs
git diff --check
```

没有重复运行整个 workspace 的测试套件、完整 Server/core 测试或 P2 的 WSL 集成套件；本轮也未执行完整发布 pack 验收和 UI 预览。没有提交、发布或部署。后续从 P4/T07 开始，待用户授权。
