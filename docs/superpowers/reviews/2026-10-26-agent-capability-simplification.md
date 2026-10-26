# Agent 能力简化验收

状态：文档、实现和限定范围验证完成；尚未提交、合并或推送。

基线：main 与本地 origin/main 均为 `1ba5452f981cf2d4b6c1921214cd659871f46b21`。初始主工作区干净；其他工作树未修改。旧工作树仍只有用户指定的未跟踪 S2.1 计划。

依据：[当前方案](../specs/2026-10-26-agent-core-capability-completion-design.md)和[简化计划](../plans/2026-10-26-agent-capability-simplification.md)。

## 实际删掉的入口与分支

- 新请求不再读取 metadata.outputSchema 或 runMetadata.outputSchema；使用这些字段明确拒绝。HTTP、Client、直接应用准入、编辑和重放使用显式 outputSchema。
- 删除 normalizeOutputSchema 的三个候选字段合并、重复 schema 校验和请求快照回填。请求校验、记录读取、受理时快照保存分别有明确入口。
- 删除 ToolOperationService.assertUnblocked 对完整 repository.list 的依赖，改读五个安全状态字段。
- 删除结果服务的先 resolve 授权、再 read/search 重查完整记录的路径；retain 也不再为了来源核对重读同一记录。
- 删除列表先为全部结果生成引用、读取全部正文长度，再鉴权分页的顺序。
- 删除手动 runTool 在显式 store 和安全能力齐全时跳过准备的分支。模型和手动执行都调用 bindPreparedToolResults。

## 查询的数据搬运

| 路径 | 原行为 | 当前行为 |
|---|---|---|
| 未知写入阻断检查 | 复制全部完整 Operation，包括输入和结果 | 只投影 id、sessionId、runId、kind、state，保留会话树判断 |
| list | 复制该会话完整记录，为全部结果生成文本与引用，再授权分页 | 扫描候选元数据，先来源授权和分页，只读取当前页正文 |
| read/search | 同一请求复制完整 Operation 两次，文本视图重复生成 | 查一次候选、授权一次、生成一次目标文本 |
| retain | 保存记录和来源校验重复查询、复制正文 | 一次候选身份/来源核对，一次文本视图 |

`totalChars` 从当前页已有正文的 toolResultText.length 取得，包含换行和非文本占位，保持 UTF-16 位置。测试用 emoji 与多文本块核对长度，用真实 Repository 的读取调用记录确认分页外和未授权结果不读正文。不承诺完全不读正文，也没有增加缓存或长度表。

## 兼容与状态归属

旧 Input/Run 快照不迁移，执行入口继续读取并校验。旧记录仅 Input 有 schema 或仅 Run 有 schema 均可读；重放能保留旧 Run-only 合同，不回填原 Input。Input 与 Run 同时有不同合同则拒绝。编辑的重复 ID 冲突、重放不得追加或替换合同、64 KiB、steer 限制和服务端能力协商均有覆盖。

结果仍归 S1 Operation/Attempt 审计记录。Server 保留 owner、session、Run 状态、revision、signal 和工具来源授权。跨 session、父子和兄弟会话不能互读；历史实现版本不妨碍当前获准来源读取。没有新增数据库结构、恢复调度、Workflow 持久化或持久审批。

SDK 的公开类型和模块 README 已承诺旧预绑定能力，因此 PreparedAgentRun.toolResults 与手动 options.toolResults 本轮标记 deprecated，集中到唯一绑定函数兼容。Prepared 旧存储的工具绑定等价检查继续保留，防止收窄或替换来源后越权；旧手动 store 保留可信宿主已绑定语义。新代码使用 bindToolResults(finalTools)，生产路径没有依赖旧字段。

模型与子 Run 顺序保持：最终工具集合 → await run.started 持久化投影 → 绑定结果存储 → 确认 started → 请求模型。没有提前绑定或放宽服务校验。手动执行一律准备并释放资源，工厂只见实际执行工具集合。

## 验证结果

以下为本轮独立测试用例数，不重复计算同一文件的多次运行。共 266 项 Vitest 通过；另有 8 项 Kernel 边界检查通过。

| 范围 | 文件或目录 | 通过 |
|---|---|---|
| Protocol | requests/__test__/requests.test.ts | 16 |
| Client | resources/session/__test__/structured-delivery.test.ts | 10 |
| Domain contracts | inputs/__test__/validation.test.ts | 3 |
| Services | tool-results、tool-operations | 33 |
| Server | admission 54、executor 34、interactions 20、HTTP run-execution 6、tool-operation 14、tool-result 14 | 142 |
| 真实 daemon | daemon-result-reading.integration.test.ts、durable-agent-application.test.ts | 10 |
| Agent runtime | kernel/result-store-binding 6、kernel/delivery 23、node/agent/tool-result-reading 4 | 33 |
| Core | tool-result-reading.integration 9、results 内存存储 8 | 17 |
| 真实 S1 产物交付 | tests/agent-integration 的 result-delivery.integration.test.ts | 2 |

真实 daemon 测试验证 SQLite 重开后的历史尾部补读、内置读取器只读分类、同名替换隔离，以及真实子 Agent 启动并读取授权附件。

Core 回归覆盖模型及手动调用取消后已完成结果交付、异步 retain 期间取消、活跃运行中真正保存失败停止推进。Kernel 回归覆盖可靠投影尚未完成时不得绑定、绑定未完成时不得确认 started 或请求模型、最终工具范围及工厂不泄露。交付回归覆盖真实 SubmitResult、schema 与可选宿主校验、普通文本不能冒充成功、子任务结果合同隔离。

类型检查通过：agent-contracts、domain-contracts、protocol、client、services、agent-runtime、server，以及 tests/server-client。agent-runtime 构建通过。Server 首次检查读到旧 SDK dist 声明；重建现有包后复查通过，未用源码路径绕过公开入口。

文档检查通过：pnpm check-docs（906 个 Markdown、402 个模块 README）、pnpm check:retired-ui、git diff --check。旧引用清单只更新十处行号，原文与原因不变。

方案 Markdown 是 HTML 唯一内容源。沿用 answer-me-with-html CLI 覆盖用户指定的已有页面，生成步骤见计划。最终为 7 个面板和 3 张流程图，生成器 0 警告；已程序核对 HTML 内嵌正文与 Markdown 经本地链接转换后的内容完全一致。无手写 HTML/CSS 或第二份维护正文。

## 仍保留的复杂度与理由

- 安全状态和结果候选仍需扫描元数据，SQLite 启动仍加载原状态；本轮只减少查询搬运。
- 当前页和 read/search 的目标结果仍生成完整文本，以提供准确 totalChars 和现有字符游标。
- owner、会话树、Run、revision、来源和取消检查都保留，因为它们分别阻止不同越权或迟到写入。
- Input/Run 两份 schema 快照、Operation/Attempt 审计正文继续保留，避免数据迁移和扩大范围。
- 旧预绑定字段与等价检查暂留公开兼容，等待明确的破坏性版本再删除。
- SDK 容量超限处理不变；未跑完整仓库测试，也未声称验证 S2/S3 或其他操作系统。
