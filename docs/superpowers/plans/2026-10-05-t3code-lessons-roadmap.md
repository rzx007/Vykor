# T3 Code 借鉴方向与分阶段改进路线图

> 状态：当前路线图。最近更新于 2026-10-06；阶段一至七已完成，阶段八正在验证，后续阶段按用户授权连续推进。

## 目标与范围

将 T3 Code 中值得借鉴的六个运行可靠性方向和七个行为能力方向转成可分阶段验收的工作，提升智能体的好用、可靠和任务完成能力。先准确定位失败，再改善运行状态、修改结果和数据传输，随后验证长任务连续性、提示词、计划、委派和辅助执行。

本文件是总路线图，不是已经完成的实现记录，也不是可以直接执行的逐文件代码计划。每阶段开始时，先核对现有能力和测试，只对确认的缺口形成最小实施计划；已经满足要求的部分记录证据并跳过，不重复建设。

调研来源为本地 `D:/code/personal-project/t3code`，版本 `1a3f7ad5085606463a602bd756ca9c04d106fffe`。下文 T3 源码路径均相对此仓库根目录，行号对应这个版本，不代表其他版本。

T3 主要控制 Codex、Claude Code、OpenCode 等完整编码代理，主要文件工具和 Shell 执行由这些代理负责；我们直接接模型 API，自己负责模型循环和工具执行。两者职责不同，不能据此判断我们的问题主要来自模型，也不能把 T3 的体验全部归功于它自己的文件工具。

T3 也保留底层代理的基础提示词，例如 Claude 接入在 `claude_code` preset 后追加应用说明。它自己的提示词较短，不代表底层代理使用的完整提示词较短，更不证明短提示词必然更聪明。对应源码：`apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts:908`。

## 全程遵守的边界

- 保留权限检查、文件冲突保护、原子写入，以及复用内容时重新检查目标和权限的规则。不要用猜测替代覆盖意图或真实文件状态。
- 不重写整套运行系统，不迁移到 Effect，不建立第二套事件总线、状态容器、能力管理或诊断数据库。
- 诊断数据不作为运行状态的来源。常规日志继续禁止 prompt、模型正文、完整工具参数、结果正文和凭据，遵守现有[排障文档](../../observability.md)。
- 暂不做供应商耗时对比，不判断首次生成慢来自上游还是程序。可以记录现有阶段耗时，但不能据此作未经验证的归因。
- 不自动接入外部编码代理，不新增自动撤销，不改变自动评审默认关闭的设置。
- UI 尽量复用已有组件，保持单行工具摘要、按需详情和低视觉噪声；样式由用户检查，不主动启动预览或截图。
- 只修改当前阶段涉及的文件，保留其他任务的未提交改动。测试按风险和范围执行，不反复跑完整套件。
- 普通任务不默认创建持久目标，不强制规划、加载 Skill 或委派子代理；清楚、可逆的小任务直接完成。
- 提示词修改必须对应可重复的行为缺口，先确认现有规则和接线，不因单次失败永久增加一条全局指令。
- 静态检查、脚本回放与真实模型行为分别记录。回放通过不代表模型变聪明，失败早停造成的低耗时或低 token 数不算效率改善。

## 六个借鉴方向

### 方向一 失败现场能够重放

**T3 的做法：** 诊断记录有过滤、大小上限和保留期限；回放测试替换外部代理连接，真实运行适配器、状态存储和业务处理。它不是无限保存所有原始帧或每个 token。

**对我们的要求：** 区分上游输入、解析结果、执行前文件状态和最终结果。典型失败应能转成脱敏样本，重复验证同一条链路，避免只增加一个局部测试就宣布整条流程已经修复。

**已有基础：** [真实 SDK 到引擎的重试测试](../../../packages/api/src/providers/upstream-retry.integration.test.ts)、[工具执行链路测试](../../../packages/core/src/engine/tool-workflow.integration.test.ts)、现有 Run Inspector 和关联 ID。优先扩展这些入口，不另建通用回放平台。

T3 证据：`apps/server/src/provider/Layers/EventNdjsonLogger.ts:195`；`docs/orchestration-v2/testing-strategy.md:7`。

### 方向二 请求接受与运行结束分别处理

**T3 的做法：** 状态、命令处理结果和待执行动作先提交，外部工作再执行。代理结束与快照、差异刷新分别记录；重启时，失去执行现场的运行和审批会明确结束或过期。

**对我们的要求：** 请求被接受不代表动作完成；发出取消不代表已经停止；模型输出结束不代表功能验收通过。审批结果、工具结果和 Run 终态应各有一个明确的更新入口，迟到事件不得把终态改回运行中。

**已有基础：** [运行生命周期契约](../../agent-lifecycle-contract.md)、[持久运行数据模型](../../durable-execution-data-model.md)、[权限流程](../../permission-flow.md)。先核对这些保证在完整链路中是否成立，不预先引入新的持久任务队列。

T3 证据：`apps/server/src/orchestration-v2/EventSink.ts:518`；`apps/server/src/orchestration-v2/RunFinalizationService.ts:56`；`apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts:292`。

### 方向三 列表摘要与完整内容分开

**T3 的做法：** 聊天订阅主要传状态、文件身份和统计；完整命令输出、文件差异有独立读取入口。断线补数据有数量和大小限制，超过预算时改发当前快照。

**对我们的要求：** 模型需要的内容、用户展开的详情、列表需要的摘要分别控制。生成进度不得携带文件正文；普通状态更新不应重复发送整份工具输入输出；详情裁剪必须明确告知，不能显示成完整结果。

**已有基础：** 参数生成期间的工具展示、轻量路径摘要和 `shell-output://` 输出引用。先验证是否仍有大正文多次复制或广播，不重做 loading，也不增加重复的进度文字。

T3 证据：`apps/server/src/orchestration-v2/WireProjection.ts:71`；`apps/server/src/orchestration-v2/ThreadStream.ts:70`。

### 方向四 展示工作目录的实际改动

**T3 的做法：** 使用临时 Git 索引和隐藏引用记录工作目录快照，不直接往用户当前分支添加普通提交。文件变化不只依赖代理报告的工具调用。

