# 遗漏分支修复整合计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement task-by-task. 本次按互不重叠的模块并行，依赖部分顺序接入，主代理负责审核与 Git 操作。

> 状态：四批适用修复及最后一轮交叉流程修正已完成，独立复审通过。基线 `7192912a`，原审查基线 `f476839c`；两者之间仅增加公共 API 契约文件，保留并一同交付。

**Goal:** 将仍适用的遗漏修复移入当前实现，保留 main 的功能、安全检查和职责边界。
**Architecture:** 保留现有服务、仓储、执行环境、权限检查和动态配置入口。按修复意图移植，不整份恢复旧文件、不引入旧 Docker/Cron/Memory 架构、不用 ours 合并掩盖遗漏。
**Tech Stack:** 现有 TypeScript、Node、Vitest、SQLite/Drizzle；不新增依赖。
**Spec:** 用户已确认全部适用修复合入 main；两个历史备份和互斥上下文大改暂不恢复，其他部分不得功能回滚。

## Global Constraints

- 排除 `codex/backup-main-before-scheme-a-20260917`、`codex/backup-scheduled-lifecycle-overbuilt-20260917`、`codex/context-persistence-architecture`（含同 SHA 远程引用）。
- Goal、侧栏、ImageGeneration、会话编辑、定时任务竞态的等价新版保留；旧 Cron、Docker 和废弃文件 helper 不恢复。
- 保留 T3 阶段的当前权限、受约束子任务、配置晚绑定、有效工具提示、来源压缩容器、摘要/详情和实际 Git 变更链路。
- 每个移植先让对应行为测试在当前实现失败，再补生产代码；测试只模拟外部输入，存储、状态转换和权限路径尽量真实。
- 不运行在线模型/真实供应商、安装依赖、启动 GUI、生产迁移或 WSL 实机命令。WSL 只能报告已完成的边界验证，不冒称实机通过。
- 根目录的 pnpm 依赖链接指向当前工作区；为避免新工作区检查旧源码，本次使用专用整合分支复用现有依赖。其他任务改动不覆盖。
- 工作者不修改其他模块，不提交/push，不创建子代理；主代理分批提交、检查主分支新变化后合入并推送。独立审核通过才交付。

### Task 1: 批次 A — 凭据、配置、Web 和 MCP

**源提交：** `60435f90`、`75cc6b14`、`7694bf52`（不含已删除 Docker）、`b199fad1`、`5e37a945`（不含已删除 Cron）。
**负责文件：** packages/auth/src/{credential-storage,credential-resolution}.ts 及测试；packages/core/src/config/settings.ts 及对应测试；packages/server/src/default-services/provider-service.ts 及测试；packages/tools/src/{web,mcp}；packages/agent-runtime/src/mcp-auth.ts、必要接线及相关测试。
**输入/输出：** 沿用 CredentialStorage、配置原子写入、已有 prepared MCP connection 和当前工具授权入口；不创建第二套权限策略。

- [x] 移植原提交的行为测试：两个凭据实例交错写入不能丢掉对方内容；命名自定义 endpoint 不借用其他密钥；保存配置不写入 transient apiKey；缺失/非法 provider id 明确拒绝。
- [x] 运行对应测试取得真实 RED，再在原入口修复；保留显式调用密钥、默认 provider/Codex、配置原子写入及已有字段验证。
- [x] WebFetch/WebSearch 在启用 sandbox 且网络策略 none 时不能发请求；保持现有环境工具可见性规则和允许的正常网络行为。先测试再接共享小型 guard。
- [x] MCP 新认证准备失败不修改可用设置、连接或工具；成功后才保存并交换。保留项目/全局配置来源，不重建旧 reconnect/register 流程。
- [x] MCP 代理调用不能绕开真实目标工具的可见范围和正式 deny/approval；同时正常可用工具可调用。使用获准的内部 `ToolContext.callMcpTool(name, input, options?: { signal?: AbortSignal; deadlineAt?: number }): Promise<ToolResult>`，由 QueryEngine 按 captured registry 复用原 checked pipeline；只接真实 MCP binding，不走 trusted bypass。保留权限事实，不为内层委派制造未配对的模型调用/工具记录，不引入通用嵌套执行平台。
- [x] 定向测试、受影响类型检查、精确差异检查及逐提交处理说明完成。

