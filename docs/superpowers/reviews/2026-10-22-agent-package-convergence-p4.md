# P4：Kernel、Node 和执行引擎收敛记录

> 状态：2026-10-22 完成 T07、T08。P0–P4 已实施，P5、P6 待实施。范围和后续任务见[实施计划](../plans/2026-10-21-agent-package-convergence.md)。P4 已提交为 63c46b00，未推送。

## 1. 职责与迁移位置

| 职责 | 唯一位置 | 边界 |
| --- | --- | --- |
| 消息、工具、事件、子任务、执行准备与只读集合 | agent-contracts 的 tools / events / children / execution / collections | 纯接口和数据，不引用本机配置、应用协议或 Node 服务；M15、M16、M33 |
| 生命周期、队列、输入回执、可靠事件、父子控制 | agent-runtime 的 src/kernel/，正式入口 /kernel | 只接收 Engine、已捕获工具、effects 和 release；M18 |
| 本机默认能力、配置、插件、MCP、记忆、应用目录 | agent-runtime 的 src/node/ | 创建具体服务并注入工具；DefaultNodeAgent.host 暴露宿主操作；M17、M19、M20 |
| Goal contribution 和两个 Goal 工具 | server 的 src/application/goals/ | Server 验证持久 Run 和 Goal 归属，再交给通用执行入口；M21 |
| 可信应用来源 | server 的 application/agent/tool-app-origin-projector.ts | 使用 Node 捕获的绑定与真实调用身份生成持久来源，不相信工具结果自报；M22 |
| 单次模型尝试、冻结请求、工具上下文 | core 的 engine/model-attempt-runner.ts、turn-context.ts、tool-execution-context.ts | QueryEngine 唯一持有可变历史和重试状态，工具继续走同一检查管道；M23 |
| 配置存储、输出环境变量和默认值 | host-config 的 request-configuration / schedules / tool-output-policy | Engine 只接收明确的数值策略；M31 |
| 上下文预算公开类型和算法 | contracts 与 core 的正式 /context-budget 入口 | prompts 不再借根入口引入整个 Engine；M32 |

M30 的 SDK、Server loader/pool/executor、CLI、声明、构建和 pack 同步切换。旧宿主源码路径和 Core 转发出口删除，没有保留第二套默认组装。

Core 中无调用方的 AppStateStore 一并删除，提前完成 M28 的这部分清理；这不代表 P6 已实施。跨包的 API/工具/Engine 集成测试迁到 Runtime 的 node/integration/，仍由默认测试命令覆盖。

## 2. 一次请求如何执行

Server loader 返回 HostedAgent，明确保存 agent 与 host；AgentPool 在同一条目中复用这对对象，检查代际一致。执行器经 host 解析配置和插件范围，调用 prepareRun 捕获当前工具，再将通用 preparation 和 contribution 交给 Kernel。

Kernel 发布可靠的 run.started 后完成本轮宿主登记，再交付 started 回执和调用 Provider。每回合冻结请求输入；每次物理模型尝试只负责本次流和汇总。重试、历史和成本仍由同一个 QueryEngine 持有。模型工具和独立工具都经过参数、权限、hook、超时及结果检查。

普通执行控制仍是 submitMessage、runMessage、runTool、history、compact、children、events 和 close。插件目录、配置更新、remember、诊断和 Workflow 通过 host 访问。没有宿主的 Kernel 调用方必须明确提供所需接口。

## 3. 创建、复用和关闭

| 资源 | 谁创建与复用 | 谁关闭 |
| --- | --- | --- |
| NodeRunCatalogue | 每棵 Node 根树创建实例；后代借用，同名工具或空工具集合也不跨根树共享 | 随根树释放；不使用进程全局反查表 |
| 本轮捕获与登记 | Node preparation 创建；Kernel 持有该次 release | 准备失败、执行终态或 close 都排空，重复释放只执行一次 |
| SDK 注入的执行环境 | 默认借用；ownsExecutionEnvironment=true 明确转交所有权 | 借用由调用方关闭；转交后由 Node 关闭一次，后代继续借用 |
| Server 获取的执行环境 | loader 获取后将所有权交给 Node | 初始化回滚和正常关闭共用一次性释放，不在获取前执行可能失败的元数据准备 |
| Team、Workflow 和本地执行能力 | 沿用 P2/P3 的实例目录与宿主接口 | 先收尾活动工作和子 Agent，再释放底层资源；保留错误汇总 |

附件 Read 通过 toolDecorators 装饰已经绑定宿主的默认工具，保留沙箱与输出日志能力。工具上下文不再携带 Settings、MCP manager、Skills、Terminal、Jobs 或 Schedule 等具体服务。

## 4. 授权和行为验收