**对我们的要求：** 用户能看到本轮实际修改的文件，包括 Shell 造成的变化；任务前已有修改和其他任务的变化不能直接算作本轮成果。无法安全归因时明确说明，不能回退到把整个脏工作区都算进去。

**已有基础：** [按风险自动评审](../../auto-review.md)已经包含 Run 前基线和变更归因，源码位于 [git-run-change-inspector.ts](../../../packages/server/src/application/auto-review/git-run-change-inspector.ts)。本方向先评估复用此能力，不新建另一套 Git 采集器，也不以开启模型自动评审为前提。

先提供只读结果，不实现自动回退。文件回退、模型上下文回退和共享目录的并发变化不是一个问题，不能合并成一个无条件的撤销按钮。

T3 证据：`apps/server/src/vcs/GitVcsDriver.ts:803`；`apps/server/src/orchestration-v2/CommandPolicy.ts:306`。

### 方向五 协议差异集中处理

**T3 的做法：** 在适配入口声明代理是否支持中断、运行中追加指令、排队消息、恢复和回退，业务层依据实际能力工作。

**对我们的要求：** 保持现有职责，不让同一种错误在各层分别修一次：

| 入口 | 负责什么 | 不负责什么 |
| --- | --- | --- |
| API 适配层 | 协议解析、DSML、流式数据转换 | 猜测文件覆盖意图、决定任务完成 |
| 引擎 | 调用顺序、纠错策略、权限协调、运行结束条件 | 文件匹配算法、UI 文案和布局 |
| 文件与 Shell 工具 | 文件匹配、冲突检查、实际读写与命令结果 | 服务端状态同步、模型协议修复 |
| 服务端 | 保存运行事实、发布事件、审批与恢复 | 重复解析原始模型输出 |
| 客户端 | 同步和展示服务端状态、读取详情 | 修复工具参数、重放写操作、推断任务成功 |

已有 Run 能力视图负责工具、插件等可见性，不应再造一份。模型协议特性与工具授权不是同一种能力，也不能为了统一名称强行塞进同一个对象。

T3 证据：`packages/contracts/src/orchestrationV2.ts:188`；`apps/server/src/orchestration-v2/ProviderAdapter.ts:486`。

### 方向六 连接恢复与任务恢复分开

**T3 的做法：** 连接重试有共享负责人；缓存可供离线阅读，但不代表实时状态。连接恢复不会自动重放修改请求，修改操作按自己的重复提交规则处理。

**对我们的要求：** 断线后可以补齐记录，但不能因此再次执行 Write、Shell 或审批回复。连接状态、数据同步状态、任务运行状态分别表示，不能都归入一个“重连中”。

**已有基础：** [客户端同步流程](../../client-sync-flow.md)和现有 snapshot、SSE、cursor。复用当前同步入口，不为桌面页面新增独立的重连循环，不迁移传输协议。

T3 证据：`docs/internals/connection-runtime.md:9`。

## 七个行为能力方向

### 行为方向一 提示词符合当轮真实能力

T3 按当轮实际挂载的浏览器和设备工具决定是否注入对应说明，避免提示模型使用根本拿不到的工具。我们已有后台 Shell、子代理的条件提示，应继续核对实际送给模型的工具、提示和权限说明是否一致，而不是再造提示词管理系统。

检查重点是工具禁用、能力变化后提示是否过期，以及基础提示、Skill、工具描述和错误反馈是否重复或冲突。需要审批的工具不等于不存在；权限拒绝也不能变成换工具绕过的理由。

已有入口：[默认 Runtime](../../../packages/agent-runtime/src/default-runtime.ts)、[提示词片段组装](../../../packages/prompts/src/prompt-segments-assembly.ts)。T3 证据：`apps/server/src/provider/CodexDeveloperInstructions.ts:25`。

### 行为方向二 长任务保留关键事实并能补读来源

T3 当前交接代码优先选择最新请求、最近回答和原始要求；选中消息保留原文，遗漏内容留下来源和补读入口。它明确区分历史上下文与新请求，不声称恢复了外部代理的全部内部状态。

我们已有压缩、会话记忆和任务字段。默认压缩附加内容主要是近期文件和工具统计，当前服务端补充入口主要提供附件与会话记忆；这不足以直接证明普通任务的用户纠正、当前计划和未完成事项都能稳定保留，也不等于已经确认会丢失任务。

优先验证压缩后能否继续遵守最新要求、不做事项、已完成证据、未完成工作和等待句柄。只有样本证明缺口后，才通过现有压缩与上下文入口补充有限事实；必要时在原有访问权限内补读消息，不默认读取其他会话，不建立大型记忆系统。

已有入口：[压缩服务](../../../packages/core/src/engine/compact-service.ts)、[服务端上下文接线](../../../packages/server/src/application/daemon-application.ts)、[压缩上下文提供者](../../../packages/agent-runtime/src/compact-context.ts)。T3 证据：`apps/server/src/orchestration-v2/ContextHandoffBudget.ts:227`。

### 行为方向三 计划模式与权限及待办进度分开

T3 将只讨论方案的 Plan Mode 与步骤进度区分，实现请求可以关联来源计划并检查其有效性。计划被采用不代表其中要求已经实现或通过验收。

我们现有 [EnterPlanMode 和 ExitPlanMode](../../../packages/tools/src/mode/plan-mode.ts)修改权限配置，[TodoWrite](../../../packages/tools/src/meta/todo-write.ts)向 Markdown 文件追加条目。需要分别验证当前运行的模式是否一致、不同会话是否互相影响、计划是否能在恢复后继续引用；不能仅凭工具回复或文件存在判断这些保证成立。

复杂任务需要区分当前方案、执行进度和完成证据；小任务不强制生成计划。先核对已有会话模式、目标与上下文机制，只补真实缺口，不新增通用计划平台。

T3 证据：`apps/server/src/provider/CodexDeveloperInstructions.ts:49`；`apps/server/src/orchestration-v2/Orchestrator.ts:4610`。

### 行为方向四 子代理有清楚的交接和返回要求