测试命令使用现有 Node，如包目录下 `node ../../node_modules/vitest/vitest.mjs run src/index.test.ts src/credential-resolution.test.ts --config ../../vitest.config.ts`；core 配置、server provider、tools Web/MCP、runtime MCP 仅运行受影响分组。

### Task 2: 批次 B — Jobs、运行取消、后台启动、项目与子会话

**源提交：** `79aa2085`、`cb1405be`、`6095bbf9`、`a2bde668`、`b918fce0`、`4df775e7`、`3aec50dc` 的适用部分。
**负责文件：** packages/server/src/jobs；runtime/run-coordinator.ts；application/session/background-shell-service.ts；application/session/session-execution-projector.ts；services 的 project/session repository、对应 application 和客户端刷新入口；daemon/daemon-agent.ts 与 application/agent/daemon-agent-event-projector.ts。
**输入/输出：** 使用现有任务 ID、条件状态转换、执行监听、完成 Promise、环境租用和会话控制；父任务完成仍由原机制判断。

- [x] 以真实 Jobs 服务复现：完整输出后统一 maxChars 截断；completed/failed Agent 发送 continue 后重开，失败恢复旧状态，后续完成更新真实持久状态。
- [x] 取消 pending 时若已转 running，必须停真实进程，而不是仅覆盖数据库状态；提升中的队列运行被中断后不能重新放回队列。
- [x] 同一后台 Shell 请求在首次 acquireEnvironment 尚未完成时，重试等待首个完整启动；不能提前启动无环境进程，失败/取消保持原事实。
- [x] 项目 rebind 保留根外 worktree cwd；运行中拒绝重绑，先关闭受影响 warm Agent 再改 cwd，发布真实会话变化；新 session 校验项目路径边界。
- [x] 子会话不继承 coordinator 会话模式。保留当前未知 Agent 拒绝、严格 metadata.runtime、受约束 permissionMode 与冷恢复，旧 legacy fallback 不恢复。
- [x] 所有反例先 RED 再修复；保留原有编辑事务和新版 schedule 处理；定向检查后给 C 批释放 background-shell 文件，才能接 WSL 子目录改动。

定向入口：daemon-job-service.test.ts、run-coordinator.test.ts、background-shell-service.test.ts、project/session repository 与 application tests、daemon-agent/event-projector tests；额外保留 child-mode-recovery.integration.test.ts 和 scoped-plan-delegation.test.ts。

### Task 3: 批次 C1 — 图片、附件与桌面 Git 边界

**源提交：** `aca78f7b`、`282fad01`、`80a09887`。
**负责文件：** server/application/visual-tools/remote-image-source.ts、daemon-image-to-text-tool.ts；services/attachments/storage/attachment-media-type.ts；desktop/main/features/git/git-service.ts 及对应测试。

OCR 所需的窄接口在本批实现：environment/types.ts 增加可选 `paths.canonicalize(path: string): Promise<string>`，sandbox 的 Native/WSL handle 提供真实实现及对应测试。此接口不扩大文件权限；只提供当前环境的真实路径，不替代资产引用授权。

- [x] 移植 NAT64/6to4 回环与私网地址阻断、BMP 签名识别测试，保留下载预算、已有 IP 验证和附件上传流程；实际失败后移入新路径。
- [x] 当前 ImageToText 路径拒绝越界与符号链接逃逸；保持执行环境/WSL 的读取方式，不恢复已删 host adapter。Native 使用 realpath，WSL 通过自身执行器/已有 helper 取路径；无此能力的 custom handle 对 image_path 明确报不可验证，不猜测安全。项目根和项目内合法 symlink、绝对/相对项目内图片、原 asset 引用继续可用。此处不扩为正式 pathRules 重写。
- [x] Git fileDiff 的 `src/../../outside` 被拒绝，合法项目内路径仍可读；保留 POSIX 查询隔离、当前工作区 diff 和保存的仓库根目录。
- [x] 只修改该模块范围，定向测试/types/diff 完成，给独立审查精确范围。

### Task 4: 批次 C2 — WSL 与执行环境