- 子工具范围只从实际父绑定集合缩小；支持通配符、deny 优先以及 Bash/Shell 同名授权规则，不能补出父级不存在的工具。
- MCP 的已连接资源范围与已启用的认证配置范围分别捕获。未连接服务器仍可修复认证，但其他插件来源和 child 排除的服务器仍被拒绝。
- 应用固定授权验证本轮、原始工具身份、固定参数、安装修订和当前策略；硬 deny 优先。应用与模型共享普通执行管道。
- 来源投影要求本轮真实开始过的调用、成功结果和可信捕获绑定。伪造结果字段、其他 session、缺失绑定和失败调用均不能生成来源；投影重试可复用同一事实。
- 观察监听器抛错不影响执行；可靠终态写入完成后才交付 result。取消、已启动工具的结果、子 Agent 关闭、维护与后台 Workflow 的顺序继续保留。
- 同时验收不限回合数：默认值和 0 表示不限制；正数上限仍有效。冻结的子任务硬上限不会被配置刷新或 setMaxTurns 扩大。

独立复核发现的子工具通配符和离线 MCP 认证两项问题均已修复；复核的两个文件共 14 项测试通过。

主要回归入口：

- [Kernel 生命周期与子工具范围](../../../packages/agent-runtime/src/kernel/index.test.ts)
- [执行环境所有权](../../../packages/agent-runtime/src/node/runtime/execution-ownership.test.ts)
- [MCP 准备与认证范围](../../../packages/agent-runtime/src/node/runtime/prepare-run-tools.test.ts)
- [根树目录隔离](../../../packages/agent-runtime/src/node/capabilities/node-run-catalogue.test.ts)
- [可信来源投影](../../../packages/server/src/application/agent/__test__/tool-app-origin-projector.test.ts)
- [请求配置与回合上限](../../../packages/core/src/engine/request-configuration.test.ts)

## 5. 验证证据

先编码，再集中验证；有失败时只补验受影响范围。下表中的累计覆盖按已经实际执行的测试计数，过滤跳过不替换较早的执行结果，不把首轮失败描述为一次全绿。

| 范围 | 最终证据 |
| --- | --- |
| agent-contracts 全套 | 21 项通过 |
| Core 全套 | 34 个文件、422 项通过，包含重试、工具只执行一次、取消、steer、冻结请求和不限回合数 |
| Runtime 全套与修复补验 | 首轮 821 项中 806 通过、15 失败；修复后覆盖 16 个文件及真实 REPL 串行补验，累计 823 项均有通过结果，包含新增的 2 项 MCP 回归 |
| Server 全套与修复补验 | 首轮 1,838 项中 1,803 通过、35 失败；相关 8 文件 139 项、插件生命周期 7 项、HTTP 回放 1 项、Git/审查/预算 31 项补验全部通过，原失败均已覆盖 |
| tools 全套与修复补验 | 首轮 604 通过、2 失败、1 跳过；修正宿主测试夹具后相关 29 项通过，累计 606 通过、1 个 Windows 不适用用例跳过 |
| protocol、host-config、api 全套 | 分别 198、114、251 项通过 |
| workspace 类型检查 | 67/67 个任务通过，含 SDK 声明、Server、CLI、Desktop 和前端 |
| 正式构建 | Node、Kernel、Workflow 和声明构建通过；Kernel 构建为 208.5 KB，宿主源码和声明可达检查通过 |
| 打包安装消费者 | tarball 安装后 Native Tool 注册/调用、默认 TerminalOpen/JobCancel、Kernel root/child/close 均通过，命令退出 0 |
| 架构与旧入口检查 | 40 项边界反例通过；Client API 4 项、兼容入口与边界合计 49 项、clean-slate、历史界面引用检查通过 |
| 依赖与差异 | offline frozen-lockfile 安装、465 份 Markdown 文档检查及 git diff --check 通过 |

真实插件测试夹具现在排除示例目录的 node_modules，避免复制无关依赖导致超时。真实 Git 正确性测试显式使用较宽的测试预算，生产 2 秒捕获/5 秒收尾预算未改，专门的取消/预算/进程关闭 4 项测试仍通过。真实 REPL 的固定短轮询在并行负载下曾失败，串行复验通过；没有放宽该断言。Windows 的 PTY 辅助进程出现过 AttachConsole 诊断，Terminal 行为断言和 pack 命令均完成并退出 0。

汇总架构命令首轮在历史引用清单处失败：47 条记录因导入合并或行号漂移失配。逐条核对原文本后只更新位置和合并重复导入记录，721 条变为 719 条；没有放开目录或批准新的执行入口。对应检查重新执行通过，最终 pnpm check:architecture 聚合命令退出 0。

## 6. 阶段进度和后续边界

currentPhase 推进到 P4；P0–P4 到期例外为零。总例外从 P3 的 597 条降至 39 条，其中 P5 13 条、P6 26 条；旧 SessionStore 聚合调用仍为 104。仅删除实际完成迁移的关系，没有重建依赖白名单。

T07、T08 / M15–M23、M31–M33 和本阶段 M30 同步迁移完成，满足 A01–A04、B01–B05。ModelAttemptGate 本阶段只收敛通用接口；Goal 的模型尝试准入与记账仍按原投影路径运行，P5/T09 才统一切换。Server 用例接口继续收敛和兼容面清理分别留给 T10、P6。

SDK、职责边界和生命周期文档已同步；历史文档的源码链接改到实际新位置。未进行真实用户数据迁移、发布或部署。