T3 的应用级委派使用明确任务正文，不自动复制全部父会话。新一轮审核需要带上原始要求、之前的发现与回应、未解决的意见，并单独跟踪任务。

我们已有 [Agent 工具的 scope 和 expectedResult](../../../packages/tools/src/agent/agent-tools.ts)。重点不是增加代理数量，而是任务是否包含目标、负责范围、必要事实、结果格式和证明方式。审核应返回可定位的证据，父代理结合当前文件状态复核；不能把多代理意见一致当作完成证明。

简单任务直接完成，明确要求委派时遵守用户意图。独立审核需要哪些上下文就提供哪些，不为了“独立”省略必要事实，也不默认复制整段历史或扩大权限。

T3 证据：`apps/server/src/mcp/toolkits/orchestrator/tools.ts:59`；`apps/server/src/provider/T3OrchestrationInstructions.ts:11`。

### 行为方向五 稳定的执行与等待由程序管理

T3 在释放代理前管理工作目录准备和需要等待的初始化脚本；PR 监控由程序检查实际变化，发生有意义的变化时才唤醒模型，而不是让模型反复查询。

我们应先核对已有 Jobs、调度和环境能力。只有实际任务中重复出现、规则稳定且处于用户授权范围内的准备或等待工作，才值得收进程序。保持同一任务句柄，变化通知只说明事实，不自动授权修改、合并或部署。

T3 证据：`apps/server/src/orchestration-v2/ThreadLaunchService.ts:499`；`apps/server/src/mcp/toolkits/pullRequests/tools.ts:290`。

### 行为方向六 辅助生成使用有限输入和固定输出

T3 的提交信息、分支名等辅助任务使用专门提示词和结构化输出。Claude 的这类调用关闭执行工具，再校验结果，不顺带进入完整项目执行流程。

标题、分类、短摘要等辅助任务优先复用现有受限调用：只给必要内容，不加载无关 Skill、MCP 和项目执行能力。缺少资料时不能编造；输出不符合要求就报告失败或作有界纠正，不启动另一轮完整代理工作。

T3 证据：`apps/server/src/textGeneration/ClaudeTextGeneration.ts:199`、`:298`；`apps/server/src/textGeneration/TextGenerationPrompts.ts:39`。

### 行为方向七 用实际行为验证方法和提示词

T3 的规划提示强调先查能发现的事实，只把影响结果的决定交给用户。借鉴这一原则，不照搬强制多轮提问；环境事实通过读取和检查确定，低影响细节可以合理假设，高影响决策再询问。

复用[跨任务行为评测基线](../../agent-behavior-evaluation.md)，关注是否采纳用户纠正、证据足够时是否停止、失败后是否按新证据调整、压缩后是否继续、局部完成时是否诚实汇报。我们已有基础提示和目标完成审查，不能把再次写入相同规则当作能力提升。

行为评测贯穿后续阶段，不排到全部修改之后才开始。真实模型对比需要明确授权，固定同一模型、服务通道、场景、权限和预算；它验证候选改动，不比较供应商，不运行未经授权的真实项目操作。

T3 证据：`apps/server/src/provider/CodexDeveloperInstructions.ts:81`。行为验收依据为我们自己的任务要求和样本，不是 T3 的性能证明。

## 分阶段实施

方向五的职责边界贯穿所有阶段；阶段五只核对前四阶段并收敛有证据的重复逻辑，阶段六至九继续遵守同样边界。原有五阶段顺序保留，新行为方向接在其后；行为方向七贯穿阶段六至九。

| 顺序 | 覆盖方向 | 本阶段交付 | 状态 |
| --- | --- | --- | --- |
| 阶段一 | 一 | 可定位失败的证据与少量真实链路回放 | 已完成离线验证 |
| 阶段二 | 二、六 | 取消、审批、终态和断线恢复的一致性 | 已完成验证与修复 |
| 阶段三 | 四 | 复用现有归因能力的只读改动结果 | 已完成验证与修复 |
| 阶段四 | 三 | 摘要与详情的数据边界、必要的传输优化 | 已完成验证与修复 |
| 阶段五 | 五 | 跨层职责核对与重复逻辑收敛 | 已完成核对与修复 |
| 阶段六 | 行为二、七 | 普通长任务连续性的基线与必要补强 | 已完成离线验证与补强 |
| 阶段七 | 行为一、七 | 提示词、实际工具和权限说明的一致性 | 已完成离线验证与修复 |
| 阶段八 | 行为三、四、七 | 计划与模式的可靠性、有边界的任务交接 | 实施中 |
| 阶段九 | 行为五、六、七 | 已证实重复工作的程序管理与受限辅助生成 | 未开始 |

### 阶段一 失败证据与链路回放

**工作入口：** 现有 API 适配器、引擎集成测试、文件工具，以及服务端 Run Inspector。先列清现有证据能回答什么，再补缺口。

- [x] 为典型失败建立小型脱敏样本，记录协议、关联 ID、必要文件初始状态和预期结果；不将真实会话的破坏性 Shell 命令作为测试执行。
- [x] 覆盖 DSML 工具输出被识别后继续运行、Edit 错误原文不写入、断流或取消时未完成参数不执行三类场景；已有覆盖直接复用。
- [x] 对涉及展示的场景，检查生成占位与正式工具记录正确交接，废弃调用没有残留的运行状态。
- [x] 同一份样本能够串起解析前后、工具执行和最终文件内容；无法证明错误来自哪层时，明确记录证据不足。

**验收：** 仅替换网络输入和必要外部边界；API 适配、引擎和文件逻辑真实运行，文件操作限于临时目录。样本能稳定重放，错误改动不会偷偷写入，修复后预期行为得到证明。不能只靠更改某层返回值使测试通过。

**限制：** 常规日志只增加必要结构、长度、摘要和阶段耗时，不写正文。如必须采集完整流，另行说明内容范围并取得明确授权，使用有界的私有诊断文件，不默认常驻采集。

**本阶段结果：** 2026-10-06 在基线 `cf9888bd` 上完成。只新增一份协议到文件的回放测试，并补强既有 Edit 的反馈断言；没有修改生产逻辑、提示词、UI 或常规日志，没有安装新依赖。新增测试已经过独立只读审查，无未解决发现。