**源提交：** `43b039da` 的仍缺部分。A/B 释放交叉文件后执行，不能与它们同时修改 settings 或后台服务。
**负责文件：** 当前 environment 的配置、native/WSL executor、path resolver 和 file operations；core 设置、CLI 与 daemon 默认；Shell/后台工具及必要 executionCwd 接线。

- [x] 非法 agentEnvironment.kind 在设置、环境变量、CLI 与 resolver 入口拒绝，不静默降为 native；保留 VYKOR 名称和现有 Windows shellDescriptor。
- [x] native 子目录 cwd 生效，sandbox 相对规则仍以 workspace 为基准；根外路径不标作 workspace。
- [x] WSL 预检返回实际 HOME/SHELL，取消走 `/bin/kill`；保持现有原子写入、shellDescriptor、sandbox 文件保护和真实环境事实。
- [x] Shell 工作目录边界、后台 WSL executionCwd 和 fingerprint 贯穿现有入口；与 B 的完整启动等待组合，不能创建第二个启动负责人。
- [x] WSL 查找先正确过滤再限量，rg 可用优先、fallback 也含隐藏文件和 brace glob；不再先 limit*10/20 截掉候选。
- [x] daemon 默认获取会话执行环境，保留显式模式。配置/执行器/文件查找/后台子目录每项先实际 RED，覆盖正常 native 与 Windows shell 行为。

## 原分支修复的去向

原提交保留在各分支。本次按适用行为移植，旧引用不一定成为 main 祖先；不使用 ours 合并把尚未恢复的代码伪装成已经合入。

| 原提交 | 当前整合去向 | 状态 |
| --- | --- | --- |
| 60435f90、75cc6b14、7694bf52 | 当前 Auth、配置与 provider 校验；Docker 部分已删除，不恢复 | 已复审，dca21f11 |
| b199fad1、5e37a945 | 当前 Web guard、MCP 正式授权与原来源配置保存；旧 Cron 不恢复 | 已复审，dca21f11 |
| 79aa2085、cb1405be、6095bbf9 | 当前 Jobs 截断、重开/完成观察与真实取消 | 已复审，87c85d2a |
| a2bde668、b918fce0 | 当前提升取消、完整后台启动等待 | 已复审，87c85d2a |
| 4df775e7、3aec50dc | 当前项目仓储/重绑控制和子会话 direct 模式；严格 runtime/permission 保留 | 已复审，87c85d2a |
| aca78f7b、282fad01、80a09887 | 当前图片 IP、BMP、OCR canonical 边界与 Git 路径校验；不恢复旧 host adapter | 已复审，29356276 |
| 43b039da | 当前执行环境、文件查找和 Shell/后台目录接线；已等价的 Windows descriptor 保留 | 已复审，c95c9821 |

已等价覆盖的 Goal、侧栏、ImageGeneration、会话编辑和 schedule 处理不重新导入。用户明确暂缓的两个历史备份及 Context 持久化替代架构保持原样。

## 审查、提交与合入

- [x] 独立审查逐批代码、回归证据和无功能回滚要求；关键问题修正后复审。
- [x] 更新本计划逐提交状态；明确“适用修复已移植”“已等价覆盖”“入口已删除不恢复”“用户明确暂缓”，不冒称所有旧引用都成为 main 祖先。
- [x] 相关串联测试、类型、文档和 Git diff 检查通过；尤其当前模式/权限、MCP 实际授权、任务重开监听、WSL 后台首次启动。
- [x] 适用代码五次分批提交，原 pre-commit 检查均保持开启并通过。已 fetch 核对 main `7192912a`、origin/main `f476839c`，没有新增分歧；本记录单独提交，合入与推送按下文验收执行。

## 最后一轮交叉流程修正

整分支审核完整读取四批净差异，发现三项必须修正的问题，统一修复后由同一审核者限定复审，结果为全部解决、可以合入：

最终修正提交：`b8510148`，只包含六个源码文件及两组新增回归测试。