| 覆盖链路 | 证据与结果 |
| --- | --- |
| 原始 SSE、DSML、参数生成 | API 的恢复、生成进度与真实 SDK 重试测试，59 项通过 |
| 真实 SDK 到临时文件 | 新增 [file-protocol-replay.integration.test.ts](../../../packages/tools/src/file/__test__/file-protocol-replay.integration.test.ts)，5 项通过：包装 DSML Write 后继续；上游错误和缺少完成标记不落盘废弃调用；native 与 DSML 在部分 JSON 参数生成期间取消不写入、不重试 |
| Edit 拒绝与短参数修正 | 既有 [file-workflow.integration.test.ts](../../../packages/tools/src/file/__test__/file-workflow.integration.test.ts)，7 项通过；补强断言确认匹配失败时当前原文实际进入下一轮模型请求，而不只保存在某个中间结果中 |
| 引擎执行边界 | core 的工具执行链路测试，33 项通过；核对生成、调用与取消的顺序 |
| SDK 事件映射 | agent-runtime 的流事件映射测试，5 项通过 |
| 服务端状态与诊断 | server 的工具进度投影 20 项、Run Inspector 10 项通过；核对占位交接、废弃状态清除、默认脱敏和未知执行结果诊断 |

合计 9 份测试文件、139 项唯一测试通过；重复运行没有重复计数。协议到文件的新增回放使用真实 SDK、API 适配器、引擎、权限检查和文件工具，只替换 HTTP 输入并关闭 hooks（自动回调）。网络替身按帧交付并响应取消，文件写入仅发生在临时目录。

复跑命令，在仓库根目录执行：

```powershell
pnpm --filter @vykor/tools exec vitest run src/file/__test__/file-protocol-replay.integration.test.ts src/file/__test__/file-workflow.integration.test.ts
pnpm --filter @vykor/api exec vitest run src/providers/upstream-retry.integration.test.ts src/providers/dsml-tool-call-recovery.test.ts src/providers/tool-generation-progress.test.ts
pnpm --filter @vykor/core exec vitest run src/engine/tool-workflow.integration.test.ts
pnpm --filter @vykor/agent-runtime exec vitest run src/stream-event-mapping.test.ts
pnpm --filter @vykor/server exec vitest run src/application/agent/__test__/tool-progress-projection.test.ts
pnpm --filter @vykor/server exec vitest run src/application/control/__test__/run-inspector.test.ts
```

**保留限制：** 新增 SSE 样本是对应既有故障形态的合成数据，不是最近真实会话的原始上游响应。界面状态依靠事件映射、投影和客户端状态测试验证，没有运行完整桌面界面。DSML 的 `arguments` 包装仍可执行，但不保证提供路径摘要；路径是可选展示信息，不影响上述写入与取消验收。本轮没有新增完整流采集，不能凭这些样本判断真实模型成功率、供应商问题或首次生成耗时。

### 阶段二 运行状态与恢复一致性

**工作入口：** 现有运行生命周期、权限服务、投影更新和客户端同步入口，使用阶段一的失败样本验证。

- [x] 核对取消发生在参数生成、等待审批、工具执行三个时点的结果，区分未开始、已结束和执行结果未知。
- [x] 验证审批重复回复、已处理请求的旧按钮、重启后的未决请求，以及迟到事件不能复活终态。
- [x] 验证内容复用仍重新检查当前权限和文件状态，不把之前的批准作为新的批准。
- [x] 验证断线补数据不会重新执行文件修改、命令或审批；缓存状态不显示成当前运行事实。

**验收：** 每种场景都有可核对的最终状态；工具执行次数与真实动作一致；重复提交返回既有结果或明确冲突；断线恢复只恢复观察，不恢复未经确认的动作。代理结束、后续整理和验收结果不互相冒充。

**限制：** 不为了重复提交引入“外部命令必定只执行一次”的虚假保证。执行现场丢失而无法确认结果时，报告未知，不自动重跑，也不全面重写持久运行系统。

**本阶段结果：** 2026-10-06 完成。确认并修复两处共享客户端边界，生产改动仅涉及现有同步控制器和快照归并函数；审批规则、文件工具、模型请求、UI 布局和传输协议没有改变。新增 11 项回归，独立只读审查通过，无未解决发现。

1. [SessionSyncController](../../../packages/client/src/state/session-sync-controller.ts)原来只在首次连接时读取快照，重连只续接事件流。现将首次连接和重连的快照读取收在同一个步骤，覆盖正常断流、异常断流、重取失败、取消及旧快照；Frontend 使用此控制器，Desktop 使用的 `syncEvents` 原本已经重取快照。
2. [applySessionSnapshot](../../../packages/client/src/state/reducer.ts)原来只比较上一次快照游标，不能保护之后收到的 live 事件。合成反例“快照 7 → Run 完成事件 9 → 旧运行中快照 8”在原实现中会复活 Run。现复用已保留的同会话事件判断旧快照，不在不同同步入口分别加判断；其他会话的较大事件编号不会阻止当前会话接收有效快照。

以上两处都先用测试确认失败，再修改代码并验证通过。旧快照反例证明客户端处理边界，不代表已经在真实线上会话中观察到这个返回顺序。

审批沿用已有安全语义：已经决定或过期的请求再次回复会返回明确冲突，不改写原决定、不再次发布审批事件。Desktop 的 pending 操作保护避免同一请求重复点击；到达的 SSE 确认会收束操作，不把后到的请求错误显示成新的失败。

| 验证范围 | 当前结果 |
| --- | --- |
| 共享同步、快照归并 | client 3 份测试、37 项通过，包含 8 项新增回归 |
| 审批与工具状态 | server 审批 controller 4 项、broker 16 项、工具进度投影 20 项通过，包含 3 项新增重复与迟到回复回归 |
| 重启与终态 | services 3 份测试按名称过滤，6 项通过，未执行的用例不计入通过数 |
| 执行中取消及未开始分类 | core 工具链路 33 项通过 |
| 生成取消与内容复用 | tools 2 份文件链路测试、12 项通过，复用阶段一的实际文件回放 |
| Run 和模型尝试收尾 | agent-runtime 11 项通过 |
| Desktop 审批与输入动作 | 48 项逻辑测试通过，没有启动窗口或做样式验证 |

合计 14 份测试文件、187 项唯一测试通过；重复运行不重复计数，也不与阶段一重复累计。`@vykor/client` 的 `tsc --noEmit` 通过，文档链接和差异空白检查通过。没有新增依赖、新状态字段、事件总线或恢复框架。

复跑命令，在仓库根目录执行：

```powershell
pnpm --filter @vykor/client exec vitest run src/state/__test__/reducer.test.ts src/state/__test__/session-sync-controller.test.ts src/state/__test__/sync.test.ts
pnpm --filter @vykor/server exec vitest run src/permissions/__test__/permission-controller.test.ts src/permissions/__test__/permission-broker.test.ts src/application/agent/__test__/tool-progress-projection.test.ts
pnpm --filter @vykor/services exec vitest run src/session-runtime/__test__/store.test.ts src/runs/run-repository.test.ts src/conversations/conversation-transactions.test.ts -t 'expires permission requests whose live resolver|terminal guards|preserves returned facts and distinguishes queued calls during restart|interrupts active runs, marks unknown tool outcomes'
pnpm --filter @vykor/core exec vitest run src/engine/tool-workflow.integration.test.ts
pnpm --filter @vykor/tools exec vitest run src/file/__test__/file-protocol-replay.integration.test.ts src/file/__test__/file-workflow.integration.test.ts
pnpm --filter @vykor/agent-runtime exec vitest run src/framework-agent-run-retry.test.ts
pnpm --filter @vykor/desktop exec vitest run src/renderer/src/stores/desktop-session/prompt-actions.test.ts
pnpm --filter @vykor/client run check-types
```

**保留限制：** 快照保护检查 `eventsBySeq` 已保留的同会话事件，纯文字 delta 不在该表中，不据此承诺保留所有逐字更新。恢复只重新读取状态，不重放修改；真实模型效果、浏览器错误、完整 GUI 和线上网络故障不在本轮验证范围内。

### 阶段三 实际改动结果

**工作入口：** 现有 Git 变更归因服务和 Run metadata；先确定已有结果能否直接用于只读展示。

- [x] 复用已有 Run 前基线和归因规则，不依赖模型自动评审开关，也不默认开启模型评审。
- [x] 使用临时仓库验证直接文件工具和安全的 Shell 修改均能反映在实际改动结果中。
- [x] 覆盖已有脏文件重叠、无法确定的并发变化、非 Git 目录和采集失败；无法证明归属时展示原因。
- [x] 在已有结果区域提供简洁摘要和按需差异；命令执行完成、评审通过、测试通过分别说明，不互相替代。

**验收：** 结果来自工作目录事实，不来自 Write/Edit 次数或模型总结；不误领已有改动，不泄露敏感文件；没有可用结果时不展示“无改动”或“验证通过”。

**限制：** 首阶段只读，不写 Git 隐藏引用、不改变暂存区、不自动提交、不增加撤销操作。需要快照或回退时单独确定范围和风险。

**本阶段结果：** 2026-10-06 完成，独立审查发现的三项主要问题和一项路径问题均修正并复审通过。新增的 [SessionWorkspaceChanges](../../../packages/server/src/application/session/session-workspace-changes.ts)只负责观察：Run 开始前采集基线，结束后复用既有 Git 比较结果，保存到既有 Run metadata。可选模型评审复用同一份事实，关闭时不调用模型。摘要最多保存 128 个文件、每个路径 1024 字符，不保存 patch 或文件正文。

复用已有文件汇总与评审面板展示“运行期间变更”。保存的仓库根路径和统计不被当前 Git 覆盖；点击明确查看**当前工作区差异**，不是历史快照。无法确认归属时显示不可用原因，不冒充无改动。仓库外文件和无法确定基准目录的相对路径保留原工具事实。

| 验证范围 | 证据 |
| --- | --- |
| 基础观察、原有评审、metadata 与界面 | 初版 169 项定向测试通过；修正后按受影响范围验证，没有重复执行整组 |
| 读取限制 | 4 个 Native 受限/未知反例由实际启动 Git 读取改为 0 次调用；关闭和开启可选评审都不回退读取 |
| 超时、取消、输出超限 | 4 个真实进程/会话队列用例通过；3 个实际 Git 正常、敏感路径和取消用例通过，等待整树进程关闭，无晚写和目录锁 |
| 最终接线、路径与类型 | 最终观察链路 8 项、构造证据 1 项；UI/路径 29 项通过，最后路径小修另跑 21 项通过；server/renderer TypeScript 与限定差异检查通过 |

Git 命令仍使用参数数组，不经 Shell；可执行过滤器、外部 diff、textconv、fsmonitor 和可选索引写入均关闭。开始采集预算为 2 秒，结束采集为 5 秒，到期发起终止，再等待实际进程树关闭；本机 Windows 清理约 0.7–1.1 秒，不能说精确在 2/5 秒内结束。进程终止复用现有能力，没有增加后台观察系统。

复跑新增边界：

```powershell
pnpm --filter @vykor/server exec vitest run src/application/session/__test__/session-workspace-changes-budget.test.ts
pnpm --filter @vykor/server exec vitest run src/application/session/__test__/session-workspace-changes.test.ts -t 'observes real Write|never calls host Git|remembers a second root|captures dirty files'
pnpm --filter @vykor/desktop exec vitest run src/shared/workspace-open-path.test.ts
```

**保留限制：** 只为实际默认 Native Agent 且明确关闭 sandbox 的构造保存宿主 Git 读取证据；受限、未知、自定义及 WSL 环境不采集，尚未实现完整的受限 Git 读取。期间变化不证明外部编辑作者；已知并发、脏文件重叠、重启失去基线、慢仓库或错误会明确不可用。关闭过滤器可能改变特殊仓库统计，不保证 LFS/自定义过滤器语义。相对工具路径可能与仓库摘要重复；当前差异可能后来改变或消失。真实进程在 Windows 验证，未宣称 Linux/macOS 实机或真实模型行为验证。