1. 已完成或失败的 Agent 继续运行后，如果发送失败，只恢复仍属于本次重开的状态。同步比较 `running` 和单调递增的 `updatedAt`，不能覆盖取消、后续输出或再次完成。保留原任务更新通知及 JobWait 等待入口。
2. 终端创建在首次异步等待前进入原操作 gate（阻止重绑与启动交错的同一入口），覆盖环境获取、PTY 创建和登记，最后释放。重绑直接查询现有终端提供者的活动记录，包含仅归属项目的终端；已关闭或无关项目终端不阻塞。没有新建第二份终端状态缓存。
3. 重绑的真实完整 Store 查询改用已有 `runs` 读取入口；Jobs 和后台服务按已有会话查询、任务操作接口使用窄能力。任务写入仍绑定会触发通知的原 Store，不直接写仓储来绕过通知。实际架构扫描从 129 降到 100，冻结基线 123 和扫描器均未修改。

## 验证证据与限制

- 四批均有实际失败的行为测试，再修改生产代码；夹具错误、依赖读取失败不算行为回归证据。每批及必要修正均经过独立审查，按冻结差异和文件 SHA 核对。
- MCP 最后配置来源修正：core 66、runtime 21 个相关测试通过；涵盖项目空列表/仅其他服务器的整列表覆盖、删除/停用/改地址以及准备期间变化，不恢复旧配置覆盖新版。
- Jobs/项目串联修正覆盖后台首次环境获取、重试加入、取消、继续运行与 HTTP 409；子会话 default/plan 冷恢复使用真实存储验证，当前权限限制保留。
- 图片/Git 批次原相关测试 96 个通过；符号链接的媒体类型修正后 OCR 19 个通过。路径授权与读取仍使用真实 canonical 路径，媒体类型从用户提供的合法原路径推断。
- 执行环境批次：331 passed、1 skipped，六包类型检查通过。涵盖 Native cwd、Windows shellDescriptor、WSL 受控探测/查找输入及后台执行目录接线。
- 整分支实际模型请求构造的四组回归共 44 个通过；桌面 node/web 类型检查通过。这里验证提示、工具范围和模式传递，不发出模型请求。
- 最后一轮：server 八文件 87 个测试、terminal-node 5 个测试通过；包括真实 Store/子任务运行器上的取消、完成、进展交错，以及真实 Application/Store 配合 fake PTY 的终端重绑。两包类型检查通过。
- 主代理独立运行 `node scripts/architecture-boundaries.mjs`，结果 `sessionStoreFlatCalls: 100`；`git diff --check` 通过。原提交钩子保持开启；文档使用 `node scripts/check-docs.mjs` 检查。

上述分组存在重复，不能相加冒称唯一测试总数。没有运行供应商对比、在线模型、WSL 实机、真实 Linux 进程组、SRT、PTY 或 GUI；这些仍需相应环境验证，不宣称已验证。

## 为避免功能回滚采用的取舍

- 复用现有 checkout 的专用分支，而非重装依赖创建新工作树：已有 pnpm 链接指向当前目录，否则容易检查到旧源码。代价是目录隔离较弱，以文件职责分配和唯一 Git 写入者控制。
- A/B/C1 只在不重叠文件上并行；C2 等待共享 settings/后台文件释放后串行接入。发现接口依赖就暂停相关写入并做定向验证。
- 按适用行为移植旧提交，而非整文件恢复或强行制造旧引用的合并关系。因此旧分支可能仍不是 main 祖先，不能据此认为它的适用修复遗漏，也不能认为暂缓架构已经恢复。
- MCP 只增加专用内部检查调用入口，继续走同一权限、取消和超时流程，不新增通用嵌套工具平台；保留权限事件但不产生未配对的模型工具记录。
- 图片批次提前提供可选的真实路径接口，避免依赖执行环境批次而互相等待。缺少该能力的自定义环境对 `image_path` 明确拒绝，受控资产引用仍可用；这是一项安全收紧，不隐藏为完全兼容。
- MCP 使用原配置锁保存、同步交换准备好的连接；交换失败恢复原持久对象。不新增通用事务框架，恢复可能重排 JSON，恢复失败明确报告。命名自定义 provider 不再借其他来源的密钥，需要配置自身凭据。

Git 交付验收：检查 main 和 origin/main 均为整合分支祖先，再快进 main；推送后核对本地主分支、远程主分支 SHA 相同及工作区无未提交文件。保留其他分支和暂缓引用，不执行强制推送或删除。