### 阶段四 摘要与详情的数据边界

**工作入口：** 工具进度事件、服务端投影和订阅、客户端工具列表与详情读取。

- [x] 用长文件内容和长 Shell 输出检查普通状态更新的负载，定位实际存在的大正文重复复制或广播。
- [x] 保留现有生成期工具展示和输出引用；列表只读取必要摘要，完整内容通过已有详情或资源读取入口获取。
- [x] 验证展开详情、重连、历史分页和被裁剪结果的提示，不因裁剪丢掉失败状态或必要的错误上下文。
- [x] 比较同一固定样本改动前后的订阅数据量和重复发送次数；只优化能够测到的瓶颈。

**验收：** 普通进度和状态更新不重复携带整份文件正文或完整命令输出；用户仍能按需查看允许读取的详情；明确区分完整、裁剪和不可用结果。UI 不增加重复状态文案或新的高频动画。

**限制：** 不用 UI 的裁剪预算限制模型所需的信息，不创建第二套输出存储，不在未证实渲染瓶颈时重写整个聊天列表。

**本阶段结果：** 2026-10-06 完成，独立审查的四项问题修正并复审通过。新增 [HTTP 摘要投影](../../../packages/server/src/http/part-wire-view.ts)，桌面通过 `partView=summary` 选择摘要；快照、parts 分页、事件列表、SSE live/replay 和 transcript replacement 共用此规则。默认 SDK、原存储和模型历史不裁剪。展开时按 session/message/part 三个身份读取原记录，仅补正文，不覆盖当前状态、审批或插件事实。

真实链路使用同一组 ASCII 样本：Write 正文 110,000 字符，Edit 新旧字符串各 90,000 字符，失败 Shell 文本 120,000 字符；每工具三次记录更新，共九次。下表是 UTF-8 JSON 数据量，不包含传输头或 SSE framing。

| 读取边界 | 完整视图 bytes | 摘要视图 bytes |
| --- | ---: | ---: |
| 快照 | 412,478 | 3,074 |
| 历史 parts，limit=3 | 411,844 | 2,440 |
| 事件重放 | 1,117,753 | 9,059 |
| 九次普通工具更新 | 1,116,807 | 8,113 |

原普通更新中的各段完整正文出现 2–3 次，摘要中均为 0；模型历史重建仍各有一份原文。工具 input/output 超过 4,096 JSON bytes 时标记为预览；缺失和真实空参数分别表示不可用与完整。未知工具也检查正文大小。保留短诊断、最多八个 Shell 引用，Shell 自带说明另有 1,024 UTF-8 bytes 总预算。

长 ApplyPatch 的文件身份由工具成功执行后的已有变更提供，不在 UI 重解析补丁；最多 32 条、2 KB 身份信息，保留总数与裁剪标记，过长路径不伪装成完整路径，预览不推算行数。专用展示同样保持事实：长 Agent 结果保留有效且有界的任务身份 JSON，图片保留合法比例；插件正文与图片失败详情展开时复用同一补读逻辑。同毫秒完成/失败、旧请求晚返回、换身份和关闭后返回均有直接回归。

验证包括 server 四文件 36 项、client 同步 7 项、protocol 序列化 9 项及桌面详情/订阅/变更结果分组；审查修正后另跑 64 项桌面与 5 项服务器检查，存在重复，不累加为唯一测试总数。server/client、desktop node/web 类型检查通过，必要修正后重查受影响类型。实际工具 → 投影 → HTTP 摘要 → 无 Git 文件列表也通过。没有为 SSE 测试更改持久化与广播的原职责。

```powershell
pnpm --filter @vykor/server exec vitest run src/http/__test__/session-part-summary.test.ts src/http/part-wire-view.test.ts
pnpm --filter @vykor/desktop exec vitest run src/renderer/src/components/desktop/conversation-page/message/assistant-message.tool-details.test.tsx src/renderer/src/components/desktop/conversation-page/plugin-ui/plugin-ui-card.test.tsx src/renderer/src/components/desktop/conversation-page/message/image-generation-message.test.tsx
pnpm --filter @vykor/desktop exec vitest run src/main/features/session/tool-summary-files.test.ts
```

**保留限制：** 只对确认的工具 input/output 投影，不通用裁剪普通文本、审批、任务或外部 metadata；默认完整 API、旧事件存储及服务端读取/复制成本仍保留。完整详情仍可能很大，读取失败会明确提示且不重跑工具。只证明固定样本的字节数与正文重复改善，不承诺模型生成速度、启动延迟或 GUI 性能变化；未启动真实浏览器或桌面预览。

### 阶段五 职责核对与逻辑收敛

**工作入口：** 前四阶段实际修改的调用链，不扩大为全仓库重构。

- [x] 按“输入从哪里来、谁保存状态、谁执行动作、谁返回结果”核对各入口，保证同一种协议修复或重试只有一个负责位置。
- [x] 删除已被真实链路测试证明多余的转换和恢复分支；必要的权限、文件冲突及资源限制不当作重复代码删除。
- [x] 新增能力判断优先复用现有声明，只有明确调用者确实需要时才新增字段；不根据代理名称向多个模块添加分支。
- [x] 核对旧调用、正式工具与生成占位的关系，以及服务端与客户端状态字段的一致性。

**验收：** 能用一条清楚的调用链解释典型成功、失败、取消和恢复；没有第二个状态负责人；删除分支后相关样本仍通过；不能以新增通用框架替代几个具体问题。

**限制：** 接入原生编码代理是一项独立产品与架构选择，不属于此阶段。没有明确需求，不增加多代理适配框架。

**本阶段结果：** 2026-10-06 完成，六文件限定差异经独立审查通过。核对的流程为 API 提供解析与生成进度 → engine 准备和校验实际调用 → tools 执行 → server 保存事实 → HTTP 生成展示副本 → client 同步 → 展开时只补正文。审批、执行取消、文件冲突和诊断保持各自原负责人；没有找到需要合并成一个大模块的理由。

修正了三个可复现的边界问题：

- Git 返回的根目录和 `-z` 文件名原本被再次转换，可能指向另一目录或文件；删除多余转换，根目录仅去掉 Git 追加的一个 LF，不剥掉合法路径空格。
- `a[1].txt` 被 Git 默认 pathspec 当作模式，可能混入 baseline 已脏的 `a1.txt`。在唯一执行入口使用原生 `--literal-pathspecs`，不新增匹配器；权限、敏感检查、配置程序禁用、取消和只读保证不变。
- 正式 start 先保存原参数，执行准备才按真实声明解包；长包装 Edit 能执行，摘要却丢文件身份。展示投影现在仅保留已知文件工具单字段包装的短上下文和原形状，执行解包仍只有 engine 负责，原模型输入不改。

Git 定向检查先后 20 项、16 项通过，两个组有重叠，不合并成唯一数；HTTP/摘要 7 项和真实 QueryEngine → Edit → 投影 → HTTP → 文件列表 1 项通过，server 与 desktop node 类型检查通过。固定阶段四样本重新测量仍为九次更新 1,116,807 → 8,113 bytes、快照 412,478 → 3,074，模型原文保持。没有重跑旧完整分组或删除导出的兼容同步入口。

**保留限制：** 实际 Git 在 Windows 验证，POSIX 字面反斜杠和尾空格采用执行器输入边界测试；没有宣称其他系统实机验证。真实 Edit fixture 使用实际 QueryEngine 和工具，Framework 事件映射为源码核对，不冒称完整 daemon 运行。核对只覆盖前四阶段相关入口，不代表全仓库无问题。

### 阶段六 普通长任务连续性

**工作入口：** 现有行为评测、压缩服务、会话记忆与附件目录。先记录当前版本表现，再决定是否修改上下文接线或压缩提示。

- [x] 复用行为评测结构建立固定样本：先完成 A，再由用户纠正 B 的要求并说明不做 C；压缩后继续完成 B，不能重做 A 或执行 C。
- [x] 覆盖存在待完成任务句柄、摘要遗漏原始要求、已完成证据与未完成事项混在同一历史中的情况。
- [x] 核对现有字段、传入数据和实际模型请求；若样本证明缺口，优先通过现有入口保留有限事实或提供原记录的受控补读。
- [x] 记录样本版本、代码版本、失败分类和结果；脚本或回放只证明数据与执行链路，真实模型是否受益另行验证。

**验收：** 必要要求和证据能从模型实际收到的数据或有权限的补读入口恢复；不把过去的状态当成当前状态，不重复已完成副作用。所有样本保持任务范围、权限和工具配对；无法恢复的内容明确说明。

**限制：** 不创建新的长期记忆库，不把全部历史塞入 system prompt，不把普通任务自动升级为持续 Goal。无法取得真实模型对比授权时，交付可验证的数据链路，不宣称模型行为已经改善。

**本阶段结果：** 2026-10-06 完成，独立审查通过。新增 [ordinary-continuity.test.ts](../../../tests/agent-behavior/ordinary-continuity.test.ts)，样本 `ordinary-continuity-v2`：A 有过去验收记录，B 使用 `job-b-41` 等待，用户修改 B 并禁止 C；外部摘要故意省略这些信息，随后只请求继续 B。原实现从 119 条、34,048 估算 token 压成 12 条后，实际下一请求不含原始要求、纠正、A 证据或等待句柄，确认是数据交接丢失。

[compact-continuity.ts](../../../packages/core/src/engine/compact-continuity.ts)在既有 full/simple 摘要末尾保留有限历史片段：优先近期真实用户来源，再用剩余预算保留成对工具观察，按历史顺序展示。最多 6,000 字符、24 条完整条目、每段 1,200 字符，工具观察另共用 900 字符预算；过大内容或标识明确省略，不截成假完整标识。状态是过去观察，不是当前验证结论，不授予权限。

仅程序生成的 `compactRole=summary` 能恢复末尾自有容器；原始用户、普通 assistant 或模型摘要里的类似标记不作为来源解析。既有文本 metadata 保存和恢复已知 summary/boundary 标记，支持恢复后二次压缩。审查发现后续截短会破坏合法容器，已改为只裁生成正文、保留有界来源片段，不豁免任意长摘要；没有新数据库、Goal 或 System 指令升级。

10 个离线样本、61 个相关压缩回归、13 个文本恢复回归及 core/server 类型检查通过；修正后仅重跑受影响的 10/61/core 类型。覆盖遗漏摘要、真实 fallback、恢复后二次自动压缩、完全合法伪标记、来源预算、工具反馈拥挤与长摘要仍裁剪。执行样本验证 A/B 与等待不重复、C 零执行；预算拥挤样本只验证数据与省略提示，不声称任务完成。

```powershell
node node_modules/vitest/vitest.mjs run --config tests/agent-behavior/vitest.config.ts tests/agent-behavior/ordinary-continuity.test.ts
```

**版本与限制：** RED 起始为 `cf9888bd` 加前五阶段工作区；期间外部 `5cbc8c25` 仅修复浏览器两文件，本阶段源码哈希不变，交付包按原快照记录确切差异。旧摘要缺少来源标记时不能恢复为原始来源；预算外历史明确不可用，不承诺无损记忆。没有 live 模型矩阵，不据脚本宣称模型智力或真实完成率改善。

### 阶段七 提示词与能力一致性

**工作入口：** 现有提示词组装、Run 能力视图、工具选择和实际请求记录。

- [x] 用工具启用、禁用、需审批和被拒绝的配置核对真实请求；提示不能声称不存在的能力，也不能建议绕过权限。
- [x] 检查基础提示、项目规则、相关 Skill、工具说明和恢复反馈的重复或冲突，只处理样本涉及的内容。
- [x] 只有发现稳定的行为缺口才形成候选提示；每次改变一个明确行为，不混入语气、模型配置等无关变化。
- [x] 使用阶段六的连续性场景与现有权限、纠错、停止场景作回归；有真实模型授权时再比较同一条件下的基线与候选。

**验收：** 工具与能力说明一致；失败后的动作仍在授权范围内；已有证据足够时不无故重复操作。候选不能牺牲安全和任务完整性来换取较少调用。

**限制：** 不以提示词更短或更长作为收益，不复制底层代理的整套提示，不新增工具目录或提示词框架。没有重复缺口就保持生产提示不变。

**本阶段结果：** 2026-10-06 完成，独立审查通过。实际请求复现了同一接线问题：默认 Runtime 按宿主支持能力注入说明，但工具随后还会被名单、当轮范围、收尾与 trajectory 过滤。只有 Read 的请求仍出现后台执行、委派、Skill 和 Agent 提示；终轮没有工具时也有这些说明。

在 [QueryEngine](../../../packages/core/src/engine/query-engine.ts)完成最终工具选择后，通过小型内部函数复用原条件段。函数捕获该请求的配置与 View，不重新读 warm settings；自定义覆盖、空值回退、旧调用入口及重试语义保留。后台说明只在所引用工具齐全时出现；Skill 列表和 Agent 摘要分别要求对应工具可见。审批工具仍可见，拒绝不会被改成换工具绕过。

实际工具描述还有同源矛盾：Agent、后台 Shell 和其共用的 Shell 背景说明固定点名可能不可见的 job 控制。仅将三句改为“当轮有可用控制工具才按句柄使用，不凭启动就宣称完成”，其他提示正文、工具执行、权限和命令解析不变。没有新工具目录、动态描述框架或额外能力状态。

[capability-consistency.test.ts](../../../tests/agent-behavior/capability-consistency.test.ts)的 `effective-capability-v1` 共 23 项通过：启用/禁用/名单、真实审批和拒绝、插件范围、自定义覆盖、无 View、无工具终轮、trajectory、冻结配置及提示预算。真实权限批准执行一次，拒绝和策略禁止执行零次；事件只带既有普通配置字段，不带函数、提示全文或凭据。阶段六 10 项另组通过；core 34、runtime 41、Agent/Shell 48、BG 9 项及三个包类型检查通过，均为相关分组，不累加成跨阶段唯一数。

```powershell
node node_modules/vitest/vitest.mjs run --config tests/agent-behavior/vitest.config.ts tests/agent-behavior/capability-consistency.test.ts
```

**版本与限制：** 起始/交付为 `5cbc8c25` 加工作区，审查时外部 `8049972e` 增加长文本附件粘贴；八个本阶段文件哈希未变，审查仍按原快照。没有改用户自定义文字、未知第三方描述或无关基础规则；未进行 live A/B，不将请求一致性等同于模型行为已经改善。

### 阶段八 计划与任务交接

**工作入口：** 现有会话模式、权限服务、计划和目标相关入口，以及 Agent 工具与子任务结果。先验证模式和计划，再验证委派；两者分别给出结果。

- [ ] 验证用户要求“只分析、不修改”时没有写入；用户明确要求实施后能在既有权限内继续，计划与审批不互相代替。
- [ ] 核对模式切换是否影响当前运行、其他会话或子任务；恢复后采用当前有效计划，旧计划与旧证据不能冒充当前完成情况。
- [ ] 以小型委派样本核对目标、scope、expectedResult 和必要事实是否传入，返回结果是否足以被父代理验证。
- [ ] 验证再次审核携带原始要求和未解决意见，明确父任务未完成时不能被子任务完成状态提前结束；简单任务不因通用建议强制委派。

**验收：** 模式、权限和进度各自有明确来源，当前会话切换不意外修改其他会话的行为；采用哪份计划和剩余要求可追踪；委派结果经证据核对后再采纳。完成判断继续复用现有机制。

**限制：** 不新增通用计划平台，不机械创建更多 Markdown 文件，不为所有任务增加审核轮数。跨模型委派、独立 worktree 和新的执行入口不因本阶段自动获得授权。

### 阶段九 确定性执行与辅助生成

**工作入口：** 现有 Jobs、调度、环境准备和受限模型调用，先选一个真实样本中重复出现的动作，不扩展为全能自动化。

- [ ] 检查已有任务等待和通知是否可复用；没有重复查询或准备工作的证据时，不新增 watcher 或初始化流程。
- [ ] 对选定动作验证使用同一任务句柄、无变化不反复唤醒、有变化返回真实状态，取消或失败后不重复执行副作用。
- [ ] 对已有标题、分类或短摘要入口核对有限输入、可见工具和输出校验；需要补强时只处理一个确认的入口。
- [ ] 验证无关 Skill、MCP 和项目执行能力不会被辅助生成带入；缺少资料、格式失败或超时不能静默变成成功结果。

**验收：** 等待和准备规则由已有程序能力处理，模型收到必要事实再作决策；辅助生成没有额外项目副作用，结果符合明确格式或报告失败。只在样本中比较重复调用与实际完成情况。

**限制：** 不未经授权安装依赖或初始化项目，不新建通用自动化平台，不默认增加 PR 监控功能。没有可证实的缺口可以结束本阶段而不改代码。

## 每阶段的完成与推进规则

1. 开始前核对代码与现有测试，明确本阶段真正缺失的行为和涉及文件；不把调研建议当作缺口已经存在的证据。
2. 每个确认的行为缺口先建立可失败的验证，再做最小实现；按风险运行相关测试和类型检查。
3. 在本文件更新该阶段状态、验证证据和保留限制，不以追加大量过程记录替代当前结论。
4. 阶段完成以验收成立为准；没有缺口也可以凭已有证据结束，不为完成路线图强行改代码。
5. 用户已在 2026-10-06 授权后续阶段连续执行，当前阶段验收后直接推进下一阶段，不再逐阶段等待回复；真实模型压测、生产数据采集、自动提交和推送仍需单独授权。
6. 每阶段只处理自己的范围，不并行铺开多个阶段。结束时先报告“已有覆盖通过”“确认缺口并修复”或“需要指定外部条件才能验证”，写清证据和保留限制，再推进下一阶段。
7. 发现评分器把正确行为误判为失败时，保留原始结果，单独修正验收解释或评分器；不能为了通过测试要求模型重复操作或输出固定措辞。

**下一步：** 阶段八分别核对当前运行与会话的模式、权限和计划来源，以及实际子任务交接；不把修改全局配置当作会话模式切换。
