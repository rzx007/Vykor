# 文件修改完整流程：统一 Spec 与实施记录

> 状态：文件工具收敛（§22–§24）与 Shell 长输出留存／补读（§25–§27）已实现并验证。当前本轮权威为 §25–§27；前轮记录保留。工作区交付，未替用户提交、部署或重启应用。

## 1. 范围与事实

目标是让一次文件修改沿同一条可理解、可确认、可恢复的流程运行：了解目标状态 → 生成完整调用 → 校验参数 → 等待确认 → 执行修改 → 返回真实结果和恢复信息。

最近五个任务里出现过路径不存在、参数包装/类型错误、原文未匹配、重复整文件生成和长时间等待确认。本轮解决这些有代码和记录支撑的工作流问题。首次生成慢的原因尚未确定，本轮不调整供应商、模型、请求性能参数，不做耗时对比，不宣称首次生成提速。

| 原事项 | 本轮覆盖 |
|---|---|
| 生成前确认路径与覆盖条件 | Read 提供仅文件状态检查，返回存在性、类型、原字节 hash 与写入前提；Write 说明明确先检查，执行时再次验证 |
| 已生成内容失败后复用 | 纳入已实现的 `Write.content_from`，保留正常校验、权限和失败保护 |
| 参数包装与内容匹配分开 | 复用已经提交的统一参数归一化；Edit 的匹配失败给受限原文、位置和下一步 |
| 等待模型/生成参数/确认/执行的可见性 | 生成参数只发展示事件；确认和真实执行阶段单独展示，不改变提交和执行时机 |
| 小修改减少往返 | Edit 支持同一文件的一组修改；跨文件复用 ApplyPatch；同批文件修改按顺序执行 |
| 模型与供应商对比 | 明确排除 |

本文件是本轮统一范围的权威说明。之前 [Write 内容复用记录](./2026-10-02-write-content-reuse-design.md) 保留为已完成阶段的记录，不另开缓存、草稿或第二套恢复流程。

## 2. 已有入口与要消除的重复

- Provider 接收工具名和参数片段，最终才产出完整 `tool_use_start`；QueryEngine 再缓冲到模型流确认完成，避免失败请求重复执行。
- `prepareToolCalls` 已统一处理参数包装、别名、正文引用、schema 校验和失败记忆；权限与执行必须使用同一份有效输入。
- `authorizeToolCalls` 已有确认请求与回复，但 `tool.started` 早于确认，当前不能代表实际执行开始。
- QueryEngine 已并行处理一个响应内的工具调用，但同文件修改会相互依赖；`tool_use_end` 在整个批次完成后才提交。
- Edit 已有多种容错 matcher。现有对外 computeFileChange 预览 API 却只用精确替换，与实际结果可能不同；本轮用一个纯函数统一预览和实际修改计算。当前生产权限卡没有直接调用该 API，本轮不宣称新增 diff 界面，权限卡仍展示真实有效输入。
- ApplyPatch 已有多文件、多 hunk 预演、原字节 hash 复核、原子单文件写入和部分失败反馈，继续复用。
- Session/Run/Part metadata 已沿 SSE、client、desktop 透传；进度使用这些现有状态，不新增数据库表、协议存储字段或前端 store。

## 3. 设计选择与代码边界

采用现有工具的明确扩展和现有事件路径；不新建通用文件事务平台、通用 Batch/Retry 工具、磁盘草稿、全局缓存、资源锁服务或第二套校验器。

| 层 | 所有的职责 | 不拥有的职责 |
|---|---|---|
| api/provider | 报告已收到工具参数的字符数和工具标识 | 不授权、不执行、不宣布文件已修改 |
| core | 完整调用提交、参数准备、确认、批次调度、真实工具阶段 | 不解析文件内容或访问数据库，不认识具体文件工具实现 |
| tools/file | 状态读取、编辑预演、匹配诊断、执行时文件检查及落盘 | 不自行派发模型、不修改会话存储、不绕过权限 |
| runtime/server | 将运行事实投影到既有 Run/Part，清理失败与终态进度 | 不把展示进度当作可执行调用或模型历史 |
| desktop | 依据真实阶段显示现有状态标签和结果 | 不推断供应商故障、完成比例或执行成功 |

另两种方案未采用：提前执行流式工具会破坏失败重试边界；新建恢复服务或跨文件事务服务会增加不必要的存储与生命周期。用户要求一次完成全范围，因此下面功能作为同一流程实现和联测，不分批交付。

## 4. 生成前了解目标：Read.info_only

在现有 Read 增加 `info_only?: boolean`。默认读取行为不变，true 时不返回正文、不创建目录、不写入文件。

```json
{"file_path":"C:/workspace/index.html","info_only":true}
```

返回目标解析路径、`exists`、`kind`（file/directory/symlink/other/missing），普通文件返回原字节 `sha256` 和字节数；明确已有文件在内容改变时需要 `overwrite=true`。缺失目标检查父目录状态，父目录信息不可读取时保持 unknown，不伪装成存在或可写。可以检查当前沙箱写策略并显示限制，但必须明确这不是 Write 的权限批准，也不保证实际 OS 写入一定成功。

- 所有 stat/hash 前先检查目标读取策略；父目录额外读取也先检查对应策略。拒绝读取时不返回内容、hash 或候选片段。
- 符号链接和非普通文件不返回可覆盖承诺；Write 已有这类拒绝逻辑。
- Host stat 也必须识别断开的符号链接，不能误报为可新建的 missing；如需修正，放在已有 HostFileOperations.stat，让 Read/Write/ApplyPatch 共用，WSL 使用现有同等判断。
- hash 是原始字节 SHA-256，模型需要时显式传给 Write.expected_sha256；不把预检查当成长期授权或隐含覆盖意图。
- Write 覆盖前也要重读当前类型和字节，与本次读取的原始快照比较；发生变化即拒绝。expected_sha256 仍是显式的额外约束，不能自动继承。Write/Edit 的复检可共用已有 file operations 里的小函数，ApplyPatch 保留现有等价复检。
- 此模式仅限执行环境文件路径。attachment:// 资源不是可写目标，宿主 attachment Read wrapper 对 info_only 明确拒绝，不默默返回正文。
- Write 工具说明要求生成长正文前用此入口确认路径和覆盖条件；新建与覆盖仍在实际执行时复检。程序不宣称能强制所有模型在生成前调用检查，也不引入额外票据。

普通 Read 的正文和分页格式保持原样；hash 由 info_only 明确提供，本轮不再增加另一种读取返回格式。

## 5. 单一编辑计算：单次和批量共用

### 5.1 模型接口

保持现有单次 Edit；新增 `edits` 数组，同一文件的多个修改只提交一次：

```json
{
  "file_path":"C:/workspace/a.ts",
  "edits":[
    {"old_string":"first old","new_string":"first new"},
    {"old_string":"second old","new_string":"second new"}
  ]
}
```

- 单次 old_string/new_string/replace_all 与 edits 形式互斥；不在 schema 根添加组合分支，保持已存在的参数包装恢复规则。
- 数组非空；每项 old/new 为字符串，replace_all 只能是布尔值。不猜测类型或复制新内容。
- edits 按给定顺序在内存中预演，后面的步骤可引用前面的预演结果。全部成功后只写入一次；任意步骤失败时整组不写入。
- 新可选 `expected_sha256` 与 Write 一致，用原始字节 hash 约束当前文件；不自动继承任何覆盖或校验条件。
- 不支持跨文件 edits 数组；跨文件/多个 hunk 使用现有 ApplyPatch，避免新增重叠工具。

### 5.2 文件内纯函数

新增一个小的 `edit-plan.ts`，负责参数形式、BOM/行尾处理、调用现有 matcher 和顺序预演。它只接受文本与参数，不读取文件、不写文件、不查询会话。

Edit.execute 和 computeFileChange 的 Edit 分支共同调用这个函数。删除原 execute 和 preview 中重复的替换分支，不新增一套 matcher、不放宽现有相似度阈值。替换内容按字面值应用（`$&` 等不应变成特殊替换语义）。保留 BOM 和目标行尾。

执行先检查读写策略和目标类型，严格读取 UTF-8 文本与原字节；预演后在写入前 best-effort 再检查当前字节 hash，发现文件变化则拒绝，不能覆盖用户或其他进程新改动。用已有 writeTextAtomic 落盘，无跨文件回滚承诺。

既有预览 API 使用同一计算函数，不能计算一种修改、实际应用另一种。预览是当前文件快照，不是授权票据，执行仍检查当前状态；本轮不新增权限 diff 展示组件。

### 5.3 失败诊断

现有 `EditMatchError` 可携带实际候选范围和数量，让调用方无需再次运行全部 matcher。匹配失败、候选歧义、范围过大和批量步骤失败，返回稳定错误种类及受限诊断：

- 原错误说明放在第一段；附失败的 1-based edits 索引与“未写入任何修改”。
- 单次/第一步可用 matcher 已找到的候选位置；未命中时只用 old_string 中至多两个有意义的字面行定位锚点，不增加新的模糊匹配或自动应用策略。
- 诊断始终来自执行时读取的原文件。批量后续步骤失败时，丢弃未写入的预演结果，重新在原文件找诊断锚点，不把预演文本声称为已落盘内容。
- 最多 3 个窗口，每窗口最多 7 行，总文本不超过 4,096 字符；单行截断有明确标记。只含少量附近原文，不能把整个文件回传。
- 找不到有意义的锚点时返回文件总行数和明确的 Read/Grep 下一步，不伪造“最接近位置”。
- 行号只为展示，说明不能把前缀或截断标记复制进 old_string。
- 权限/策略拒绝、非法 UTF-8、无效参数不附文件片段；失败保护和原执行结果分类不改变。

## 6. 批次调度与真实执行阶段

在 `ToolDefinition` 增加可选声明 `serialGroup?: string`。Write/Edit/ApplyPatch 统一声明 `file_mutation`；core 只按声明调度，不认识文件路径或文件工具名称。

- 同一模型响应内，同组调用按模型给定顺序执行；没有组或不同组继续并行。
- 分组使用原批次 idx 和实际工具声明，覆盖参数准备、权限拒绝、hook 拦截和执行失败。不能只对 executable 列表排队，因为早期失败项已经被过滤掉。
- 同组的权限请求与执行串在同一顺序链里，前项失败或结果未知时，后续项既不请求确认，也不执行，返回清楚的 not_started 与阻碍；没有自动回滚或改工具重试。其他组仍并行。
- 被组内前项阻断的调用标记宿主 recoveryGuard，不当作该输入曾实际失败写入 failedToolCalls；修好前项后不会因此被错误封锁。同参真实失败保护继续有效。
- 等待组内前项时显示 queued；进入实际 executeToolWithTimeout 前才显示 running，不能把 tool.started 当作已执行。
- 取消时不启动后续组内调用。执行批次先收齐已返回结果以及仍运行/未启动项的真实取消结果，按原顺序提交 tool_use_end，再结束 Run；framework 在取消后允许已提交调用的结算事件通过，不能在第一条终态事件前丢弃整批输出。phase=completed 本身不是完整结果持久化的替代。
- 未启动项为 interrupted/not_started，已经进入执行但取消结果未知的项为 interrupted/unknown，已返回项保留其实际结果，不编造“已回滚”。
- 只处理当前批次，不建立全局/跨会话锁。外部进程或不同会话的变化由文件 hash 复检处理；这是 best-effort 冲突检测，不宣称 OS 级 compare-and-swap。
- 不自动合并模型发出的调用。Edit.edits 与 ApplyPatch 的说明指导模型在可独立预演时减少往返，不把有依赖的读取、确认与修改偷偷拼成一批。

## 7. 进度展示与执行严格分开

### 7.1 生成参数事件

在 core StreamEvent 新增展示事件：

```ts
type ToolGenerationProgressEvent = {
  type: "tool_generation_progress";
  toolKey: string;
  toolUseId?: string;
  toolName?: string;
  receivedChars: number;
  generationId?: string;
  attempt?: number;
};
```

toolKey 为 provider 内稳定 index/item_id；上游工具调用 ID 晚到时可以缺失。receivedChars 是累计原始参数字符数，不是文件字节数、输出 token 数或百分比。

- OpenAI/Anthropic 在已存在的参数累积处报告工具名及增长；Codex 补识别 function_call_arguments.delta，并用本地模拟 SSE 验证。
- QueryEngine 出口补当前 generationId/attempt，第一次立即展示，后续以 250ms 节流，成功结束前补最后累计数；不加后台计时任务。
- 此事件不进入 attemptToolUses、模型历史、权限、失败记忆或 toolActivity；完整 tool_use_start 仍等待 complete 验证成功。
- 不发送参数正文、不解析半截 JSON、不声称已修改文件。
- runtime 映射成既有 domain.event，name=`tool.generation.progress`；server 将集合保存到当前 run.metadata.toolGeneration，通过既有 run.updated 发给客户端。
- 正常提交工具时清对应生成条目；attempt finished 清本次条目（成功或失败/取消）；generation started、retry 与 run 终态防御性清理。终态 Run 永远不能显示活动生成状态。
- 集合按 generationId/attempt/toolKey 标识，累计值覆盖而非相加；旧 generation/attempt 的迟到事件不能恢复状态。只接收当前运行和当前生成的事件。

### 7.2 确认、排队、执行与返回

复用 domain.event，name=`tool.lifecycle`，payload 为 `{ toolUseId, toolAttemptId, phase, executionState? }`。phase 为 `preparing | waiting_permission | queued | running | completed | failed | unknown`；executionState 只记录已知的 `not_started | completed | unknown` 事实，不从 failed 单独推断“已运行”。

- committed tool part 创建时标 preparing。
- authorizeToolCalls 在请求确认前按 toolUseId 发 waiting_permission；确认后排队/执行由实际调度阶段决定，不按工具名猜关联，不扩充 permission broker。
- executeTools 用已有 execution.emit 发送 queued/running，并在每项实际返回时发送 completed/failed/unknown。整批 tool_use_end 继续按原顺序提交历史与完整结果。
- 参数准备失败、权限拒绝、hook 拦截、组内未启动也立即发终态展示与 not_started，不能留在 preparing。server 更新必须绑定当前 Run、call ID、attempt ID，终态阶段不可退回活动阶段。
- 无 execution 宿主时不增加异步队列；普通 CLI 的完整调用/结果行为不变，StreamEvent 仍能提供生成进度。
- server 只更新当前 Run 中已提交的对应 tool part，不创建虚假调用；每次完整替换 metadata.toolProgress，终态 part 明确清理或写终态阶段。
- `externalToolMetadata` 将 toolProgress 视为宿主保留字段，外部工具结果不能伪造进度。
- 任务异常收尾或 daemon 重启恢复时，preparing/waiting_permission/queued 明确为 not_started；running 或缺失阶段仍保持 unknown。生成集合在恢复后的终态隐藏；已经实际返回的阶段不能假称“未执行”。沿已有 transcript 收尾和 conversation transaction 恢复入口修正，不新建恢复器。

completed 阶段只表示工具已返回，最终结果尚未提交时显示“工具已返回，等待本轮结果”；unknown 明确显示“结果不确定”。终态 part.status 优先于残留 metadata，不能重新启动 spinner。

### 7.3 Desktop 复用现有位置

- `transcript.tsx` 已有 running-status LoadingState；结合当前活动 Run 的生成 metadata 和已提交工具 Part 阶段派生标签。正在等待确认或执行工具时不能同时显示“等待模型响应”；没有活动工具/生成/重试时才使用等待模型标签，多条生成进度只做短汇总。
- 不显示估计百分比，不改变模型设置，不新增面板或 store；现有 modelRetry 提示优先，Run 终态隐藏活动生成。
- 现有 ToolActivityGroup 即使折叠，标题也显示活跃阶段；每项显示等待确认/排队/执行/已返回，不能只把信息放在默认折叠内容里。
- 批量 Edit 是一次调用，摘要显示 N 处修改；已修改文件仍只根据成功结果收集，不能把失败 batch 输入里的目标当成成功改动。

## 8. 实现范围与验证边界

主文件范围：

- tools/file：Read info_only、Write 说明与声明、Edit plan/诊断/批量/原子写入、共用 preview、ApplyPatch 声明；attachment Read wrapper 对新模式明确处理。
- core：展示事件类型及导出、QueryEngine 展示节流和组内调度、权限阶段事件、宿主 metadata 过滤；保留上轮正文复用。
- api：三种 provider 的参数进度事件。
- runtime：StreamEvent → domain.event 映射，展示事件不污染工具活动。
- server/services：生成集合和工具阶段投影、结束与重启清理，复用现有 Run/Part 存储和 conversation transaction。
- desktop：现有 loading/工具分组的阶段文字与 batch 摘要，复用现有组件。
- prompts：先检查、同文件批量 Edit、跨文件 ApplyPatch、失败后复用/按诊断修正的短指导。

不改数据库 schema、client reducer 事件类型、工具输出正文流式协议或供应商性能设置。

必须覆盖：

1. info_only 新建/已有/目录/符号链接/不可读/父目录缺失/attachment，零写入，不错误承诺授权。
2. 单次与批量共用预览，保留 BOM/CRLF，字面 `$&`，失败时无部分修改，hash/并发变化拒绝。
3. 诊断有实际原文位置且受限；不匹配/歧义/范围过大/批量后续失败不误报已落盘；拒绝读取不泄漏片段。
4. 同组稳定执行顺序，失败停止余项，其他组并行，取消不启动后续，未知结果不会变成成功。
5. 各 provider 用模拟流报累计字符、迟到 ID、并发调用；坏 JSON/无 complete/失败重试仅展示，不执行。
6. generation/attempt 失败、取消、重试与 Run 终态清理；SSE 重放/快照状态一致。
7. 等待确认和真实运行分别可见，同名工具按 ID 关联，外部 metadata 无法伪造阶段，折叠标题与终态 spinner 正确。
8. 原 Write 内容复用、权限、失败记忆、现有 matcher/ApplyPatch 与主引擎回归继续通过。

按风险运行相关 package 的范围测试、受影响类型检查、文档和架构检查；不重复完整 monorepo 测试，不用真实模型或真实任务文件验证。若需要产品验收，只构建验证、不自行重启用户运行的应用。

## 9. 审核、计划与交付

先由子代理对照代码审核统一 spec 并修订，再将可执行计划追加在本文件。实现任务可以在明确文件边界后并行；接口按本文固定，主代理做整条流程联测和最终子代理代码复审。

用户已明确授权连续完成，默认交付工作区改动，不另行要求设计审批，不自动提交/push/重启服务。保留已有内容复用及其他会话改动。

### Spec 审核记录

2026-10-02，子代理 `review_file_workflow_spec` 对照实际代码审核，结论为总体可实施。已采纳必要修订：分组覆盖 prepare/deny/hook；组内未执行不污染失败记忆；取消后保留已返回的完整结果再收尾；Write 补写前快照复核；生命周期绑定 Run/call/attempt 并区分阶段和执行事实。也明确对外 preview API 与现有生产权限卡的实际关系，以及普通 Read/attachment 的边界。没有增加存储、恢复服务或新事务平台。

## 10. 统一实施计划

> 使用 test-driven-development 与 verification-before-completion。用户指定一个文档，因此计划、审核和进度均在本文件；明确文件所有权后由主代理与两个子代理实现，最后整体验证和只读复审。

**Goal:** 一次性完成第 1 节所有范围，保留已实现的内容复用，不处理模型性能。

**Architecture:** 文件检查、编辑计算和落盘属于 tools；完整调用校验/授权/组内顺序属于 core；展示性参数生成与真实执行阶段通过现有 runtime/domain/Run/Part metadata 到 Desktop。所有功能依靠这条已有路径，不引入替代框架。

**Tech Stack:** 现有 TypeScript、Node API、diff、Vitest、React 与既有 LoadingState/工具分组；无新依赖。

### 10.1 共享接口与状态约定

- Read.info_only=true：text 返回紧凑 JSON，并在 metadata.fileInfo 放同样事实；字段为 path、exists、kind、sha256?/sizeBytes?、parentExists（true/false/null）、writePolicyError?、note。note 明确尚未授权，existing changed content 需要显式 overwrite。
- 纯编辑入口：`planTextEdits(content: string, input: Record<string, unknown>): { content: string; editCount: number }`。所有参数和匹配错误为 tools 内部稳定错误，可附 editIndex（1-based）和候选范围；批量异常不能丢失原文件诊断背景。最终命名可随最小实现调整，execute 与 preview 必须共用。
- 共用复检入口：`fileSnapshotMatches(operations: FileOperations, path: string, beforeBytes: Uint8Array): Promise<boolean>`；目标缺失/类型变化/字节变化返回 false，其他 I/O 错误保留原错误，不把权限错误伪装成不存在。
- `ToolDefinition.serialGroup?: string`；文件修改三个工具为 file_mutation，其他工具不变。
- `ToolGenerationProgressEvent` 按 §7.1 形状；QueryEngine 出口 generationId/attempt 必须有效，runtime domain name 固定 tool.generation.progress。
- run.metadata.toolGeneration 为数组，项含 generationId/attempt/toolKey/toolUseId?/toolName?/receivedChars；覆盖累计值，不累加。当前生成之外的事件忽略；不存正文。最多保留 32 个活动条目，过量条目只影响显示，不影响真实工具提交。
- tool.lifecycle payload 按 §7.2，toolAttemptId 固定既有 `tool_attempt_${toolUseId}_1`；part.metadata.toolProgress 为完整 `{ phase, executionState? }`，不能只浅合并某个子字段。
- 取消后 tool_use_end 仅结算已提交工具 ID；不接收新的 tool_use_start、生成进度或执行请求。

### Task A：文件检查、共用编辑计算与批量恢复（主代理）

**Files:** tools/file/read.ts、write.ts、edit.ts、edit-replacers.ts、preview.ts、operations.ts、apply-patch.ts；新增小文件 edit-plan.ts 与 edit-feedback.ts；相应 tests；server application/attachments/tools/attachment-read-tool.ts；prompts/index.ts。

**Consumes:** 原 FileOperations/ToolContext、已经实现的 inputReuse；Task B 的 serialGroup 声明。

**Produces:** Read.info_only、Edit.edits/expected_sha256、单一编辑计算、受限诊断、写前快照复核；不改 core/server 进度实现。

- [x] A1：写 info_only 与 Write 变化冲突回归，观察缺失行为失败。使用临时文件与可记录写次数的原 FileOperations，不运行用户文件。覆盖不存在/已有/hash/目录/符号链接/不可读/父目录/attachment。

```ts
const result = await fileReadTool.execute({ file_path: target, info_only: true }, context);
expect(JSON.parse(textOf(result))).toMatchObject({ exists: true, kind: "file", sizeBytes: 3 });
expect(await readFile(target, "utf8")).toBe("old");
// 对受控 filesystem 在复检前改为用户的新正文，Write 必须拒绝且不能覆盖。
expect(conflict).toMatchObject({ isError: true, executionState: "not_started" });
```

- [x] A2：实现 Read 的只读分支，保持普通读取格式；在已存在的 Host stat 修正 dangling symlink；Write/Edit 在已有 operations 内共用小的快照检查。用目标读取和父目录读取策略保护信息，不增加参数票据。

```ts
if (input.info_only === true) return inspectFileInfo(operations, filePath, context);
// 实际覆盖之前，与本次刚读取的 raw bytes 比较；只是 best-effort。
if (!await fileSnapshotMatches(operations, filePath, beforeBytes)) return {
  content: [{ type: "text", text: "File changed before writing; read its current state again." }],
  isError: true, failureKind: "invalid_input", executionState: "not_started",
};
```

- [x] A3：写真实批量编辑和诊断回归，观察失败。两处成功只写一次；第二处失败时保留整个原文件；预览与实际字节一致；字面替换、BOM/CRLF/hash/变化/无读权限均有独立断言。

```ts
const input = { file_path: target, edits: [
  { old_string: "alpha", new_string: "ALPHA" },
  { old_string: "beta", new_string: "BETA" },
] };
expect(await readFile(target, "utf8")).toBe("ALPHA\nBETA\n");
expect(preview?.after).toBe("ALPHA\nBETA\n");
// 失败诊断只能包含原文件原文，不能包含预演的 ALPHA。
expect(failed.isError).toBe(true);
expect(await readFile(target, "utf8")).toBe("alpha\nbeta\n");
```

- [x] A4：将替换计算搬入 edit-plan，execute 与 preview 调用同一入口，删除重复实现。匹配候选信息由 EditMatchError 附带；edit-feedback 只负责原文件上下文与固定上限，既不读文件也不重新跑整套 matcher。Edit 使用已有 atomicWrite，不自建事务。
- [x] A5：声明文件 serialGroup，补短工具说明与系统工具指导：长正文前检查、同文件 Edit.edits、跨文件 ApplyPatch、失败复用/按诊断修正，避免依赖修改混在并行调用里。
- [x] A6：范围验证：tools 的 read/write/edit/edit-replacers/preview/apply-patch/operations/新增 batch 回归，上轮 write-content-reuse 集成，attachment Read 测试；tools/prompts/server 受影响类型检查。记录失败再通过的证据。

### Task B：模型展示进度、批次调度与取消结算（子代理）

**Files:** core/types/events.ts、types/tools.ts、index.ts、engine/query-engine.ts、query-tool-permissions.ts、tool-result-feedback.ts；api/providers/openai.ts、anthropic.ts、codex.ts；agent-runtime/framework-agent-run.ts；相关新范围测试。

**Consumes:** §10.1 的固定事件与分组声明；既有参数准备、权限、失败记忆、内容复用。

**Produces:** 各 provider 展示进度，core 250ms 节流与完整提交保护，同批组内完整 prepare/permission/execute 链，真实 lifecycle、取消后完整结算；不改 tools 实现或 server/UI 文件。

- [x] B1：先补 provider 与 core 用模拟流的进度回归，观察缺失事件失败。ID 晚到、两调用交错、无 complete/坏 JSON/重试/取消仍不得提前执行；检查最终累计数、不暴露正文。

```ts
expect(events.some(e => e.type === "tool_generation_progress" && e.receivedChars > 0)).toBe(true);
expect(executed).toBe(0); // 流失败时
expect(JSON.stringify(progressEvents)).not.toContain("private generated body");
```

- [x] B2：在既有参数累积处发仅展示事件，QueryEngine 补生成身份并节流/末尾 flush；runtime 映射 domain.event，不能进入 toolActivity。能力定义与 provider 映射不传内部 serialGroup/inputReuse 给 API。
- [x] B3：先写组内顺序和取消结算回归：前项 prepare/deny/hook 失败后后项零确认零执行；实际失败同样停余项；其他组仍并行；修好前项不受未尝试项失败记忆封锁；A 已返回、B 取消时 A 输出仍在结果中。

```ts
expect(approvedTargets).toEqual(["first"]);
expect(executedTargets).toEqual([]); // first 被拒绝时
expect(secondResult).toMatchObject({ executionState: "not_started", metadata: { recoveryGuard: expect.any(String) } });
expect(cancelledBatchResults[0]).toMatchObject({ content: [{ type: "text", text: "already completed" }] });
expect(cancelledBatchResults[1]).toMatchObject({ failureKind: "interrupted" });
```

- [x] B4：按原 idx 将准备、确认与执行放进每个分组的顺序链；保留无组并行和原顺序结果提交。复用 authorizeToolCalls，不另写权限逻辑；按实际状态发 lifecycle。取消先结算完整批次再抛原取消原因，runtime 只放行已提交调用的结算事件。
- [x] B5：范围验证：provider 三种适配器及 input recovery、core 引擎/权限/失败记忆/内容复用/模型重试、runtime 映射/重试/取消；api/core/runtime 类型检查。无需真实供应商请求。

### Task C：现有状态投影与 Desktop 展示（子代理）

**Files:** server application/agent/daemon-agent-event-projector.ts、session/transcript-projection.ts；services/conversations/conversation-transactions.ts；desktop renderer conversation-page/transcript/transcript.tsx、message/assistant-message.tsx、message-render-model.ts；可新增一个小的纯 presentation helper，复用现有组件；相关测试。

**Consumes:** §10.1 事件/metadata 契约；Task B 的宿主事实。可以针对固定契约先测试投影，不依赖 Task B 提前改动自身代码。

**Produces:** 当前 Run 生成集合与已提交 Part 的真实阶段；终态/迟到/重启保护；现有 loading 与工具分组的可见中文标签。

- [x] C1：先写投影与 UI 派生回归，观察缺失行为失败。阶段 ID 绑定、旧 attempt 忽略、累计覆盖、终态清空、外部 metadata 不冒充、折叠标题可见、终态不 shimmer。

```ts
expect(run.metadata.toolGeneration).toEqual([expect.objectContaining({ receivedChars: 8192 })]);
expect(terminalRun.metadata.toolGeneration).toEqual([]);
expect(label).toContain("8,192");
expect(label).toContain("参数");
expect(isInFlight(failedPart)).toBe(false);
```

- [x] C2：专门处理两个既有 domain name，更新 Run/Part 并 publish 原有事件；进度不另存一份 raw domain 记录。以当前运行/生成身份拒绝迟到事件；工具 start 设 preparing/end 明确清理 toolProgress。恢复与收尾区分已知未启动和未知执行，保留已有返回事实。
- [x] C3：在现有 LoadingState 和 ToolActivityGroup 标题/行里派生文字，无新 store/panel；按真实 part 状态优先级控制动画，批量 Edit 行只显示修改数量，不虚报成功文件。
- [x] C4：范围验证：server projector/transcript/model retry、services restart recovery、desktop transcript/工具详情/消息派生/已有 git changes；server/services/desktop 类型检查，必要时用既有渲染测试验证组件。不重启应用。

### Task D：整条流程联测与交付（主代理）

- [x] D1：对照 §1 覆盖表核实每项，不因某一个 feature 通过就宣称全部完成。联测 info_only → 生成进度 → Write 失败 → content_from 修正 → 明确确认 → 执行 → 最终状态；另测同文件 Edit batch 与跨文件 ApplyPatch。
- [x] D2：按改动风险运行受影响范围及类型检查、`node scripts/check-docs.mjs`、`node scripts/architecture-boundaries.mjs`、`git diff --check`。Node/Vitest/TypeScript 使用已安装依赖；沙箱不能读取 node_modules 时按实际错误提权，不安装依赖或跑真实任务。
- [x] D3：只读子代理对统一 spec 和最终全部 diff 复审，主代理修订必要问题并重跑受影响检查。
- [x] D4：在本文件写入最终验证、剩余限制和运行版本要求；不自动提交/push/重启。

### 计划自检与任务边界

| 关联 | 生产/消费接口 | 检查结论 |
|---|---|---|
| A ↔ B | ToolDefinition.serialGroup；正常 file ToolResult/权限输入 | 声明由 B 加类型、A 加实际工具值，core 无文件逻辑 |
| B ↔ C | 两个固定 domain name、生成身份、phase/executionState | C 只投影当前宿主事实，不改变实际提交时机 |
| A ↔ C | Edit.edits 与真实成功结果 | C 只更新既有摘要，不把输入或失败预演算成修改 |
| A 内部 | 同一纯计算供执行与对外 preview | 无重复 matcher，失败回传原文件 |
| B 内部 | prepare/authorize/execute/取消结算 | 原 idx 不丢失；未尝试不进失败记忆；完整结果不被 phase 代替 |
| C 内部 | 生成集合、part 阶段、终态恢复 | metadata 完整替换，终态优先，不新增状态通路 |

## 11. 进度与验证记录

- [x] 完整流程只读追踪与统一 spec 初稿。
- [x] 子代理 spec 审核及必要修订。
- [x] 在同一文档追加统一实施计划并自检。
- [x] Task A。
- [x] Task B。
- [x] Task C。
- [x] Task D 与最终复审。

### 完成记录（2026-10-02）

所有第 1 节范围均已实现，模型/供应商比较及首次生成性能调整按用户要求未进行。

| 范围 | 实际验证 |
|---|---|
| tools/file 与整条文件流程 | 最终 11 个范围文件，234 项通过、1 项原有平台相关跳过；包含上轮正文复用、Read/Write、batch Edit、matcher、preview、ApplyPatch 与 operations |
| core | 10 个范围文件，150 项通过；含顺序链、前置失败阻断、失败记忆、真实阶段、节流、取消结算、重试与内容复用 |
| api | 7 个范围文件，98 项通过；三种 provider 本地模拟流，不访问真实供应商 |
| runtime | 映射、重试与 SDK 范围共 28 项通过 |
| server | 进度投影、transcript、model retry 范围 44 项通过；attachment Read 4 项通过 |
| services | 重启恢复筛选 5 项通过 |
| desktop | 最终 5 个范围文件 49 项通过；实际 loading 状态、折叠标题、终态动画、batch 摘要与 git changes |
| 类型 | core/api/runtime/tools/prompts/services/server，以及 Desktop web/node 全部退出 0 |
| 文档/边界 | check-docs、architecture-boundaries、git diff --check 通过 |
| 构建 | Electron main/preload/renderer 生产构建退出 0，输出在独立 task scratch 目录，未覆盖当前 out 或重启应用 |

新行为均先观察有效回归失败再实现，包括状态检查/并发快照、批量编辑/原文诊断、生成事件/分组取消、实际 UI 阶段及摘要。完整联测覆盖：Read.info_only → 生成展示 → 默认 Write 覆盖失败 → content_from 加显式 hash/overwrite → 确认 → 写入 → Edit.edits → 多文件 ApplyPatch。

子代理 `review_complete_file_workflow` 对完整生产 diff、新增实现和关键测试只读复审，结论通过，无需修复的 Critical/Important/Minor。确认未添加存储 schema、缓存、依赖或第二套 matcher，取消结算、权限和进度事实边界一致。

构建产物目录：`D:/code/personal-project/OpenHarness-ts/.superpowers/file-workflow-build-4174436e03bf46428ecae62d99765138`。构建有原项目的动态/静态 import、测试路由与大 chunk 提示，未为此扩大改造范围；SDK 测试仍有一次既有 Windows node-pty AttachConsole 提示，Vitest 退出 0。

### 实际简化与限制

- 只扩展现有 Read/Edit/Write，跨文件仍用已有 ApplyPatch；core 只按元数据调度，文件层不碰会话数据库，UI 不新增 store/panel。
- 预检查是模型可调用的只读能力，工具说明和提示明确使用条件；它不是强制票据，也不替代实际授权与写前检查。不能保证任意模型每次都会提前调用。
- 文件快照复核是 best-effort，不消除最后检查到 atomic rename 之间的 OS 竞争窗口；组内顺序仅覆盖当前响应，不加跨会话全局锁。
- Edit 单文件 batch 保证预演失败零写入；ApplyPatch 仍只承诺预演全有或全无，实际跨文件 I/O 失败保留部分结果，不声称回滚。
- 正文引用只依赖保留的会话历史；内容被压缩移除后会明确拒绝，不增磁盘草稿。
- 进度计量是累计参数字符，不是文件正文长度、百分比或供应商速度结论。
- 交付未提交的工作区代码和统一文档。用户正在运行的应用未重启，需运行包含本改动的新版本才能实际使用。

## 12. 新会话验收后的修订：生成工具卡与稳定诊断锚点

> 状态：修订 spec 已经子代理审核并修订，§13 实施计划已完成，验证记录见 §14；仍使用本文件。

### 12.1 证据与范围

会话 `65598b5f-ae63-4118-b389-145e20b2d4bc` 的 Write 请求阶段为 336,855ms，工具阶段为 1,006ms。07:00:33 已记录 Write 名称，07:05:32 才生成正式工具卡；后台共 144 次 Write 生成进度。用户确认 loading 可见，但这五分钟工具组没有 Write，体验不符合预期。

三次 Edit 未匹配把实际 `--line-strong: rgba(14, 26, 34, 0.42apsed);` 的数字改成 546、76/384、154/767 等。现有诊断只搜整行字面锚点，因整行抄错而 windows=[]；模型即使拿到 Grep/Read 原文仍再次抄错。另一次 old/new 相同是无效修改，不应建议再次读取全文。

本次修订只补用户可见性和有根据的定位反馈；不调查或调整首次生成性能，不选择模型/供应商，不自动把错误 old_string 匹配并应用。

### 12.2 生成中的工具组：只派生界面记录

保留 §7 的后台路径和执行边界。Desktop 使用现有 run.metadata.toolGeneration，派生临时的展示用消息/part，传入现有 AssistantMessage/ToolActivityGroup，不保存到数据库、client store、模型历史、工具活动或失败记忆。

- 仅当前 pending/running Run 的有效条目可派生；必须有非空 generationId、正整数 attempt、非空 toolKey/工具名、安全非负整数 receivedChars。不硬编码工具名白名单，最多沿用 32 条；重试通知存在时隐藏临时卡。
- 展示记录使用固定 UI 命名空间和 run/generation/attempt/toolKey 的稳定 ID，metadata 标记 `uiToolGeneration=true`，阶段 generating，执行事实 not_started。不冒充真实 toolUseId，不提供可执行 input/output。
- 所有工具名使用普通工具组展示，不把生成中的 Agent/ImageGeneration 交给实际执行后的专用面板。
- 已有本次 Run 的 assistant message 时附在其后；没有时仅派生一个稳定 ID 的 UI 消息容器，携带真实 sessionId/runId/inputId，seq 接在真实消息之后。只复制数组/对象供渲染，不修改原数据；临时容器撤销时不留下复制/分叉入口。
- 正式 tool part 的关联必须包含所属 message.runId、metadata.modelGeneration.generationId/attempt 和 call ID，并排除 superseded。有 ID 的临时条目按 ID 精确交接，不同 ID 和旧 attempt 不抵扣。
- 缺 ID 时不做同名计数推断：core 在整个模型流完成后才批量释放 tool_use_start，因此同次生成出现任何正式 tool part 即说明参数生成结束，可保守撤销该次全部无 ID 临时卡。正常迟到 ID 更新仍保持 toolKey 派生 ID，待正式 ID 交接。
- 生成期间工具组标题即使折叠也必须出现实际工具名（如 Write）、“生成参数”、累计字符和“未执行”。展开后明确参数尚未完整、工具尚未执行，不展示半截 JSON 或“等待执行结果”。
- 临时卡不计入文件编辑/命令调用/工具查看次数，也不计入 changedFiles；生成中的特殊工具同样适用。
- 完成/失败/取消/重试清理沿现有 metadata 实现，临时卡撤销，实际结算和重试提示照常显示；历史里不留下虚假的执行记录。
- loading 继续复用同一数据，没有新 store 或第二套事件。卡片是同一操作的界面交接，不承诺跨容器保持同一个 DOM 节点。

### 12.3 Edit 诊断锚点

匹配器和执行逻辑不变。edit-feedback 在整行字面锚点没有定位结果时，可从 old_string 提取至多两个确定的声明标识：CSS 属性、JS 的 const/let/var 赋值、JSON 的引号键。只识别声明中的名字和冒号/等号位置，不比较或修正值。

- 原文件里按完整名字和行首声明形状精确定位，不能以子串命中相似名字、明显的单行注释或变量引用。返回原有最多 3 个窗口、每窗口 7 行、总 4,096 字符的上下文；仍标为原文定位提示，matchCount 不伪造为成功匹配。
- 例如错误数字 546 时，`--line-strong` 能定位实际第 21 行，但工具仍拒绝此次 Edit，不自动应用 new_string。
- 没有稳定名字或原文件中没有对应声明时保持无锚点反馈，不报告最接近的猜测位置。
- 指导模型选用观察到的最短唯一 old_string，避免重新生成无关数值；这是工具使用说明，不是另一套自动编辑器。
- old/new 相同时给“没有修改意图，请直接继续或修正参数”的提示，不再默认建议 Read offset=1；不增加文件片段。
- 不能保证模型以后不会抄错，也不能用新提示声称编辑成功率已提升；以真实会话再验收。
- 这是逐行定位提示，不是语言语法分析：不解析多行块注释、模板字符串或复杂声明上下文，其中看似声明的行也可能成为提示窗口。它不证明语法声明存在，更不证明 old_string 匹配或可写；不为消除此限制引入解析器。

### 12.4 边界与必要验证

UI 改动仅 Desktop 派生 helper、transcript、message-render-model 和既有 ToolActivityGroup；诊断仅 edit-feedback 和工具说明/必要短指导。core/api/server/services/数据库保持原执行行为。

回归覆盖：卡片在真实调用不存在时显示 Write 和数量/未执行；稳定更新；迟到 ID、多同名调用交接不重复；无 assistant 容器、重试/终态清理；特殊工具只普通展示；不进入 changedFiles/真实消息状态；实际 JSX 在折叠标题和展开内容中可见。诊断覆盖本会话三种错误数字、其他属性/变量/JSON 键、找不到声明、窗口上限、权限不泄漏、identical 不要求再次读取，文件始终不被错误修改。

### 12.5 审核修订记录

子代理 `review_generation_card_amendment` 只读审核本节和相关实现；已纳入其建议：正式卡身份包含 Run 与生成代次、缺 ID 不做数量抵扣、临时卡排除执行次数与专用面板、不可变派生、终态/重试清理、完整声明名定位和 identical 专门提示。复核 core 的缓冲/完成后释放代码，确认无 ID 的同次生成收束规则成立。无需修改后台执行时机。

## 13. 修订实施计划

### Task E：生成中的工具组

**Files:** Desktop 的 message/tool-generation-presentation.ts（新增纯派生 helper）、transcript.tsx、message-render-model.ts、assistant-message.tsx 及范围测试。

- [x] E1：先在现有 transcript JSX 和工具详情测试里复现：后台已有有效 Write 生成条目，但折叠工具组没有 Write；展开内容不能说明未执行。运行并记录有效失败。
- [x] E2：实现不可变 UI 派生 helper；挂到本 Run 最后一个 assistant 消息，没有则派生容器。只有渲染消费结果；保留 loading 原路径，正式卡按 §12.2 身份交接，无 timer/store/cache。
- [x] E3：复用普通 ToolActivityGroup 显示生成态；折叠标题有原工具名/字符数/未执行，排除执行次数、专用工具面板和 changedFiles；展开用专门生成态文案，不显示半截 JSON。
- [x] E4：补 helper 边界测试：稳定更新、ID 晚到、混合有/无 ID、多同名、旧代次/旧 Run、superseded、没有容器、连续生成、重试、残留终态、无效条目和 32 条上限。运行 Desktop 受影响测试与 web 类型检查。

### Task F：有根据的 Edit 失败定位

**Files:** tools/file/edit-feedback.ts、edit.ts 的短说明、edit-batch.test.ts。

- [x] F1：先用本会话三种错误数字和原文件复现 windows=[]；增加其他 CSS/JS/JSON 声明、相似名字/引用/明显单行注释不命中、重复窗口上限与 identical 回归，观察有效失败。
- [x] F2：仅在原有字面锚点无定位时提取至多两个声明标识，并在原文件按完整名字/行首声明形状定位。保留现有匹配器和全部诊断上限；错误匹配仍零写入。
- [x] F3：identical 专门提示直接继续或修改参数；工具说明要求复制观察到的最短唯一片段、不重构无关值。无新 parser/依赖/自动纠错。
- [x] F4：运行 Edit/批量/preview 及权限范围测试、tools 类型检查。只读检查依然在诊断之前，不扩大文件权限。

### Task G：复审和交付

- [x] G1：子代理只读复审 E/F 改动，重点检查 UI 展示与真实执行隔离、身份交接、错误诊断无自动修改，以及是否有多余代码。
- [x] G2：运行 docs、架构边界和 diff 检查；按风险构建独立 Desktop 产物，不能覆盖当前 out 或自动重启/部署。
- [x] G3：将验证结果与限制补入本文件。未用真实供应商速度比较，也不承诺实际生成变快；仍需更新前端后进行真实会话验收。

## 14. 修订实现与验证记录（2026-10-02）

已实现生成中的普通工具卡，直接消费现有 Run 元数据，仅派生渲染记录。收到名字即可显示原工具名、累计参数字符数和未执行；正式提交时按身份交接。展开显示参数不完整/尚未执行，不展示半截 JSON。没有新事件、存储表、client store、缓存、计时器或后台执行入口。

Edit 只增加有限的行首名字定位提示，三个真实错误数字样例都能给出原文件第 21 行，matchCount 仍为 0，错误修改仍未写入。old/new 相同不再要求 Read；匹配器、文件保护和预演/执行路径保持不变。

| 范围 | 最终验证 |
|---|---|
| Desktop | 5 个范围文件，72 项通过：纯展示派生、真实 transcript JSX、工具详情、原活动状态和消息模型 |
| 文件工具 | Edit、batch、matcher、preview 共 4 个文件，105 项通过，含 sandbox 拒绝和 identical 策略检查 |
| 类型 | Desktop web、tools TypeScript 检查退出 0 |
| 文档/边界 | check-docs、architecture-boundaries、git diff --check 通过 |
| 构建 | Electron main/preload/renderer 独立生产构建退出 0，未覆盖当前 out 或启动应用 |

先观察到 2 项 UI 和 8 项诊断有效失败，再实现并验证通过。子代理最终复审发现单个 ImageToText 的旧标题特例会覆盖生成文字；新增 JSX 回归观察失败，限制特例只用于正式调用，再验证通过。审核同时要求准确记录逐行诊断不是完整语法解析的限制，已修订 §12.3；最终无必须修复的代码问题。

构建产物目录：`D:/code/personal-project/OpenHarness-ts/.superpowers/file-workflow-generation-cards-build-7841c73d35d34761a4c3444334be4d68`。构建仍有原项目的动态/静态 import 与测试路由提示，没有因此扩大改造。架构检查首次被沙箱的 pnpm 依赖读取限制阻止，使用已安装依赖提权重跑后通过，未安装依赖。

本轮未提交、部署或替用户重启应用；需运行包含修订的 Desktop 前端再用新会话验收。真实模型仍可能抄错，首次生成耗时没有优化，不能据范围测试宣称实际成功率或速度已提高。

## 15. 整体审核后的收口 Spec

> 状态：Spec 已经子代理审核并修订；实施计划见 §16，执行记录见 §17。用户已批准整体审核中的修正方向并要求全部处理。仍沿用本文件，不新增权限、重试、调度或状态管理框架。

### 15.1 范围与证据

本次包含整体审核的六项问题、系统目录路径别名附项及已确认的代码简化。保留前轮未提交改动，工作在 `codex/tool-workflow-audit-convergence` 分支；不搬移、清理现有工作区，不自动 commit/push/部署/重启。仍排除首次生成性能调参和供应商比较。

| 项目 | 已确认的行为 | 本次责任入口 |
|---|---|---|
| 批次异常收束 | 终态事件保存失败让 Promise.all 提前退出，其他工具仍运行，完整结果未留在历史 | core 工具批次与结果交付 |
| 冲突路径别名 | 权限选择 path，Write 选择 file_path；对象相同而目标不同 | 参数校验与权限路径入口 |
| Native 文件策略 | environment 分支只检查挂载，不落实 denyRead/denyWrite | 共用 sandbox-guard |
| 精确 replace_all | 连续空格/aaaa 的重叠候选导致原合法非重叠替换失败 | 共用编辑计算 |
| 收尾事实 | queued 明确未开始，却被普通失败收尾和诊断报成可能已执行 | 共享收尾事实与诊断 |
| 进度保存成本 | 240 次更新产生 240 个持久事件及全服务状态快照 | 既有 IncrementalOutput 临时发布 |
| 系统目录路径 | Windows 扩展路径和 .. 字符串绕过系统目录前缀判断 | 共用 file-mutation-guard |
| 重复代码 | 辅助模型尝试函数、无调用延迟、旧批量授权、无贡献 matcher、未使用字节留存 | 各原模块内复用和删除 |

### 15.2 参数与文件安全

归一化依旧只处理已明确声明的字段别名和单一 arguments 包装。规范字段与非业务别名冲突时返回 invalid_input/not_started，不任选一个值、不请求审批、不执行工具，也不让一个错误输入拖垮整个批次。工具 schema 显式声明的业务字段不自动改写。相同别名保持兼容；多层包装中的冲突同样拒绝。

anyOf/oneOf/allOf/$ref 等含混形状不做别名纠正或冲突猜测；保留既有结构校验，不能在逐分支校验时把另一个明确声明的业务字段误当别名。权限也不为组合声明猜测单目标别名，但所有实际路径的 deny 检查继续有效。无声明的直接内置工具调用与明确简单 schema 的冲突拒绝保持。

权限入口对自己支持的单目标路径别名拒绝冲突，避免直接调用权限检查时选错目标；实际授权携带宿主工具声明，让权限检查区分明确声明的独立业务字段与真正别名，不能让 core 合法的业务输入到权限层又被无条件拒绝。声明不能用于绕过真实目标的 deny 检查；既有 full_auto 和明确工具信任规则不擅自扩大或改写。文件工具的结构校验仍先于实际权限/执行。

路径规则比较规范后的实际目标，而不是输入里的 public/../private 拼写：用现有 cwd/pathStyle 和标准库处理相对路径、点段、Windows 分隔/大小写/本地 drive 扩展前缀；不改执行输入。目录规则与目标使用一致坐标，*.env 等前导通配规则保留跨目录匹配，URI 不当本地路径改写。路径规则保持 * / ? 通配和有序首条命中；命令规则的匹配语义不动。显式独立路径字段各自保留，但任一实际路径的 deny 不能被另一个路径的 allow/autoApprove 掩盖。

别名表只读取自有条目，constructor/toString 等合法业务字段不能触发继承成员调用或使整批抛错。

Native 的路径解析和挂载检查不能替代文件策略。共享 sandbox-guard 在执行环境路径解析之后，继续按 settings/cwd 检查读取或写入策略；Read/info_only 及需要原内容的 Edit/ApplyPatch 在读取被拒绝时不得 stat/hash/返回诊断原文，写入被拒绝时不得创建或修改。Write 保留既有“写策略已允许后探测目标存在/类型”的流程，新建不需要读取旧正文；已有文件的原字节/hash 仍必须在读取策略允许之后取得。WSL 已启用 sandbox 的不支持组合保持明确拒绝，不放宽配置限制。

系统目录 guard 保持纯路径判断，规范斜杠、大小写、点段与 Windows 本地 drive 扩展前缀后再比较。覆盖普通路径、扩展路径和 .. 路径；不新建文件访问服务，不承诺处理所有文件系统别名或消除 OS 竞争。

### 15.3 致命错误后的批次收束

工具参数准备、单项授权、同组排序和真实执行仍归 core。把旧 authorizeToolCalls 的无消费者批量形态收为单项授权，保留其检查、审批、钩子和取消语义。

工具阶段事件或 post hook 的致命错误不能吞掉，也不能触发模型网络重试。批次记住第一个致命错误，停止未启动调用并取消尚在等待的审批。审批实际使用的 execution.scope.signal 必须合成用户取消与批次取消，不能只给授权函数传一个新 signal；已启动工具继续使用原 run signal，按现有执行/超时机制结算，不能仅因另一工具展示事件失败就让批次提前返回。不能强制撤销已经发生的 OS 副作用，超时或外部取消时继续用 unknown 明示不确定性。

所有调用都得到 completed/not_started/unknown 的实际结果。整个批次的已知完整结果都必须在首个 tool_use_end yield 前保留到引擎历史，再按模型顺序交付，最后传播原致命错误。即使消费者的某次结果投递再次失败并关闭生成器，剩余可获得结果仍在引擎历史里；不伪称可靠持久保存成功。可靠事件写入失败仍须 fail-closed，不能仅因用户同时取消而吞掉；正常取消等待异常与真实可靠 emit 失败必须区分。正常用户取消路径继续保留已经返回的结果，不重跑工具。

执行后回调只处理实际启动调用，不把回调异常改写成已执行工具的错误输出。删除旧说明中“所有权限并行检查”的误导。

### 15.4 编辑计算与删除冗余

预览和执行仍使用同一 edit-plan/replace 入口。精确 replace_all 按从左到右非重叠的出现位置替换，并以字面方式插入 new_string；模糊策略继续拒绝重叠或歧义候选。保留 BOM/CRLF、批量预演失败零落盘、原文诊断和写前复检。

删除默认链已被前项覆盖的 IndentationFlexibleReplacer、MultiOccurrenceReplacer 及仅为这些无用内部策略存在的测试；保留实际行为的覆盖。ApplyPatch 删除仅保存但无人消费的 beforeBytes 字段，实际读取、hash 计算和冲突复核不动。

### 15.5 统一结果与收尾事实

明确区分工具是否成功与副作用是否已知：completed 可以携带执行失败；not_started 可以是成功 no-op；显式 unknown 不能仅因 isError 缺失就被作为成功证据或成功文件修改。收严该既有结果契约，不削弱失败记忆和同组保护。

文件修改摘要同时排除显式 not_started 成功 no-op 和 unknown；没有执行状态的旧成功记录保持兼容，不把“工具成功”直接当“修改发生”。

普通失败收尾与重启恢复复用一处纯事实计算，放在双方已经依赖的 protocol 会话模型层，不创建新状态机。准备/等待确认/排队为 not_started；已有返回阶段保留执行事实；没有可靠事实为 unknown。未开始的调用不使用 unknown_outcome，不虚构成功输出或覆盖已持久完整结果。诊断根据 executionState 判断“可能已执行”，旧无 executionState 的历史仍兼容既有未知判断。

Write 引用反馈写明正文存在于当前保留历史中，压缩/重建后引用可能失效；不再暗示 Stored 代表已经持久保存展开正文，不增加缓存或重复正文存储。

### 15.6 生成进度只更新既有临时状态

复用 IncrementalOutput 的临时事件方式，增加一个窄的 Run 工具生成进度更新：先校验、构造并成功分配临时事件，再同步更新现有内存 Run 的 toolGeneration，并返回不保留的 session.run.updated 事件；payload 必须独立于后续可变 Run。server 验证 Run/generation/attempt 后调用并直接 publish，不用 publishSince，不为每个字符计数进入全服务 atomic 或执行 SQL；不新增 store、数据库表、计时器或第二条事件类型。复用现有序号分配器，允许每预留 1024 个序号执行一次 SQL，不声称整个生成过程零 SQL。

客户端断线再连接读取当前服务快照，仍能拿到最新 Run 进度。Daemon 重启原本就会中断活动 Run 并清掉进度，因此无需持久保存每个生成 tick。正常 durable Run 更新可能顺带保留一份当前快照，这是有界且允许的；retry/attempt finished/终态清理仍走已有可靠事务。

普通可靠事务失败回滚不能抹掉该事务开始前已接受的临时进度；临时更新本身不标记 Run/session 为待持久化。

保留 core 现有每工具 250ms 节流和末尾 flush、最多 32 条的限制；不为消除 SQL 成本再建立 Run 级队列。临时事件有正常序号但不进入可回放历史，断线恢复沿用已有快照同步。

### 15.7 简化辅助代码与边界

- 辅助模型调用复用现有 createAttemptSignal/describeModelFailure/attemptFinishedEvent；主生成实时展示与辅助调用整段缓冲仍分开，不合成通用重试引擎。
- 删除 api/providers/retry.ts 无生产调用的 abortableDelay，保留连接/空闲超时管理；公开 retryWithBackoff 不因仓内无调用而擅自移除公共导出。
- 删除 ToolFailureMemory.recordFailure 无用途的 _fingerprint 参数及旧测试传参。
- 删除 createEnvironmentFileSystem 未使用的 options 与仓内两处无效传参；保留实际选择 Native/WSL 的 environment 参数和公共函数导出。
- 生成 metadata 的校验在实际共享需要明确时复用现有协议读取模式；loading 可以显示未知工具名，工具卡必须有已收到的名字，不强行把两者要求混成一份严格条件。
- 所有生产修改先有可观察的失败回归；删除纯冗余代码保留行为测试，不用测试断言源码字符串或已删除符号不存在。

### 15.8 验收与不变项

权限/结构冲突不触发任何文件副作用；Native Read.info_only/Read/Edit/Write/ApplyPatch 真实环境分支都遵守对应文件策略。Windows 路径别名不绕系统目录保护。

真实事件总线的终态 sink 失败不会在其他可完成工具尚未返回时结束批次；未启动调用零执行，所有可获得结果保留，最终仍报告原错误。post hook 异常和用户取消也有结果保留回归。

精确 replace_all 的 aaaa/连续空格恢复原语义；模糊重叠仍拒绝。queued 收尾不会触发“可能已经执行”的诊断，显式 unknown 不算成功文件修改。

240 次进度更新可见最新字符数，但不会产生 240 个 retained/durable 事件或 240 个全状态事务；重新连接、旧代次、重试与终态清理仍正确。

全部范围测试、受影响类型、架构/文档检查与独立构建作为交付证据。没有供应商速度承诺、全局文件事务或磁盘草稿；不清理用户未提交改动。

### 15.9 Spec 审核修订

子代理 review_audit_convergence_spec 只读审核方案与实际代码，结论可实施。已纳入：审批合成 scope.signal、首个结果 yield 前保存整个批次、区分致命事件错误与普通工具错误、取消并发不吞可靠失败、1024 序号预留的稀疏 SQL、临时事件先构造/分配再修改状态与 payload 隔离。无需新事件、状态机或存储层。

## 16. 整体审核收口实施计划

> 执行方式：按任务使用 subagent-driven-development 的实施和独立审核；本节与 §17 是统一计划和账本。用户要求一个文档且当前改动未提交，因此不生成第二份权威 plan，不自动 commit，审核以当前工作区的任务范围 diff 和实际代码为准。

**Goal:** 修正六项整体流程问题及路径保护附项，删除确认无贡献的重复代码。

**Architecture:** 参数、安全、工具批次、文件计算与状态保存各自回到已有职责入口。只新增双方有实际消费者的窄纯函数/临时更新方法，不创建框架或后台队列。

**Tech Stack:** 现有 TypeScript、Node、SQLite、React、Vitest；不安装新依赖。

**Spec:** 本文件 §15。

### Global Constraints

- 保留前轮和用户的未提交改动；在 codex/tool-workflow-audit-convergence 上收口，不自动 commit/push/部署/重启。
- 不调查或调整首次生成性能，不比较供应商，不新增数据库表、全局锁、重试服务、进度 store 或计时器。
- 行为修改先写能复现问题的回归，观察有效失败，再实现；纯删除/复用在已绿的行为测试下重构，不捏造源码文本测试。
- 每个任务完成后有独立的 Spec/代码质量审核；最终再审全流程。任务不可同时改同一文件。
- 正常取消、权限保护、失败记忆、内容复用与已知结果不能被简化掉；未执行与未知副作用必须明确区分。

### Task 1：参数目标与文件安全收口

**Files:** core/engine/tool-input-schema.ts 与测试、core/types/permissions.ts、engine/query-tool-permissions.ts 的宿主声明传参；permissions/index.ts 与测试；tools/file/sandbox-guard.ts、file-mutation-guard.ts、对应文件与环境范围测试。operations 的无用途 options 清理留到 Task 6，不能擅自移除公共环境参数。

**Consumes:** 现有 schema 别名、permission pathRules、ExecutionEnvironmentHandle、sandboxPathDecision。

**Produces:** 冲突输入的单项 invalid_input/deny；Native 文件策略和系统目录路径判断。不改工具业务形状或 core 调度。

- [x] 1.1：先补并运行回归：冲突 file_path/path/filePath、多层包装、相同别名、显式业务字段；真实环境分支的 Read.info_only/Read/Edit/Write/ApplyPatch 拒绝，读取拒绝零原文/hash，写入拒绝零落盘；Write 读拒绝/写允许时新建兼容且已有文件不读原字节/hash；Windows 扩展 drive 和 .. 系统目录。

```ts
expect(validateToolInput(schema, normalizeToolInput(schema, { file_path: privatePath, path: publicPath }))).not.toBeNull();
expect(await checker.checkTool("Write", { file_path: privatePath, path: publicPath })).toMatchObject({ action: "deny" });
expect(await sandboxPathError(target, cwd, "read", deniedSettings, nativeEnvironment)).toContain("Sandbox");
expect(isSystemPath(String.raw`\\?\C:\Windows\blocked.txt`)).toBe(true);
```

- [x] 1.2：在现有校验/权限路径入口拒绝冲突，不把整个批次变为 throw；明确声明的业务字段不做别名替换。共享文件 guard 叠加挂载约束与 Native 策略；系统 guard 只规范路径形状。

  修正轮补充回归：真实 engine + PermissionChecker 的显式多业务路径及同值未声明别名；实际规范目标的相对/绝对点段拒绝、Windows/URI/glob/有序规则兼容；JSON 解析出的 constructor/toString 业务字段合法且不抛异常。
- [x] 1.3：权限/schema、Read/Write/Edit/ApplyPatch 与环境范围测试转绿；core/permissions/tools/sandbox 类型检查。记录红绿命令和实际输出。
- [x] 1.4：独立审核 Spec 与实现、安全分支和兼容性；按意见修正，不扩大权限语义。

### Task 2：工具批次异常收束与单项授权

**Files:** core/engine/query-engine.ts、query-tool-permissions.ts、tool-workflow.integration.test.ts、integration/model-retry 范围；必要的 agent-runtime/framework-agent-run-retry.test.ts。

**Consumes:** Task 1 的有效参数、现有执行超时/可靠 emit、AgentExecutionContext.scope.signal。

**Produces:** 每批完整结果与首个致命错误；单调用授权。可以让 executeTools 的私有返回改为 `{ results, failure?: { error } }`，唯一调用者先保存全批历史，再 yield，最后抛 failure.error。

- [x] 2.1：先补真实 AgentEventBus 的回归并观察失败：fast 终态 sink 失败时 slow 仍等待，批次不能先结束；同组后继零执行；待审批收到取消；pre/running/terminal emit 错误原样传播；post hook 失败不丢结果；取消并发的真实存储错误不吞；消费者首个结果投递失败后全批历史还在。

```ts
expect(settledWhileSlowStillWaiting).toBe(false);
expect(waitingPermissionScope.signal.aborted).toBe(true);
expect(startedToolContext.runAbortSignal.aborted).toBe(false);
expect(engine.getHistory().filter(message => message.type === "tool_result")).toHaveLength(2);
expect(failure).toBe(originalDeliveryError);
```

- [x] 2.2：批次记录首个致命错误，合成仅用于启动/审批的 signal，已启动工具仍用原 run signal。先收束全部 task，再保存全部可获得结果；可靠错误保持 fatal，普通工具失败/超时仍返回现有反馈。正常取消仅取消等待，不拿“已取消”当吞可靠错误的条件。
- [x] 2.3：把 authorizeToolCalls 改为单项授权；去掉批量 Promise.all/数组回填与过时注释，保留拒绝、批准、pre hook、取消规则。不得新增 scheduler/service。
- [x] 2.4：运行 core 执行/重试/权限/取消范围及 runtime 相应回归、core/runtime 类型检查；独立审核收束顺序和安全规则。

### Task 3：恢复精确替换语义与文件冗余删除

**Files:** tools/file/edit-replacers.ts、edit-plan.ts（需要时）、apply-patch.ts，edit-replacers/edit-batch/preview/apply-patch 范围测试。

**Consumes:** 已统一的文本计算与现有模糊候选。

**Produces:** 精确 replace_all 的非重叠字面替换；精确、模糊、preview、execute 仍一个入口。

- [x] 3.1：先补 aaaa/连续空格/dollar 字面替换回归，观察当前 ambiguous；保留模糊重叠拒绝、BOM/CRLF、batch 原文诊断。

```ts
expect(planTextEdits("aaaa", { old_string: "aa", new_string: "bb", replace_all: true }).content).toBe("bbbb");
expect(planTextEdits("    let x = 1;\n", { old_string: "  ", new_string: "\t", replace_all: true }).content).toBe("\t\tlet x = 1;\n");
```

- [x] 3.2：精确出现使用非重叠位置，模糊位置继续重叠 guard；不恢复第二套业务执行器。删除无贡献内部 IndentationFlexible/MultiOccurrence 及仅针对死策略的测试；删 PatchChange.beforeBytes，保留局部读取/hash。
- [x] 3.3：Edit/batch/matcher/preview/ApplyPatch 范围、tools 类型检查；独立审核精确兼容与误写边界。

### Task 4：统一执行事实、收尾与诊断

**Files:** protocol/src/session-model.ts/index 导出与测试；server/session/transcript-projection.ts、control/run-inspector.ts；services/conversations/conversation-transactions.ts；core/tool-result-feedback.ts/query-engine.ts（结果归一）；Desktop message-render-model 的未知结果摘要与相应测试。

**Consumes:** 现有 toolProgress/ToolResult、Task 2 的完整结算。

**Produces:** 一个双方使用的纯收尾计算；显式 unknown 不成为成功证据/修改文件摘要。task Run 的结束状态不等于工具执行事实。

- [x] 4.1：先补 queued/not_started 普通失败与重启一致、已返回事实保留、未知结果不算成功证据、旧历史诊断兼容、Desktop unknown 不出“已编辑文件”的回归，观察失败。

```ts
expect(closedQueuedPart.metadata.executionState).toBe("not_started");
expect(inspection.warnings.some(warning => warning.code === "unknown_tool_outcome")).toBe(false);
expect(collectChangedFiles([legacyUnknownPart])).toEqual([]);
```

- [x] 4.2：protocol 层共享准备/返回/未知的收尾推导，不虚构成功正文；server 与 services 删除各自重复映射。明确 unknown 不因 isError 缺失而成功；诊断优先实际执行状态，缺失状态的旧 unknown_outcome 仍告警。展示只改既有状态文案/摘要保护，不新组件。
- [x] 4.3：protocol、server projection/inspector、services restart、core workflow/失败记忆、Desktop 消息/详情范围与受影响类型检查；独立审核实际事实、旧记录兼容和模块依赖。

### Task 5：生成进度退出持久历史与全状态事务

**Files:** services/conversations/incremental-output.ts 与测试；server/agent/daemon-agent-event-projector.ts/tool-progress-projection.test.ts；必要的 client sync/状态范围测试。

**Consumes:** 现有已校验 Run/generation/attempt、现有临时事件分配和发布。

**Produces:** IncrementalOutput.updateRunToolGeneration(runId, entries) 返回独立的 SessionEventRecord（session.run.updated）；只改现有内存 Run，不标记 SQL mutation，不自造序号。server 直接 publish 返回事件。

- [x] 5.1：用实际服务与投影回归观察失败：240 次同工具进度，最新数可见，但 retained event/Run dirty mutation/atomic 次数不随 tick 增长；序号预留正常；事件 payload 不被后续修改污染；断线重连当前快照、可靠事务回滚后的先前进度、retry/终态/迟到事件仍正确。

```ts
expect(store.runs.getRun(runId)?.metadata.toolGeneration).toEqual([expect.objectContaining({ receivedChars: 240 })]);
expect(retainedProgressRunEvents).toHaveLength(0);
expect(fullStateTransactionsDuringTicks).toBe(0);
expect(firstLiveEvent.payload.run.metadata.toolGeneration).toEqual([expect.objectContaining({ receivedChars: 1 })]);
```

- [x] 5.2：在既有 IncrementalOutput 加窄更新，先构造/分配成功再改内存 Run；不新增 timer、queue、cache、table。替换 projector 单个 tick 的事务路径；普通可靠清理保留。
- [x] 5.3：services incremental/store、server tool-progress/retry、client sync/恢复范围、services/server/client 类型检查；独立审核临时/可靠事实和事件序号边界。

### Task 6：辅助复用、遗留清理与全流程交付

**Files:** core/engine/buffered-model-retry.ts、query-model-attempt.ts、tool-failure-memory.ts 与测试；api/providers/retry.ts 与测试；core/tool-input-reuse.ts 短提示；tools/file/operations.ts 与 agent-runtime/agent-composition.ts、server/runtime/session-execution-environment.ts 无效传参；本文件执行记录。

**Consumes:** 现有 createAttemptSignal/describeModelFailure/attemptFinishedEvent；前述任务的最终行为。

**Produces:** 删除辅助尝试重复实现、未用延迟/参数；准确的当前历史复用说明。没有第二套重试策略。

- [x] 6.1：在已有辅助重试/预算/取消/用量范围下复用主尝试辅助函数；若统一取消结算行为发生变化，先补取消不是 failed 的有效回归。删除 abortableDelay 及仅测试死函数的部分，删除 _fingerprint 旧参数。

  删除 createEnvironmentFileSystem 未用 options 与两处传参；保留公共导出及 environment 的实际职责。
- [x] 6.2：引用提示明确“当前保留历史中可用，恢复或压缩后可能失效”；不存第二份正文。生成 metadata 读取条件不同的部分保持明确，不新增大而全校验层。
- [x] 6.3：运行辅助模型、主生成重试、内容复用、API timeout 范围和 core/api 类型检查；独立任务审核。
- [x] 6.4：全流程子代理复审；按实际风险补联测。运行受影响类型、check-docs、architecture-boundaries、diff 检查及独立 Desktop 构建，不重复完整无关测试、不更新当前 out。
- [x] 6.5：本文件补覆盖/测试/剩余限制、实际删减与取舍；不 commit/push/部署/重启，不删除任务证据或用户改动。

## 17. 收口执行账本

### 启动与计划自检

| 任务/关系 | 检查 | 结论 |
|---|---|---|
| Task 1 | schema/权限/文件策略与测试对应 | 拒绝冲突，不任选目标；文件保护仍在 tools |
| 1 → 2 | 有效参数 → 授权/执行 | 顺序实施，2 不重写归一化 |
| Task 2 | 私有批次返回与唯一调用者 | 结果先保存全批，再交付，最后 fatal；审批 scope 与执行 signal 分开 |
| 2 → 4 | query-engine 结果事实 | 顺序实施，4 只归一结果，不改 2 的收束 |
| Task 3 | 精确/模糊与 preview/execute | 保留单入口及字面插入，删 dead matcher 不改变活策略 |
| Task 4 | protocol → services/server/UI | 共享纯事实，无 core↔services 倒置依赖 |
| 4 → 5 | server projector/终态清理 | 顺序实施，5 只替换 tick 保存路径 |
| Task 5 | services 状态 → 临时 event → client | 事件先分配、payload 隔离；沿用序号、快照恢复与可靠清理 |
| Task 6 | core/api 共享与公共导出 | 仅删内部死代码，保留公开 retryWithBackoff |

- [x] 已读整体审核证据、当前调用链与任务相关技能。
- [x] Spec 子代理审核及修订。
- [x] 同文件计划与接口/文件关系自检。
- [x] Task 1 完成与审核。
- [x] Task 2 完成与审核。
- [x] Task 3 完成与审核。
- [x] Task 4 完成与审核。
- [x] Task 5 完成与审核。
- [x] Task 6 完成、全流程审核与交付。

### 执行取舍

- Ruling: 保留当前 checkout 的未提交前轮改动，在新 codex 分支实施，不另建 worktree或自动提交 — 本次修正直接依赖工作区全部未提交功能 — 若理解有误，可在未提交状态下调整，不搬移或丢弃用户数据。
- Ruling: 统一文档同时承载 spec/plan/ledger，任务审核用工作区 diff，不要求提交范围 — 用户要求一处文档且未授权提交 — 成本是审核必须区分前轮基础和本轮任务；最终全流程复审覆盖整条路径。
- Ruling: 高频进度为现有 Run 的临时内存事实，不强制每 tick durable — 客户端重连可读当前快照，Daemon 重启原本中断 Run — 成本是重启后不保留最后字符计数，实际结束/工具结果仍可靠保存。
- Ruling: 正常取消不能掩盖可靠事件异常，测试须模拟真实总线与普通观察者的不同职责 — 两者的错误不能同样当“展示关闭” — 成本是用户取消并发存储故障时仍报告故障，不伪称安全结束。
- Ruling: 元数据读取的展示要求不同，不为统一而新增宽泛解析平台 — loading 可接受未知名字、工具卡需要名字 — 成本是保留少量目的不同的校验，不能让它们各自定义执行事实。
- Ruling: 不把 denyRead 拓宽为禁止已获写策略许可的 Write 存在/类型探测 — 既有创建流程允许不读旧正文的新建，读写策略独立 — 成本是写权限仍允许必要的存在性探测，但不能读取或返回受拒旧正文/hash；若要禁止此探测，需单独明确不同的权限语义。
- Ruling: Task 1 在现有权限检查接口传递可选宿主 schema，不新建工具声明注册表 — 独立审核确认仅在 core 保留业务字段还不够，权限层也需相同声明依据 — 成本是一个可选参数和一个实际传参入口；旧两参数实现继续兼容，任务 2 的单项授权保留该参数。
- Ruling: 在同一权限入口规范路径规则的实际目标 — 内存复核证明 public/../private 与 canonical private 仍得到不同决策，这是目标一致性同一根因 — 成本是少量标准库路径处理；支持的 * / ? 路径通配保持明确，命令匹配不动，不建立资源解析平台。
- Ruling: 将 Task 1 已明确留给 Task 6 的 operations 未用 options 清理补入 Task 6 的文件表与验收 — 原计划漏列，但已授权简化不能静默丢失 — 成本是导出函数的无效可选参数消失，仓内两个调用点同步；实际 environment 参数、公共导出和文件操作行为保留。
- Ruling: Task 5 允许现有 TransactionCoordinator 回滚保留 storage.state 根对象身份，以 Object.assign 恢复固定字段 — 有效真实回归证明回滚后序号分配器仍持旧 state，使后续临时事件 cursor 不前进，这是规定的 rollback/序号验收直接缺口 — 成本是一行恢复方式变化，需要 coordinator/event-sequence 范围验证；不改变 allocator、1024 稀疏 SQL 或创建新存储层。

### 任务记录

Task 1: in_progress — implement_audit_task_1 先补失败回归，再修共享参数与文件安全入口。源码起点是当前未提交工作区，原文件副本保存在忽略的 `.superpowers/sdd/audit-convergence/task-1-base/`，独立审核以该副本比较本任务增量，不把前轮改动当本轮实现。

Task 1: fix round 1/5 — 原实施 20 文件/300 项通过，但独立审核发现权限层对显式业务路径字段的无条件拒绝。尚未标记完成；原实施代理正在补真实权限端到端回归并收口宿主声明传递。

Task 1: fix round 1/5 补充 — 同责任入口的规范路径决策及别名表继承键问题已先复现再修正；最终按本轮完整增量再审核，不以先前绿测替代修订后的验证。

Task 1: fix round 1/5 兼容补查 — allOf 分支各自声明 file_path/path 时 core 误报别名冲突；anyOf 单分支明确两字段时 core 合法但权限仍拒绝。已以内存输入复现，继续停止组合结构的别名猜测并补端到端回归，不引入组合 schema 解析框架。

Task 1: complete — 修正轮 1 独立复审 Spec 符合、代码质量 Approved，无未决问题。累计 348 项范围测试；最新 core 70、permissions 66，四包类型检查通过；主代理另以内存复核确认简单冲突拒绝、规范 private 路径拒绝、allOf 业务字段允许及私有业务候选拒绝。未提交。

Task 2: in_progress — 下一步实施工具批次异常收束和单项授权，保留 Task 1 的宿主 schema 传参。

Task 2: RED — 真实 AgentEventBus 与内存工具的 25 项范围中 10 项有效失败，覆盖终态提前退出、前置可靠 emit 被吞、全批历史丢失、取消并发吞存储错误、post hook 丢结果和消费者关闭后的剩余历史。普通观察者错误已用真实总线隔离语义验证，不再把观察者抛错模拟成可靠投递失败。

Task 2: review_pending — 实施报告记录 core 146、runtime 16 项覆盖通过，core/runtime 类型检查通过；增量仅 query-engine/query-tool-permissions 及两份 core 测试。任务起点副本生成 task-2-review.diff，由独立 review_audit_task_2 审核收束、可靠错误与授权边界；尚未勾选完成。

Task 2: complete — 独立审核 Spec 合规、Task quality Approved，无 Critical/Important/Minor。审核核对真实总线 sink/observer 语义与改名调用点；RED 时间顺序由本账本先前记录及实施报告支撑。审批宿主遵守 scope.signal 属于既有合约，内存实际审批取消回归覆盖本次交付信号；不为不遵守合约的第三方新增 timer。core 146、runtime 16 项与两包类型通过，未重复同代码完整测试；未提交。

Task 2: unchanged-host check — 协调员只读核对 daemon-application.ts:511 的真实 requestPermission，把 effect context.signal 传给现有 permissions.ask；审批取消仍经过现有宿主入口，不需要新适配服务。

Task 3: in_progress — 任务起点源码与文件工具测试已保存在 task-3-base；下一步恢复精确非重叠替换并删除无贡献内部策略和字节留存。

Task 3: RED — edit-replacers/edit-batch 定向 82 项中新增 7 项有效失败、75 项通过；四项 plan 回归返回 ambiguous、三项 preview 返回 null。精确 replace_all 的重复字面与连续空白确实被误判，模糊重叠保护和单次歧义测试仍保留。

Task 3: review_pending — 最终 7 文件 161 项文件工具范围通过，tools 类型检查通过。增量 4 文件：精确出现位置前进、删两种无贡献内部策略、删 PatchChange.beforeBytes 字段、补 plan 与 preview/execute 行为回归；独立 review_audit_task_3 正在审核，未以测试绿替代 gate。

Task 3: complete — 独立审核 Spec 合规、Task quality Approved，无 Critical/Important/Minor。审核确认删除策略的结果已被前置活策略覆盖、模糊重叠仍拒绝、preview/execute 共用计划及 hash/写前复核保留；161 项范围与 tools 类型检查通过。git 状态仍是原未提交分支，未执行提交/部署，其他任务基线保留。

Task 4: in_progress — task-4-base 保留 protocol/core/server/services 与 Desktop 所需源码测试起点；共享收尾事实与 unknown 成功保护进入实施。

Task 4: boundary check — 已定位普通失败与重启的分歧：queued 被普通失败映成 unknown_outcome，重启则 interrupted；已返回阶段的已有 failureKind/outcome 也被运行终态覆盖。按 Spec 由 phase/executionState 统一推导，不虚构正文；Run 终止展示与工具是否启动/返回继续分开，not_started 成功 no-op 和 completed 执行失败保留。

Task 4: summary check — 主代理指出同一契约还需把显式 not_started 成功 Write no-op 排除“已编辑文件”摘要；与 unknown 同一个既有保护入口补派生回归，保持无状态旧成功记录兼容，无新增框架或范围扩张。

Task 4: RED — 实际定向回归：server 5 失败/31 通过（queued 错报未知、returned 事实被覆盖、诊断优先级），services 1 失败/51 跳过（returned 事实重启丢失），core 3 失败/28 跳过（显式 unknown 被当成功且解锁失败重试），Desktop 5 失败/18 通过（unknown/not_started no-op 误列文件修改）。沙箱 EPERM 不计失败证据；同路径已安装 Vitest 经自动审查后观察上述断言失败。

Task 4: first_check — protocol 22、server 47、services 52、core 36 项通过；Desktop 48 通过/1 失败源于新测试缺 toolUseId，先修真实关联 fixture。自审发现摘要应以最新返回 result 的明确 executionState 优先旧 call 状态；补有效 RED 后只重跑 Desktop 改动覆盖，尚未完成审核或类型检查。

Task 4: self-review regressions — Desktop 最新 completed 结果优先旧 not_started/unknown 的 2 失败转 51 通过；inspector 缺失/null/无效状态旧记录兼容 2 失败转 10 通过；protocol 已返回 unknown 工具的 failed outcome 保留 1 失败转 23 通过。协议修订后 server projection/inspector 38 项已重测；类型检查执行中，仍等待独立 gate。

Task 4: review_pending — 最终有效范围合计 212 项（protocol 24，server 38 + 未改进度 11，services 52，core 36，Desktop 51）；五处类型检查通过。另补明确 not_started 与旧 unknown_outcome 冲突的有效 RED/GREEN；独立 review_audit_task_4 检查共享纯函数、历史兼容、摘要结果优先级与 Task 2 批次边界，尚未勾选完成。

Task 4: fix round 1/5 — 独立审核 Spec 不符合、Task quality Needs fixes，Important：Desktop 最新 result 的旧 unknown_outcome/outcome=unknown 标记被旧 call 的明确 completed 抢先覆盖；实际函数最小复现两项均返回 completed。原 worker 先补两种 legacy 返回事实的有效 RED，再修按来源新旧解析的优先级；task-4-fix-1-base 保留审核时 Desktop 源码测试，未前进 Task 5。Task 2 保存顺序由既有 Approved 与本任务仅一行归一差异确认；引用文案由 Task 6 负责。

Task 4: fix round 1/5 complete — 4 项真实派生 RED 转 Desktop 56 项 GREEN、web 类型/diff 检查通过；独立 scoped 复审 ADDRESSED，Spec 符合、Task quality Approved，无新 Critical/Important/Minor 或范围外观察。新 result 的有效状态/legacy 未知先于旧 call，同一来源有效状态优先，旧成功/no-op/未知兼容覆盖均保留。

Task 4: complete — 最终不同有效范围 217 项（此前 212 的 Desktop 51 更新为 56），五处类型检查通过；一轮审核修正后无未决问题，共享纯事实放 protocol、server/services 删除重复推测、core 未知不解锁失败记忆，未修改 Task 2 批次顺序。引用文案留 Task 6，未提交。

Task 5: in_progress — task-5-base 保留既有 incremental/projector 与服务/客户端范围起点，下一步将生成 tick 移到独立 payload 的现有临时事件，可靠清理路径不变。

Task 5: RED — 真实 server 投影 13 项中 2 项有效失败：240 tick 的 retained session.run.updated 预期 0、实际 240；重连已获最新快照，但遗漏 tick 仍被保存进历史。services 15 项中 3 项因窄更新入口未实现而失败、12 既有行为通过；网络/依赖沙箱错误不计 RED，同路径已安装 Node/Vitest 经自动审查取得实际断言证据。

Task 5: rollback RED — 新增真实可靠事务回滚后的 tick 快照 cursor 断言 expected 6/received 5；此前进度本身保留，但 allocator 与被替换的根 state 分离。协调员只读核对 transaction-coordinator.ts:104 和 event-sequence 的 state 持有/restore，裁定最小恢复方式修正；允许文件起点已补存 task-5-base。

Task 5: review_pending — services 93/server 21/client 11 项与三包类型检查通过；240 tick 不产生 retained Run 事件/atomic/dirty mutation，最新 240 与第一事件 payload=1 可见；2048 tick 实际仅 2 条序号预留 SQL，连续 rollback 后 cursor/进度与可靠清理回归覆盖。增量 5 文件（生产 3），独立 review_audit_task_5 重点核对根身份恢复和临时/可靠边界，尚未勾选完成。

Task 5: complete — 独立审核 Spec 符合、Task quality Approved，无 Critical/Important/Minor。审核确认固定字段完整恢复、allocator next/reservedThrough restore、另一 state 替换路径会重建 allocator、retain=false 接线；125 项范围与三包类型检查通过。协调员补读不变项：query-engine 保留 250ms 节流/末尾刷新，conversation-transactions 重启恢复仍可靠更新 Run 为 interrupted 并 toolGeneration=[]；最终全流程再覆盖这些接口，不声称进程重启保留临时进度。

Task 6: in_progress — task-6-base 已保留辅助尝试/失败记忆/引用提示/API 延迟和未用环境 options 的起点；下一步局部复用删除与最终交付验证，不改当前 out。

Task 6: 6.1–6.3 review_pending — 有效 RED 3 项：辅助调用无/有用量取消被记 failed、引用反馈缺当前历史边界；最终 143 项通过、1 项 Windows 平台跳过，core/api/tools/runtime/server 五包类型通过。11 文件增量净删 59 行，生产源码净删 105 行；辅助 helper 复用、dead 延迟/参数/环境 options 与两调用清理已实施。独立 review_audit_task_6 正在审核；6.4/6.5 仍由协调员继续。

Task 6: 6.1–6.3 approved — 独立审核 Spec 合规、Task quality Approved，无 Critical/Important/Minor；共享 helper 的预算/信号/用量、主实时/辅助缓冲区别、删除调用点和公共导出已核对。平台 POSIX mode 跳过作为明确限制，6.4/6.5 未完成。

Task 6: final_checks — 协调员实际执行 check-docs（371 文档）、architecture-boundaries（122 既有扁平调用）、22 个边界契约测试、git diff --check 均通过；默认沙箱 TypeScript 解析错误经同命令读依赖升级后消除，非源码失败。跨任务联测 services 收尾/重启 52 项、实际工具/引擎/内容引用 5 项通过，验证 Task 4 ↔ Task 5 回滚及 Task 1/2/3/6 文件路径交界；Desktop 主进程类型及独立构建继续。

Task 6: independent_build — Desktop 主进程类型、工作区依赖边界检查 exit 0；electron-vite build --outDir 指向全新 `.superpowers/sdd/audit-convergence/desktop-build-final-20261002`，main/preload/renderer 均构建完成、exit 0，未覆盖 out 或启动应用。保留构建的既有提示：prompt-segments-assembly 动态/静态混用不分 chunk、pet.test.ts 无 Route 被忽略、独立输出目录不自动清空；无致命错误，不扩大本次工作去改这些无关配置。全流程审核仍等待最终双 verdict。

Task 6: final_review approved — review_audit_final_flow 只读核对四组完整未提交生产 diff 和实际调用入口：参数/权限/Native guard、共同编辑计划、批次异常/完整历史/运行取消、共享收尾/诊断/最新历史事实、临时进度/回滚序号/重连/重启、内容引用/辅助模型取消与用量。Spec 合规 Approved、整体质量 Approved、Ready-to-deliver Yes，无 Critical/Important/Minor，无需额外修正波次。未重复任务套件。

Task 6: complete — 6.1–6.5 全部完成，任务 gate 和最终全流程审核闭环；独立 Desktop 构建、受影响类型、文档/边界/diff 和风险对应联测均有实际证据。保留当前 `codex/tool-workflow-audit-convergence` 未提交工作区，HEAD 仍为 `8096d345f63235acf0a206f39d4a0c238a3f251d`；未提交/push/部署/重启，未访问真实模型或用户数据库，未删除 scratch 证据或用户改动。

### 本轮交付证据与实际删减

| 范围 | 实际结果 | 独立审核 |
|---|---|---|
| Task 1 参数与文件安全 | 348 项范围通过；core/permissions/tools/sandbox 类型通过 | 修正 1 轮后 Spec 合规、Approved |
| Task 2 批次异常与单项授权 | core 146/runtime 16 项通过；两包类型通过 | Spec 合规、Approved |
| Task 3 精确替换与死策略删除 | 161 项范围通过；tools 类型通过 | Spec 合规、Approved |
| Task 4 执行事实与收尾 | 最终 217 项不同范围通过；protocol/server/services/core/Desktop web 类型通过 | legacy 结果优先级修正 1 轮后 Approved |
| Task 5 临时生成进度 | services 93/server 21/client 11 项通过；三包类型通过 | Spec 合规、Approved |
| Task 6 辅助复用与清理 | 143 项通过、Windows 1 项既有 POSIX mode 跳过；core/api/tools/runtime/server 类型通过 | 6.1–6.3 Spec 合规、Approved |
| 最终跨任务验证 | 收尾/重启 × 回滚 52 项、真实文件/引擎/引用 5 项；22 项边界契约；371 文档检查；architecture/diff 通过 | 全流程 Spec/质量 Approved，无未决问题 |
| Desktop | 主进程类型和依赖边界检查通过；独立 main/preload/renderer 构建 exit 0，迁移及 host-entry 产物存在 | 新输出目录，未覆盖当前 out |

各任务范围有重叠，以上不相加为“一次全仓通过”。行为改动都有有效断言 RED→GREEN；环境 EPERM、pnpm registry 失败和错误测试 fixture 未伪称行为 RED。最终 Git 状态检查一度将 NUL 作为排除文件失败，改为空 `core.excludesFile` 后成功：生成 routeTree 无新增修改，未提交改动和忽略证据目录保留。

本轮确认删除：旧批量授权 Promise.all/数组回填、两个无贡献 matcher、PatchChange 无消费字节字段、辅助尝试三段重复 helper、死 abortableDelay、_fingerprint、文件系统未用 options 及两处传参。公共 retryWithBackoff、environment 参数和导出、读取/hash/冲突复核、失败记忆、250ms 节流/末尾 flush 与可靠终态事务均保留。Task 6 可精确比较的 11 文件净删 59 行，其中生产源码净删 105 行；不把全部工作区的前轮新增功能误算成本轮删减。

证据均在忽略目录 `.superpowers/sdd/audit-convergence/`：task-N-brief/report/base、task-N-review.diff/md、Task 4 fix1 的独立包、final-review-package.md 与四组 final-source diff、final-verification.md。独立构建输出为其 `desktop-build-final-20261002/`。权威 Spec/计划/执行账本仍只有本文件。

### 剩余限制与取舍代价

无未解决的审核阻碍。已知限制：不保证消除 OS 文件竞争或跨文件回滚；审批宿主必须遵守现有取消合约；进程重启不保留最后字符计数；当前历史引用在压缩/重建后可能失效；Windows 未验证 POSIX 文件 mode；未测试真实模型、用户数据库或供应商速度。构建既有非致命提示如上保留，不对其另行扩展修改。

本轮所有 Ruling 按形成顺序保留在本节“执行取舍”，其代价逐条可复核：保留当前未提交 checkout（判断错可原地调整）；统一文档/工作区 diff（审核需区分前轮基础）；进度为临时内存事实（重启丢最后计数）；取消不能吞可靠故障（取消并发仍报告故障）；metadata 条件按用途保留（少量校验不合并）；写权限下保留存在探测（不能读取拒绝正文/hash）；权限携带可选宿主 schema（增加窄参数）；权限规范实际路径（增加标准路径处理）；Task 6 补回漏列的无用 options 清理（无效可选参数消失，环境职责保留）；回滚保留根 state 身份（共享恢复方式变化，以 coordinator/序号/store/收尾联测覆盖）。没有静默丢失需求或删除执行证据。

## 18. 真实任务纠偏 Spec：先决定目标，再生成正文

### 18.1 证据与目标

会话 `df5aae41-09c5-4c13-b324-f08c50d16f80` 已运行新代码。截取至 part seq=76：40 次工具调用，10 次失败；其中 Read/Write/Edit 共 23 次、5 次失败，工具阶段累计约 32.1 秒。一次 4,446 字符的完整修订稿所在模型请求耗时 421,982ms，Write 阶段 1,199ms，最后才因缺少 overwrite 被拒绝。失败调用先生成 content、后给 file_path，所以流式识别路径不能保证省去这段生成。

失败内容复用已提示但未被使用；后续 Edit 的第一处失败仅为 `{` 后的空格差异，在内存中修正后第二处引用不存在的 width:104 再失败。诊断没有原文窗口却建议 Read offset=1。两次 Shell 校验输出静默只剩最后 12,000 字符，开头缺失；AskUser 则收到对象选项，而既有工具只声明字符串选项。后续还发生无效 JSON，不能凭这一段历史判定模型、供应商或程序谁应承担全部责任。

目标是减少可预见的无效长生成和恢复往返，不以测试绿代替真实效果。不调查供应商速度，不回滚既有安全检查，不建立通用任务、缓存或日志平台。

### 18.2 方案选择与边界

- 仅增加提示词：改动少，但本次已经证明模型可能忽略，不作为主方案。
- 流式猜路径并中止：参数可能 content 在前，字段也可能后续修正；容易引入不完整调用和重试分支，不采用。
- 采用同一 Write 的两个阶段：先用小参数检查目标和明确意图，成功后通过准备调用的 ID 提交正文；模型看到的参数定义随保留的准备结果变化。准备阶段不提供正文参数。沿用现有历史、权限入口、进度展示和写前复核。

普通 Read/Edit/ApplyPatch 保持现有使用方式；不强制所有工具两阶段，不强制 Write 改用 Edit。每个完整文件生成或覆盖增加一次小的准备调用，这是避免多分钟无效生成的明确代价。无约束上游仍可能生成未提供的字段或坏 JSON，本方案不能保证拦住其生成过程；保证的是正常声明的流程先检查、失败不误写、有可复用数据时不要求再输出全文。

### 18.3 Write 的入口、状态和返回

1. 未准备时，模型看到 Write 的准备参数：`action="prepare"`、`file_path`、可选的明确 `overwrite=true`。没有 content/content_from。准备调用只检查路径、类型、读写策略与创建/覆盖条件，不写文件，不返回旧正文。
2. 已存在目标且未明确覆盖时，在准备阶段拒绝，说明仍可使用 Edit/ApplyPatch，或重新明确准备覆盖；此时无需生成正文。系统/托管路径、策略拒绝、非文件或符号链接等同样提前拒绝。
3. 准备成功返回小的结构化文本，包含规范目标、创建/覆盖意图、旧字节 hash 或不存在条件；标记 `executionState="not_started"`，说明没有文件修改。其现有 tool call ID 就是 `prepared_from` 引用，不发明另一套 ID。
4. 模型随后看到提交参数，必须给 `prepared_from`，再给 content 或 content_from 二选一；不允许在提交时改路径或覆盖意图。需要新目标/新意图时重新准备。
5. 引用从当前历史中唯一、已结算、成功的同工具准备调用解析，拒绝同批引用、重复 ID、失败/未知准备、引用缺失、字段冲突或 malformed 准备结果。压缩或恢复后缺少必要原文时要求重新准备，不从自然语言摘要猜目标。
6. core 只负责按工具声明提供本轮模型参数定义、统一入口的参数准备与复用顺序；tools/file 负责准备数据的结构、路径策略、原文快照以及执行。只增加可选 `ToolDefinition.inputPreparation`：`inputSchema` 是收到的协议 schema；纯函数 `modelSchema(history)` 生成本轮模型 schema；纯函数 `resolve(input, { history, toolUses, toolCallId })` 返回 `{ input, skipInputReuse? }`。入口顺序固定为协议 normalize/基础校验 → 工具 resolve → 未跳过时现有 content 复用 → 现有执行 schema 校验 → 失败去重 → 权限 → execute。无声明工具保持原流程。provider 与 ToolSearch 共用 schema 派生函数，不修改冻结的 registry，不扩展 Message，不让 core 知道 Write/文件系统业务。
7. 准备不代替提交时的权限检查。提交先展开明确的目标和意图，再走现有校验/授权；最终文件工具复核 hash、路径策略和当前状态。准备后文件变化允许冲突拒绝，不能为了减少报错牺牲其他进程的改动。
8. 任何已有提交引用均消费准备，包括明确 not_started 的失败；对同一规范目标的任何提交尝试同时使其他旧准备失效，不同目标保留。已生成正文仍可复用。模型声明不应继续推荐已知失效准备。展开后的历史输入保留 prepared_from；解析器同时检查当前批次前面的调用，拒绝后续重复消费同一凭据或同目标旧凭据。不能只检查 source ID 是否属于本批次，因为批次结果尚未进入历史。准备 call 与 result 都必须唯一，result 必须成功且明确 not_started，其 JSON 严格符合本工具的小凭据结构。正文复用可引用失败调用，与准备凭据的成功信任条件分开。准备之后出现成功、unknown 或无确定结果的 Edit/ApplyPatch，保守地使旧准备全部失效，不解析相对路径或 patch；这些工具明确 not_started 的失败不因此失效。已有凭据时模型仍能选择新 prepare；为修订当前文件重新做小准备，小修改仍直接 Edit。
9. 保留公开 fileWriteTool.execute 的直接调用行为供非模型调用者使用，但经过 QueryEngine 的模型调用使用准备协议。无准备的旧式长调用不得自动猜覆盖；若已收到完整内容，失败反馈仍保留现有 content_from 复用入口，重新准备后可以复用。

### 18.4 反馈不能悄悄丢失信息

- Shell 的环境入口使用有界输出，保留开头和末尾，在正文中明确标记中间省略。若原命令已产生报告文件，提示用 Read 读取；没有报告时明确省略内容无法恢复，未来调用若需要完整输出应显式重定向到文件，不能承诺一个不存在的日志。小输出按既有换行规范化/trim 规则返回，不能静默从尾部切入 JSON 中间；不新增自动重跑或完整日志存储。
- stdout/stderr 分别使用连续 UTF-8 解码，避免中文跨 chunk 被损坏；不能把修复 UTF-8 边界宣称为解决所有 Windows 外部程序编码。保留现有 timeout/cancel/exitCode/执行事实。
- 与非环境入口复用现有输出格式规则及常量，避免再复制一个裁剪器；新缓冲只为流数据的有界保存，不扩大进程/任务系统。
- Edit 仅改善定位，不放宽替换决策。已有声明/属性锚点之外，支持单行 JSON 对象稳定字符串 id 的定位；只给原始快照附近最多三个短窗口，保持既有 4,096 字符上限。不把 id 命中当作 old_string 命中。
- 找不到原文锚点时不要虚构 offset=1 是有用位置；给 Grep/Read 定位建议。该例首次失败应返回 th-model 附近真实原文，让下一轮能一起修正空格与不存在值，不能假装编辑成功。

### 18.5 AskUser 的明确兼容

在 AskUser 自己的声明和入口明确支持字符串选项及 `{label: string, description?: string}` 选项，而不是在统一参数层猜对象含义。标签必填非空，description 若给出必须为字符串；额外结构不推断。转换为现有界面使用的字符串，描述非空时显示为 `label — description`，保留用户可见信息。字符串选项、radio/check、单题/多题旧行为不变；坏对象在调用 UI 前拒绝。

### 18.6 验收、范围和非目标

- 真实文件+脚本化模型的流程回归：检查拒绝发生前正文参数不被提供、既有文件缺覆盖意图仅一次小准备失败、批准的准备后写入/覆盖成功、正确复用正文、引用身份/同批/恢复/过期拒绝、同批双提交拒绝后者、准备和结果重复 ID 拒绝、提交权限与文件变化保护保留。使用临时文件，不修改目标用户会话或生成产物。
- Shell 脚本化环境流：大报告首尾可读且明确省略，小报告无损，中文分片正确，timeout/cancel 事实不变。Edit 使用本次脱敏结构和原文空格/width 差异回归；AskUser 使用本次对象选项回归，验证实际交互收到的内容。
- 在一份小的集成测试/报告中分开记录准备拒绝、参数错误、匹配错误、命令业务校验失败与执行故障；报告脚本化回放的调用数/正文次数，不把它说成真实模型成功率提高或供应商变快。
- 不扩大别名推断，不自动推断覆盖，不自动修 JSON，不屏蔽布局校验失败，不调用真实模型做收费测试，不读取无关用户数据，不提交/push/部署/重启。当前已推送的功能分支内继续，原证据保留。

### 18.7 Spec 审核记录

- [x] 独立子代理检查流程是否真的前移、接口边界、历史恢复、权限与最小设计。
- [x] 按审核修订后在同一文档写计划，再按任务实施并逐项审核。

Spec 修正轮 1：独立架构审核给出 Needs fixes，三项已修订：明确可选声明与入口/ToolSearch 接线；补同批重复消费及唯一成功凭据；Shell 不承诺不存在的完整日志。两阶段流程本身可落地，仍等待修订后确认。

Spec 修正轮 1 complete：独立架构复审 Spec Approved，三项已闭合，无新的实施阻碍。

## 19. 真实任务纠偏 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development to implement this plan task-by-task. 本轮是 Task 7–10，旧 Task 1–6 不重做。

**Goal:** 正常模型流程先检查 Write 目标和明确覆盖意图，避免可预见的无效长正文；反馈足以纠正一次错误，而不丢信息或误写。

**Architecture:** core 只接工具声明的纯参数准备接口，文件工具负责两阶段 Write 及历史凭据；Shell 有界流缓冲明确报告截断；Edit 和 AskUser 在各自业务入口改善定位和明确兼容。所有状态沿用现有历史，无新数据库、缓存、后台任务或通用状态机。

**Tech Stack:** 现有 TypeScript、Node 标准库、Vitest、既有 QueryEngine/ExecutionEnvironment。

**Spec:** 本文件 §18。

### Global Constraints

- 不自动推断覆盖意图，不扩大路径别名猜测，不自动修 JSON，不屏蔽业务校验失败。
- 准备结果只在现有保留历史中，准备不等于提交授权；提交仍重新检查权限、路径和文件状态。
- 无声明工具保持现有流程，非模型调用者公开 fileWriteTool.execute 的直接调用行为保持。
- 没有准备时模型参数不提供 content/content_from；有准备仍能重新 prepare。
- 同批、重复、失败、unknown、缺失与已消费准备不可用；正文复用和准备引用的信任条件分开。
- Shell 输出最多保留既有 12,000 字符的数据预算，明确中间省略；不新增自动重跑或完整日志存储。
- Edit 定位只是提示，不作为匹配或替换依据；最多三个原始窗口、总诊断 4,096 字符上限。
- AskUser 仅支持明确声明的字符串或 label/description 对象，坏对象调用 UI 前拒绝。
- 不调用真实模型、不修改用户数据库或用户生成文件，不提交/push/部署/重启；验证使用已安装依赖。

### Task 7：两阶段 Write 与统一参数入口

**Files:** core/types/tools.ts；core/engine/query-engine.ts、query-tool-preparation.ts、tool-registry.ts；tools/file/write.ts、新 write-preparation.ts；必要的 engine/registry/preparation 和 file/__test__ 范围；既有文件流程/正文复用联测；仅确有必要时修改 tools/file/preview.ts 的 prepare 非修改预览识别。

**Consumes:** Message 保留的 assistant toolUses + tool_result content、ToolDefinition.inputReuse、既有文件安全与原子写入、ToolRegistryView。

**Produces:** 一个可选 inputPreparation 声明及共用的 model schema 派生函数；Write prepare/提交流程。准确类型：

```ts
inputPreparation?: {
  inputSchema: Record<string, unknown>;
  modelSchema(history: readonly Message[]): Record<string, unknown>;
  resolve(input: Record<string, unknown>, context: {
    history: readonly Message[];
    toolUses: readonly ToolUseBlock[];
    toolCallId: string;
  }): { input: Record<string, unknown>; skipInputReuse?: boolean };
};
```

- [x] 7.1：先用真实临时文件和脚本化模型补 RED：模型第一次拿到的 Write schema 无正文；existing+无 overwrite 的 prepare 只小参数拒绝；准备覆盖成功后以 prepared_from 提交并写入真实文件；ToolSearch 元数据同阶段；新目标可重新 prepare。

```ts
expect(firstWriteSchema.properties).not.toHaveProperty("content");
expect(firstWriteSchema.properties).not.toHaveProperty("content_from");
expect(await readFile(target, "utf8")).toBe("original");
expect(rejectedPrepare.executionState).toBe("not_started");
```

- [x] 7.2：按 §18 的精确顺序接统一入口。可选声明无 IO；无声明工具分支不变。incoming schema 支持 arguments 包装的正常归一，但仍拒绝冲突；派生函数同时用于 provider 请求与 ToolRegistryView/ToolSearch。不改冻结 registry 和 Message。

```ts
const protocolSchema = tool.inputPreparation?.inputSchema ?? tool.inputSchema;
const normalized = normalizeToolInput(protocolSchema, toolUse.input);
const prepared = tool.inputPreparation?.resolve(normalized as Record<string, unknown>, {
  history, toolUses, toolCallId: toolUse.id,
});
// 基础校验在 resolve 前；未 skip 才走 resolveToolInputReuse；之后用 tool.inputSchema 校验展开结果。
```

- [x] 7.3：tools/file 实现凭据与 prepare。成功小 JSON 严格保存规范目标、明确创建/覆盖意图、原字节 hash/不存在条件；成功 not_started、不写正文。工具自己的纯历史解析器检查同工具唯一 call/result、成功 not_started、JSON 类型和字段、当前批次前序消费；展开保留 prepared_from，提交不可自改路径/意图。旧式完整调用经 engine 拒绝但正文复用提示仍可用；直接 execute 旧行为保留。
- [x] 7.4：补 RED/GREEN，覆盖 duplicate ID、无结果/unknown 准备、同批引用、双提交消费、压缩引用缺失、失败/unknown/已消费提交、prepare 后文件变化、权限改变、新建竞争及失败正文经重新准备后 content_from 复用。提交权限看到展开实际目标，路径拒绝仍保护旧正文/hash。调整旧流程联测为新协议，不能删除原安全、原文复用、串行与取消断言。
- [x] 7.5：运行工具 Write/正文复用/流程/Native 文件策略范围、core preparation/registry/workflow/复用范围，core/tools 及必要 runtime 类型检查；报告模型回放中的准备拒绝、正文提交与无效正文次数；独立 Spec+代码审核。

### Task 8：Shell 流输出有界且显式省略

**Files:** tools/shell/output.ts、shell.ts，已有 shell/__test__/bash-tool.test.ts 与必要的输出回归；executor.ts 仅为复用同一输出规则需要时修改，保留现有默认执行器契约。

**Consumes:** 环境 ProcessHandle 的 stdout/stderr bytes、既有 formatOutput 和 12,000 字符预算。

**Produces:** 一个局部有界流缓冲 helper，输出含开头和末尾及省略标记，两个独立连续 UTF-8 decoder；既有 formatOutput/timeout/cancel 使用它的结果。

- [x] 8.1：先补有效 RED：环境输出大于 12,000 字符时，首部 schema/ok/stage 和尾部诊断都可见，正文明确中间省略；小输出保留旧 normalize/trim 规则；stdout/stderr 中文跨 byte chunks 无 replacement char。

```ts
const report = '{"ok":false,"stage":"composition"}\n' + "x".repeat(16000) + "\nlast diagnostic";
expect(text).toContain('"stage":"composition"');
expect(text).toContain("last diagnostic");
expect(text).toMatch(/truncated|省略/i);
```

- [x] 8.2：在 output.ts 放唯一有界收集实现，shell.ts 环境入口替换静默 slice(-12000)，stdout/stderr 各自 streaming decode 并末尾 flush。不增加日志文件、完整大数组、自动重跑或更多后台能力；提示已有报告用 Read，缺日志时省略不可恢复、未来可显式重定向。
- [x] 8.3：运行环境/native Shell、默认 executor、output/timeout/cancel 与 tools 类型范围；独立审核内存上界、输出丢失提示和退出事实。不能把本次 UTF-8 chunk 修复宣称为所有 Windows 编码问题已解决。

### Task 9：Edit 在单行 JSON 中提供真实定位

**Files:** tools/file/edit-feedback.ts，file/__test__/edit-batch.test.ts 与必要反馈回归。不得改变 edit-replacers 的替换选择。

**Consumes:** EditPlanError、原始文件快照，既有三窗口/4,096 字符边界。

**Produces:** 字符串 id 定位锚点和诚实的无定位提示，仍只是原文窗口。

- [x] 9.1：先补本次结构的有效 RED：old_string 以 `{"id":"th-model"...` 开头而原文 `{ "id": ...`；返回 th-model 附近原文。第二处不存在 width:104 的批次仍整体不写，附近 th-product 原文可见。找不到锚点时不指定伪位置 offset=1。

```ts
expect(result.metadata?.editFailure).toMatchObject({ source: "original_file" });
expect(text).toContain('"id": "th-model"');
expect(text).toContain('"id": "th-product"');
expect(await readFile(path, "utf8")).toBe(original);
```

- [x] 9.2：扩展已有 declarationKey 的明确对象 id 行模式，不解析全文件 AST、不以相似程度自动编辑；沿用原始快照窗口，保留候选位置与定位提示区别。无窗口时 recoveryHint 改为 Read/Grep 定位，不提供具体 offset。
- [x] 9.3：运行 edit/batch/preview/反馈范围及 tools 类型；独立审核未放宽误写边界、中文/转义 id 和诊断预算。

### Task 10：AskUser 明确兼容与整体交付

**Files:** tools/meta/ask-user.ts、meta/__test__/meta.test.ts 或新的 ask-user.test.ts；prompts/src/index.ts 的现有 Write 指导文案、core/engine/tool-input-reuse.ts 的通用复用提示与必要消费回归；本文件 §20 执行证据；必要的本次整体流程 fixture 放现有文件 workflow 测试，不新建评测平台。

**Consumes:** 当前 questions/radio/check 及 askUserPrompt 字符串界面合约，Task 7–9 的最终接口。

**Produces:** 明确的选项 schema/规范转换，完整验证后一次调用既有 UI；最终独立整体审核和验证记录。

- [x] 10.1：先补 RED：本次 label/description 对象数组实际触发 UI，用户看到标签和描述；字符串选项不变；空 label、非字符串 description、未知结构拒绝且 UI 没被调用。

```ts
expect(JSON.parse(actualPrompt).questions[0].options).toEqual([
  "流程图+卡片 — 展示主题关系", "纯信息版面",
]);
```

- [x] 10.2：schema 明确 string 或严格 label/description；在 AskUser 内先验证全部题目再映射至现有 strings，不改统一参数别名层或 UI 合约。补声明中的一个短参数例子，不堆叠系统提示词。

  按 §20 已授权补充，最小同步既有默认系统 Write 指导：先 action=prepare/file_path/明确 overwrite，再 prepared_from + content/content_from；失败正文复用先新小 prepare，不要求提交自传 path/options；Read info_only 保持可选只读检查。用实际默认 prompt 进入模型请求和真实文件结果的必要脚本化联测验证，不 grep 源码文案。

  同步 withToolInputReuseHint 的旧“显式修正目标/options”提示：用不含文件业务的短通用措辞，要求按当前 schema 给目标或准备引用，意图选项在所需准备阶段确认；复用数据不继承权限。不新增声明字段，通过实际模型请求的工具反馈消费验证。
- [x] 10.3：运行 meta/AskUser 范围及 tools 类型；独立任务审核。
- [x] 10.4：全流程独立复审，以当前基点 b7988381 之后的工作区增量为准；补关键跨任务联测、受影响类型、docs、architecture、diff 检查及独立 Desktop 构建到新的忽略目录。不得覆盖现有 out、重启、提交或 push。
- [x] 10.5：回填实际 RED/GREEN、脚本回放的调用/正文次数、限制和删增；不声称真实模型成功率或供应商速度已改善。所有取舍保留在本文件，不丢任务证据。

## 20. 真实任务纠偏执行账本

| 任务/关系 | 检查 | 结论 |
|---|---|---|
| Task 7 | 协议 schema、归一、引用、模型/ToolSearch 出口、权限与工具执行 | core 不含文件业务；prepare 跳过正文复用，commit 先展开目标再授权 |
| Task 8 | 流字节 → 有界字符 → 格式化 → 执行结果 | 显式省略，不承诺不存在的日志；不改进程生命周期 |
| Task 9 | 原始快照 → 锚点 → 原文窗口 | 只定位，不改变匹配策略和批次零写入 |
| Task 10 | 明确对象/字符串 → 已有 UI strings | 不猜任意对象，先验证所有问题 |
| 7 → 9 | 既有 workflow/batch 测试交界 | 串行实施；9 保留 7 的新协议联测，不回退安全断言 |
| 7/8/9 → 10 | tools 类型、整体脚本回放与交付 | 最终只补实际风险联测，不重复全仓套件 |

- [x] Spec 子代理审核及修正轮 1 Approved。
- [x] 同文件计划与文件/接口关系自检。
- [x] Task 7 完成及审核。
- [x] Task 8 完成及审核。
- [x] Task 9 完成及审核。
- [x] Task 10 完成、全流程审核及交付。

Ruling: 沿用已推送的 codex/tool-workflow-audit-convergence 分支和当前 checkout，不另建 worktree — 用户要求继续当前改动，上一轮已在此运行验证且当前代码基点干净；工作区检查确认不是 main — 代价是暂不具备 linked worktree 隔离，但不移动用户数据、不安装依赖、任务源文件增量可按基点核对。

Ruling: 统一文档仍为 Spec/计划/账本；使用新的 `.superpowers/sdd/2026-10-02-file-workflow-design/` 保存本轮 briefs/reports/增量审核包，不提交也不删除证据 — 用户要求一处文档，当前请求未要求再次提交 — 代价是使用工作区和各任务起点副本审核而非 commit range；PowerShell 下按已读脚本同样的提取/包装规则用 apply_patch 生成文件，不用重定向写文件。

基线：当前 HEAD b7988381，起始代码干净；只改统一 Spec/计划。tools Write 24、Edit batch 22、Shell tool 17，共 63 项相关已有测试通过；AskUser 回归目前在 meta.test.ts，本次新用例由 Task 10 补，未把不存在的测试路径当作已验证。

Task 7: in_progress — implement_write_preparation 按独立 brief 实施。Task 8–10 brief 已从 §19 提取；旧 §16 的同名约束标题不属于本轮 brief，提取时明确先限定 §19。尚未实施后续任务。

Task 7: review_pending — 13 个源码/测试文件（7 生产、6 测试）；core 182、tools 131 项通过，最后 schema 根对象修正后 44 项受影响测试复验通过，core/tools/runtime 类型通过。完整 71,124 字符增量审核包由独立 review_write_preflight_spec 做 Spec+质量 gate；未以测试绿替代审核。首个正常回放为 4 次调用、3 次小 prepare/1 次准备拒绝、1 次正文生成/提交，拒绝含正文调用 0；同批双提交与旧式违规调用另作拒绝保护，不宣称所有模型都会遵守 schema。

Task 7: model_contract RED/GREEN — 主代理只读核对已安装 Anthropic SDK 的 InputSchema 根 type=object；已有准备时模型 schema 最初缺此根字段，回放有效 1 FAIL 转 44 GREEN。provider/runtime view 同派生，未调用真实接口。

Task 7: fix round 1/5 — 独立审核 Spec 不符合、质量 Needs fixes，Important：同一目标先准备 p1/p2，用 p2 提交后，p1 旧 hash 仍被模型 schema 推荐；同批不同准备向同一目标先后提交也漏检。审核只读最小复现 enum=[p1]。原 worker 先补跨轮/同批双准备的有效 RED，再在 tools/file 既有失效判断修复；不能退回“生成后 hash 拒绝”。审核时三份相关起点保存在 task-7-fix-1-base；未开始 Task 8。

Task 7: fix1 同目标消费补查 — 主代理纯内存复现同目标 p2 failed/not_started 后旧 p1 仍 resolve；相同实际 path/body/hash 因 prepared_from 不同使已有失败记忆返回 false。无真实文件/DB/model调用。为不增加 core 去重接口，将同目标任何提交尝试统一消费所有旧准备；下次取得新小准备的真实状态证据后正文仍复用。此场景加入修正回归。

Task 7: fix round 1/5 reviewed — 原同目标过期问题 ADDRESSED；修正中新增 Important：路径身份未知的保守判断只覆盖后续 candidate，不覆盖准备 target。只读反向 namespace 复现准备 \\.\C:\Work\File.txt 后普通 C:\Work\File.txt Write 仍推荐旧准备。进入 fix round 2/5：任一侧未知都失效；不增加更广路径解析。修正 1 的六文件 98 GREEN/tools types/diff 证据保留，不因此标完成。

Task 7: fix round 2/5 complete — 新 Important ADDRESSED，独立复审 Spec Compliant、质量 Approved，无新 Critical/Important/Minor。反向 namespace 的跨轮/同批/恢复真实引擎 schema 3 项有效 RED 转两文件 56 GREEN，tools types/diff 通过。仅现有 predicate 对两侧 unknown 对称失效，无额外 namespace 解析。

Task 7: complete — 两轮修正后 gate 已闭合。原 core 182、tools 131；随后修正覆盖 98 和最终 56（有重叠，不累计），三包类型通过。13 个源码/测试文件，回放计数见新目录 task-7-report.md；新小 prepare 拒绝时未生成正文，权限/hash/创建竞争/正文复用和旧直接执行保留。当前源码未提交、未覆盖 out，允许开始 Task 8–10。

Ruling: 同目标任何 Write 提交尝试使其他旧准备失效，含明确 not_started 失败，不同规范目标保留 — 有效内存复现证明不同引用 ID 可使相同实际调用躲过已有失败记忆；统一消费可沿用准备与现有证据机制，不加新的去重声明 — 代价是失败后其他同目标准备也需重新做小检查，正文依旧可复用；Edit/ApplyPatch 明确 not_started 的例外不变。

Ruling: 任何已有 prepared_from 提交引用均消费该准备，包括明确 not_started 的失败 — 使用一条保守规则避免不同失败路径对凭据寿命作多套推测 — 代价是失败后需重新做小准备，但已生成正文仍可通过 content_from 复用，不要求重写全文。

Ruling: 不让 ToolSearch 额外输出整份参数定义，一致性指其 ToolRegistryView 获取的 schema 与 provider 共用本轮派生 — 实际 ToolSearch 当前只展示 name/description，追加所有 schema 会进一步放大上下文 — 代价是阶段 schema 仍从正式工具定义获取，不新增一次文本复制。

Ruling: 准备后的成功/unknown/无确定结果 Edit 或 ApplyPatch 使旧准备全部失效，明确 not_started 失败除外 — 纯历史回调没有执行 cwd，不能只处理绝对路径而漏掉已知相对文件修改，也不为此建立 patch/路径解析平台 — 代价是修改别的文件可能多一次小准备；最终文件状态复核仍保护不可观察的外部变化。

Ruling: 达到新增代理线程上限后，复用已完成的协调/审核/实施身份并给新的独立 task brief，不改变实现与审核分离 — 运行环境不能继续创建全部新身份 — 代价是旧上下文可能残留，因此明确旧 Task 1–6 已完成、只读本轮 §18–20 与新报告，不把旧完成状态计入本轮。

补充基线：AskUser 所在 meta.test.ts 28 项通过。一次错误 cwd 的 Node 路径调用仅为命令配置错误，不算行为 RED；正确 packages/tools cwd 验证通过。Task 8 起点的 12 个 Shell 文件已只读复制到新目录 task-8-base，未改源码。

Task 8: in_progress — Task 7 最终 Spec Compliant/质量 Approved 后，由独立 implement_correction_task_8 开始 Shell 流输出纠偏；使用本轮 task-8-brief/report/base，已有 12 文件起点不覆盖。后续 Task 9/10 尚未实施，旧 Task 1–6 和旧证据不重做。

Ruling: Task 8 原选 gpt-6.1-sol 未执行即报容量不足，改由 gpt-6-sol high 的鲜新独立实施者继续，审核 gate 保持 — 同等级标准模型可处理限定三文件流缓冲任务，避免反复等待容量 — 代价是可能多一些推理轮次；有疑问按既定修正/升级机制处理，不降低有效 RED/GREEN 或独立审核要求。

Task 8: implementer replaced before execution — implement_correction_task_8 因模型容量失败，尚无报告或源码执行；唯一当前实施者为 implement_correction_task_8_available。任务起点未覆盖，没有并行实施。

Task 8: RED/GREEN review_pending — 实際有效 RED 2 项（大报告首部丢失、UTF-8 跨块乱码），环境 Shell 20 项转全绿；其他 Shell/native/executor 38 项通过，tools 类型/diff 检查 exit 0。增量仅 output.ts、shell.ts 与 bash-tool.test.ts；留存有界，大上游单 chunk 的一次解码字符串不夸称不存在。生成完整 task-8-review.diff，独立 gate 尚未完成，不开始 Task 9。

Task 8: minor (deferred to final review) — shell.ts 单个极大 Uint8Array 先整体解码，collector 常驻留存有界但瞬时解码字符串为 O(chunk)；现有 ProcessHandle 接口不规定单块硬上限。记录实现限制，最终整体审核再次裁定是否需要分段；未扩展为所有上游分配的硬内存承诺。

Task 8: complete — 独立 Spec compliant、质量 Approved，无 Critical/Important；上述 Minor 明确留给最终复审，不静默丢弃。报告记录有效 2 RED→环境 20 GREEN，其他 38 GREEN、tools 类型/diff exit 0，未重复同代码完整套件。小输出/首尾省略/双流 UTF-8/timeout/cancel/退出事实保留；实际结果只来自脚本化环境流，不声称所有 Windows 编码或真实模型改善。

Task 9: in_progress — 起点 edit-feedback 与四份范围测试保存在本轮 task-9-base；下一步只改原始 JSON id 定位和无锚点建议，不放宽 edit-replacers。

Ruling: Task 10 附加最小默认系统 Write 指导同步及其真实消费联测 — 主代理只读确认 prompts/index.ts:85/87 仍指导 Read info_only 后自传 overwrite/hash、失败 content_from 改 options，和已批准两阶段提交协议冲突，明确授权纳入本轮 — 代价是增加一个既有 prompts 源文件和相关类型/消费者验证；只替换原两条指导，不叠加提示词平台或改工具协议。prompts 原文件已存 task-10-base，其余 Task 10 起点在实施前补存。

Ruling: 同 Task 10 顺序修正 core 既有通用正文复用提示的过时 options 指导 — 主代理再次只读确认 withToolInputReuseHint 实际反馈会鼓励新提交自传 file_path/overwrite，明确授权一起同步 — 代价是多一个窄提示文件及真实模型反馈消费者回归；core 不加入 Write 判断/文件业务/声明字段，复用信任、权限和展开顺序不变，原文件起点已补存。

Task 9: RED/GREEN review_pending — Edit batch 新增 5 项有效 RED（22 既有通过）转 27 GREEN；Edit/preview/文件流程与 Task 7 新 Write 协议共 171 项范围通过，tools 类型/diff exit 0。增量仅 edit-feedback 与 batch 测试；JSON id 只供原始定位、长单行窗口居中，无锚点不假造 offset。完整 task-9-review.diff 已生成，独立 gate 未结束，Task 10 尚未实施。

Ruling: 接受 Task 9 独立审核在 MESSAGE 中完整交付的双 verdict/行号证据，保留随后最终消息的模型容量错误记录 — Spec compliant、质量 Approved、三档无问题与 cannot-verify 已明确交付，容量错误不撤销完成的只读审核 — 代价是没有第二份最终通道格式报告；将已交付内容保存 task-9-review.md，最终最强整体复审仍重新覆盖当前 Task 9 源码，不重复同一任务审核或绿测。

Task 9: complete — 独立 MESSAGE gate 已给 Spec compliant/质量 Approved，无 Critical/Important/Minor，核对原始 id/窗口/匹配候选区别/无伪 offset 和零落盘回归；随后最终通道容量错误按上述 Ruling 记录。27/171 项有重叠的范围及类型/diff 通过，无未决源码问题。超长 id 仍受短窗口限制，需 Read 查看完整原文；不因提示命中误宣称编辑成功。

Task 10: in_progress — 本轮 task-10-base 已保留 meta、实际默认 prompts、通用 reuse hint 及消费/workflow 测试起点；下一步 AskUser 兼容与两条已授权真实模型指导同步。10.4/10.5 由协调员负责，不交给实现者声称完成。

Task 10: 10.1–10.3 review_pending — 实现者已 DONE，仅 6 文件（meta 与测试、默认 prompts、通用 core hint 与消费测试、实际 runtime prompt workflow）。实际 RED 覆盖对象选项/UI/schema、默认 system 模型请求及旧复用反馈；tools 117/core 27 项通过，最终 buildRuntimeSystemPrompt 消费回放 2 项重测通过（有重叠），tools/core/prompts 类型/diff exit 0。新建回放省略 overwrite、覆盖明确 true，不改 Task 7；临时 VYKOR_CONFIG_DIR 隔离配置读。完整 task-10-review.diff 已生成，任务 gate 和 10.4/10.5 尚未完成。

Task 10: complete — 独立 gate 给出 Spec compliant、质量 Approved，无 Critical/Important；一个非阻断 Minor 是 workflow fixture 的临时配置目录不能隔离从 cwd 向祖先扫描的项目指令，审核时该祖先链没有候选规则。有效 RED/GREEN 和工具/模型实际消费详见 task-10-report.md，独立结论保存 task-10-review.md。审核者完整 MESSAGE 后的模型 capacity 错误不撤销已交付结论，也不是源码失败。

Ruling: Task 10 测试保留现有真实 runtime prompt 入口与临时配置隔离，祖先项目指令扫描的可移植性限制记录为 Minor，不改生产运行语义 — 当前测试环境祖先链无规则，且任务需求不包括修改项目指令发现 — 代价是该 fixture 换到带祖先规则的环境可能读取它们，未来需要更严格隔离时应在测试层处理。

Task 10: final_checks — 协调员新鲜运行本轮受影响 core 60/60、tools 273/273 范围回归；tools/core/prompts 类型，Desktop node/web 类型及工作区边界，371 文档、architecture 122 与 22/22 边界契约、精确 diff check 均 exit 0。默认沙箱读取已安装 TypeScript/Vitest 依赖失败后，同命令获准读取依赖并成功；前者不计行为 RED。Desktop 用全新忽略目录独立构建 main/preload/renderer，exit 0，未覆盖 out 或启动应用；构建同时包含用户并发 Desktop/services 改动，不能将其当作本轮源码审核。详细命令及提示见 final-verification.md。

Task 10: final_review — 最强独立只读复审以 b7988381 对照本轮精确 13 生产 + 10 测试文件，Spec Compliant、质量 Approved，无 Critical/Important；Task 8 单个极大 Uint8Array 先整体解码会有 O(chunk) 瞬时字符串，为一个非阻断 Minor。常驻留存及最终文本仍有界，符合本次约定；若将来上游实际产生极大单块，可按固定字节段连续解码。双 verdict、行号和不能验证项见 final-review.md。未将用户并发四个已改文件或相关新增文件纳入本轮 review。

Ruling: Task 8 的单块瞬时解码限制保留为已知 Minor，不加新的 chunk 切片逻辑 — §18 要求有界保存，现有 ProcessHandle 未定义单块硬上限，也没有实际超大单块故障证据 — 代价是上游若一次交付极大 Uint8Array，会有与该块大小成正比的瞬时内存占用；真实出现时再以固定字节片段修复并补有效 RED。

本轮脚本化事实：正常 Write 回放为 4 次调用，其中 3 次小 prepare（1 次提前拒绝）、1 次正文提交；拒绝的准备未触发正文生成。新文件 Task 10 回放为 3 次模型请求、2 次 Write（prepare→commit）、1 次正文，无 Read；既有 workflow 为 7 次模型请求、6 次工具调用，失败旧式长调用的正文可在新准备后以 content_from 复用。这些仅是脚本客户端/真实临时文件的行为计数，不是实际模型成功率、供应商速度或 token 节省测量。任务范围源码/测试相对 b7988381 共 23 文件：tracked 19 文件增加 479 行、删除 61 行；4 个新增文件共 550 行，合计增加 1,029 行、删除 61 行（Git 行数口径；不含本文档与忽略证据）。最终不提交、push、部署、重启、调用真实模型或触碰用户数据库/生成文件；证据保存在新的 `.superpowers/sdd/2026-10-02-file-workflow-design/`。

## 21. 准备引用可见性修正

会话 `107cbb24-33f0-425c-abfa-e56b7141a272` 的新复用提示已生效，但截至 18:36 的五次 Write 准备成功、三次正文提交失败，模型明确表示准备结果没有可填的调用 ID，并多次填写不存在的引用。准备正文只有路径、意图、hash/不存在条件；旧回放脚本预先知道 ID，没有覆盖“仅从结果正文取得下一步参数”的实际使用边界。

用户已批准再次修复。本次属于现有流程内的有限修正，不另建协议、缓存或任务系统：

- 引擎内准备成功时，在唯一 JSON 文本中明确返回真实 toolCallId 的 prepared_from 和简短提交示例；示例只含 prepared_from 与 content，不含路径、覆盖或 hash。
- 新可见引用必须匹配唯一历史源调用；显示字段不能改变目标、意图和原快照。安全的旧平面凭据和不带调用 ID 的直接 SDK 检查保持兼容，不编造 token。
- 反馈区分禁止的提交字段、缺引用和无效/失效引用，不把“已成功准备”误说成没准备；原有正文复用、唯一性、消费/过期、同批、权限与文件变化检查保留。
- 新回归使用不预先约定的 opaque ID，模型替身只读返回正文取 prepared_from/示例，再实际提交文件；不得读取 envelope ID、执行上下文或 schema enum 来替代返回字段。
- 不改 Shell/Browser/GTK，不判断供应商速度，不调用收费真实模型，不提交/push/覆盖 out/重启，保留用户并发源码和正在运行任务。

证据独立保存在忽略目录 `.superpowers/write-reference-visibility/`；七份实施前文件副本为本次增量起点，不把旧未提交功能或用户改动算成本次修正。此补充修复只需短设计、有效 RED/GREEN 与独立审核，不重做前轮全部 Spec/计划/测试。

- [x] 修复范围已确认，实施前副本及 bounded brief 保存。
- [x] 有效 RED → 最小实现 → 消费/信任边界验证。
- [x] 独立审核、独立构建与交付记录。

执行结果：限定七个源码/测试文件（三个生产文件 Write、准备解析、原两句 prompt；四个现有测试），没有改 core。新可见字段 prepared_from/submit_example 成对出现，前者等于唯一源调用 ID，后者是只含引用与正文占位符的 JSON 字符串；旧四字段凭据及缺调用 ID 的直接 SDK 检查保持兼容。反馈分别报告缺引用、无效/过期引用和禁止提交字段，明确 file_path 只在准备步骤使用。

有效 RED 在真实 QueryEngine 下一轮模型参数中只读结果正文，原 prepared_from 为 undefined；创建/覆盖两路径失败后修正。工具六文件 109、core 四文件 56 项通过；指导同步后真实 runtime workflow 两项通过。主代理独立重跑创建/覆盖/正文复用三项，实际文件 raw Buffer 逐字节相等；复用案例正文仅生成一次（43,000 字节），从失败文本取得 content_from，再从新准备文本取得 prepared_from。tools/core/prompts 类型与 diff 检查通过。次数有重叠，不相加为新的全仓测试总量。

独立限定差异审核 Spec Compliant、Quality Approved，无 Critical/Important/Minor；完整七文件增量为 `.superpowers/write-reference-visibility/review-complete.diff`。原 review.diff 的一份测试基点缺失条目不是有效 diff，已明确弃用；完整包对该文件使用前轮 Task 10 未修改的副本，实际差异只有 randomUUID import 与新增独立消费案例，其余四个案例不变。用户并发代码未纳入本次审核。

独立提供方边界检查的两个本地探针通过：成功单 JSON 文本经过现有预算/formatter/OpenAI SDK 参数转换会进入 role=tool 的 content，而 tool_call_id 和 schema enum 仍在不同位置；没有 HTTP 或真实模型调用。详见 wire-review.md。默认预算下返回引用可消费；自设很低的输出预算、超长路径/ID 或历史压缩仍可能损坏/清除 JSON，使凭据安全失效。本次不为此增加预算绕过、缓存或泛化转换层，也不声称远端模型一定遵循。

交付检查：371 文档检查通过；主代理用 electron-vite 构建到新的 `.superpowers/write-reference-visibility/desktop-build-final/`，exit 0，main/index.js、main/host-entry.mjs、preload/index.js、renderer/index.html 四产物存在。保留既有非致命提示：项目外 outDir 不自动清空、prompt-segments-assembly 混合动态/静态导入、pet.test.ts 无 Route。构建包含当前未提交前轮及并发工作树，不把用户其他改动算本次审核；未覆盖 out、提交、push、部署或重启。证据 report.md/wire-review.md/完整增量和实施前副本均保留。

## 22. 对照 OpenCode 后的文件工具收敛 Spec

用户已同意继续。此轮是现有跨模块流程的收敛，不新建文件系统、工具框架或恢复服务；先 Spec 子代理审核修订，再在本文件补计划，最后实施。

### 22.1 事实、目标与选择

会话 `5a2cb7ca-23e4-453a-8773-24dc274b1c48` 的准备引用已返回且复制正确，但提交成 `{arguments:{content,prepared_from},file_path}`，完整正文生成约 4 分 20 秒，约 0.9 秒校验后未开始写入。混合包装没有解开，正文复用又只识别根层 content；旧准备还可能因失败的同目标尝试过期。不是再次补一个可见 ID 就能解决。

本地 OpenCode `1ddb0873ae` 的两版 Write 都接受一次平面路径与正文调用；旧版生成开始即显示同一工具卡。它也不提前执行、不自动修复所有参数错误、不保证首次生成更快。当前 Edit 已移植它的匹配策略，此轮不改 matcher。

选择：正常调用保持简单，把权限、文件状态与落盘保护留在程序中；把长正文恢复作为失败兜底，而不是每次成功写入的必经阶段。

未采用：继续强制两阶段并扩充引用规则（正常调用仍有额外往返和历史依赖）；自动合并任意混合包装并执行（目标和覆盖意图可能有歧义）；照搬 OpenCode 全部框架或放松覆盖检查（范围和安全约束不符）。

### 22.2 正常 Write 与安全边界

- Write 的模型参数保持平面、稳定：file_path、content、content_from、overwrite、expected_sha256。正常新建只需要 file_path + content；失败正文复用用 file_path + content_from。content 与 content_from 二选一，引用只复制正文。
- 整文件替换是 Write 的合法用途；存在不同内容时仍须明确 overwrite=true。小修改优先 Edit，多文件/多处修改优先 ApplyPatch，不自动推断覆盖意图。
- 删除强制 action=prepare、prepared_from、expected_absent 及历史准备消费/失效/动态 enum；删除仅服务这条路径的 inputPreparation 核心扩展和动态模型参数派生。不保留旧准备的兼容执行器或双轨协议。
- Read.info_only 保留为可选的小检查，尤其目标状态不清楚或将生成长正文时；这不是 Write 权限，也不保证后续操作系统写入成功，不强制正常新建多一次 Read。
- 保留路径归一与冲突别名拒绝、环境/沙箱/系统和受管理目录保护、执行前权限、普通文件/符号链接检查、可选原字节 hash、写前状态复核、排他新建及原子单文件替换。引用不继承权限、目标、覆盖和 hash；未知结果先检查实际文件。
- 不自动重试、提前执行或写入半截参数。已保存的旧准备调用只是历史数据，后续过时提交应失败，不能继续产生副作用。

### 22.3 参数格式与失败正文恢复分开

- 参数处理仍只有 core 的统一入口。除已有 arguments 外，识别 args、parameters 的纯单字段包装；最多八层，只返回满足现有 schema 的完整候选。工具 schema 声明的同名业务字段、组合 schema、错误类型和别名冲突不猜测、不改值。
- 带平级字段的包装不自动合并、不丢字段、不授权执行。对本次结构，正确行为是拒绝这次调用，并允许模型下一轮明确给出平面参数。
- 长正文恢复沿用 inputReuse/content_from 与当前历史，不新增缓存、数据库、草稿、自动重放或第三种引用。对于已解析为对象但参数校验失败的调用，可以在根层或单一路径的已知包装中保留完整字符串正文；识别最多八层。
- 恢复只读取工具声明的正文属性，不把嵌套路径/覆盖/hash 提升为执行参数。多个包装分支、不同正文候选、越界深度、循环输入、JSON 解析失败/截断、来源不唯一、未结算、同批来源、跨工具或历史丢失，均不提供可用引用。
- 提示与实际引用使用同一份来源判断，避免提示一个无法复用的 ID。权限、预览、hook、执行和失败记忆仍使用同一份最终平面有效输入。失败保护、纠错上限和未开始/完成/未知结果区分不变。

### 22.4 生成期间展示

收到真实工具参数开始/增量后，Write 必须可以出现在工具组中，状态为正在生成参数，不能表述为正在改磁盘。生成项在增量期间保持稳定展示标识，正式工具调用出现后交接为真实调用项，不重复展示；不要求临时生成项成为同一数据库 part。完整参数确认后才进入校验、确认和执行。取消、失败请求和无完整调用不能留下悬挂的生成工具卡。

此处“工具组”明确指现有 ToolActivityGroup 的工具活动区域，不是消息正文旁独立的 Loader 状态行。生成项按原叙事顺序与相邻工具合组；只有一项时保持现有直接展示，多个时使用现有折叠组。折叠标题也须带正在生成的工具名，不能只有字符数；展开后生成项保留“生成参数/尚未执行”及计数，不提供空参数/结果展开，不计入正式调用、编辑、命令或读取的次数。正式条目接管仍使用既有身份交接，不新增可执行 part、存储或事件。

先核对已经实现的 provider → core → 投影/live 同步 → Desktop 消费路径及回归。如果此要求已有覆盖，只保留实现、运行针对性验证，不再重写 UI，不另建状态表或事件协议；有确定缺口才纳入最小修正。

### 22.5 验收与排除

1. 新文件在真实 QueryEngine + Write + 临时文件联测中，仅一次 Write 成功，不需要准备调用、引用 ID 或先读；返回的模型 schema 在历史变化前后保持同一参数形态。
2. 完整覆盖必须明确 overwrite；错误 hash、权限拒绝、冲突路径和非普通文件仍不写。已有文件修改/批量匹配安全回归保留。
3. 纯 args/parameters 包装能够按正式 schema 正常调用；混合包装不执行。混合包装中唯一完整正文失败后，下一轮只发明确路径、覆盖意图和 content_from，可以逐字节写出同一正文，正文只生成一次。
4. 冲突正文、双包装分支、无完整 JSON、超深/循环、重复来源、跨工具、同批、未结算和历史丢失，不能绕过恢复或权限边界。
5. 用受控暂停的参数流验证结束前工具生成事件已可见且没有落盘，并覆盖稳定生成项向正式工具的无重复交接、取消/失败清理；不以 loading 标签出现代替工具组出现。
6. 先有效 RED 再最小实现，按范围测试/类型检查、文档检查及独立审核交付；不重复整个仓库测试套件。

仍排除模型/供应商耗时对比、首次生成提速承诺、模型自动切换、新增匹配算法、Shell/AskUser/Browser 改造、真实收费调用、用户数据库/文件修改、部署、覆盖现有 out、重启、提交和 push。OpenCode 仓库仅作只读参考。

证据使用新的忽略目录 `.superpowers/write-workflow-convergence/`；保留当前功能分支和此前未提交改动，按本轮起点副本审核实际增量。旧 §18–§21 是历史记录，不作为新实现验收要求。

## 23. 文件工具收敛 Implementation Plan

> **For agentic workers:** 使用 subagent-driven-development 按任务执行、审核；任务完成前必须有有效 RED/GREEN 或既有行为的新鲜验证。所有公开设计、计划与账本仍在本文件。

**Goal:** 正常 Write 一次调用完成；错误包装不误执行，已有完整正文可安全复用；保留生成工具组和文件保护。

**Architecture:** core 负责完整调用的归一、正文引用、校验及统一授权顺序；tools/file 负责路径、文件状态和落盘。删除仅服务强制准备的通用接口，不新增服务。展示沿用临时生成项向正式调用交接的现有路径。

**Tech Stack:** TypeScript、现有 Vitest、Node 文件 API、现有 provider/投影/Desktop。

**Spec:** 本文件 §22，已独立审核 Spec Approved；具体建议记录在忽略证据 spec-review.md，并纳入以下任务。

### Global Constraints

- Write 的模型参数保持平面、稳定：file_path、content、content_from、overwrite、expected_sha256。
- 整文件替换是 Write 的合法用途；存在不同内容时仍须明确 overwrite=true。
- 引用只复制正文；引用不继承权限、目标、覆盖和 hash；未知结果先检查实际文件。
- 带平级字段的包装不自动合并、不丢字段、不授权执行。
- 不自动重试、提前执行或写入半截参数；不新增缓存、数据库、草稿、自动重放或第三种引用。
- 不改 matcher、Shell/AskUser/Browser，不调用真实模型或用户数据库，不覆盖 out、不重启、不提交/push。
- 保留当前未提交的无关改动。只删本次明确取代的准备协议实现/测试，副本保留供恢复和审核。

### Task 11: 恢复一次 Write，移除强制准备

**Files:** core/engine/query-engine.ts、query-tool-preparation.ts、tool-registry.ts、types/tools.ts；tools/file/write.ts、read.ts 的原 prepare 指导一句；prompts/index.ts；core/engine/tool-input-reuse.ts 的原提示一句。更新 tools/file/__test__/file-workflow.integration.test.ts、write-content-reuse.integration.test.ts、native-file-policy.test.ts、write.test.ts；core/engine/tool-input-reuse.integration.test.ts 必要提示消费断言。删除 tools/file/write-preparation.ts、其两个专用测试、core/engine/query-tool-preparation.protocol.test.ts。

**Consumes:** 现有 fileWriteTool、QueryEngine、resolveToolInputReuse、执行前授权及 fileOperationsFor。

**Produces:** 静态平面 Write schema；core 不再有 inputPreparation/modelToolDefinition 的准备派生；旧字段和未知字段不能执行。下一任务沿用普通 object schema 和 inputReuse，不能添加顶层 oneOf/anyOf 导致归一失效。

- [x] 11.1 先补真实 QueryEngine + fileWriteTool 的有效 RED：模型第一轮只提交完整路径与正文，新建成功、仅一个 Write、两轮模型请求；历史增加后模型仍看到相同的平面 schema。测试在模型请求消费默认 prompt，并实际检查最终文件而非 grep 文案。

```ts
yield { type: "tool_use_start", toolUse: { type: "tool_use", id: "single-write", name: "Write", input: { file_path: target, content: body } } };
expect(writeResults).toHaveLength(1);
expect(writeResults[0].result.isError).not.toBe(true);
expect(Buffer.from(await readFile(target))).toEqual(Buffer.from(body, "utf8"));
expect(modelRequests).toHaveLength(2);
expect(modelRequests[1].tools.find(t => t.name === "Write")!.inputSchema).toEqual(modelRequests[0].tools.find(t => t.name === "Write")!.inputSchema);
```

- [x] 11.2 运行 tools 的 workflow 文件确认上述行为 RED；依赖读取失败/命令配置错误不算 RED。最小删除准备入口、动态派生及其专用实现，不触碰其他已完成修复。Write schema 使用普通 object、required file_path、additionalProperties=false，正文二选一沿用 resolveToolInputReuse；直接 execute 保留必要输入拒绝，不把旧字段当兼容调用执行。
- [x] 11.3 更新原两句 Write 系统指导与通用复用提示：正常明确路径与正文/引用，覆盖显式 true；Read.info_only 可选；复用重新授权/核对状态。既有失败正文、权限卡/preview/hook/失败指纹和安全回归改用一次平面调用，保留所有安全断言。旧历史不改写。
- [x] 11.4 运行 Write/策略/workflow/reuse 范围、core 受影响 registry/reuse/能力快照范围及 core/tools/prompts 类型检查；提供起点增量、有效 RED/GREEN 和独立 Spec+质量审核。不开始 Task 12 直到重要问题修完。

### Task 12: 有限包装归一与正文失败恢复

**Files:** core/engine/tool-input-schema.ts、tool-input-reuse.ts 及其现有单测/集成；tools/file/__test__/write-content-reuse.integration.test.ts，必要联测放现有 workflow 文件。

**Consumes:** Task 11 的普通 object Write schema；现有 normalizeToolInput/validateToolInput；inputReuse 及已结算历史。

**Produces:** 纯 arguments/args/parameters 最多八层按 schema 解包；同一历史来源判断供提示和实际复用使用，可提取唯一完整正文，始终只复制正文，不修改失败原始输入。

- [x] 12.1 先补 RED：Read/Glob 的纯 args/parameters 及 Write content/content_from 均可校验；schema 声明同名字段、混合平级参数、冲突别名、错误类型、组合 schema、九层和循环不猜测。继续运行原 schema 单测，不能改旧“混合包装不丢字段”断言来换取绿灯。
- [x] 12.2 在已有归一入口仅扩大已知纯包装键，保持完整候选验证。正文来源读取单一路径最多八层，扫描整链后再判断完整字符串唯一性；空正文有效，发现不同候选/多包装分支/循环/超深/业务字段不可提供复用。根层与链中同值候选不应因格式位置不同而被当作不同正文。相关读取逻辑放原 reuse 文件，不新拆框架。
- [x] 12.3 先补实际失败回放 RED，再实现最小恢复；首次精确复现混合输入，拒绝且文件字节未变。模型第二轮只从错误反馈读真实引用 ID，再明确给平面目标与覆盖选项，不重发正文。参考输入和独立字节断言：

```ts
const first = { arguments: { content: body, prepared_from: "obsolete-reference" }, file_path: target };
const retry = { file_path: target, overwrite: true, content_from: retainedCallId };
expect(firstResult).toMatchObject({ isError: true, executionState: "not_started" });
expect(await readFile(target, "utf8")).toBe("old");
expect(finalBytes).toEqual(Buffer.from(body, "utf8"));
expect(bodySubmissions).toBe(1);
```

- [x] 12.4 同一用例覆盖权限拒绝/重新确认、optional hash 冲突，以及提示 ID 确实可消费；补拒绝重复 ID、跨工具、同批/未结算、历史缺失和解析错误的复用回归。纯合法 content_from 包装只展开正文，不继承源路径/hash/覆盖；不绕过重复失败或未知结果检查。按范围跑 core/tools 及类型，独立审核。

### Task 13: 展示时序验证与完整交付

**Files:** 已有 provider tool-generation-progress、core tool-workflow/model-retry、services agent-event-projector、Desktop tool-generation-presentation/agent-activity-message 测试；现有 Desktop session-subscription-service.coalescing.test.ts 补受控暂停案例。独立审核已确认组内缺口，最小生产修正限于 assistant-message.tsx 的生成项分组/呈现和必要原有 label/helper；对应 assistant-message.tool-details.test.tsx 与暂停案例补组内断言。不改 API、投影、生成项身份或数据库。

**Consumes:** 真实工具生成事件、当前 run.metadata.toolGeneration、现有 Desktop 生成项/正式项交接。

**Produces:** 参数流未结束时 Write 在工具组可见且未执行的证据；既有取消/失败/交接仍通过。没有第二套状态表或数据库 part。

- [x] 13.1 读本轮 progress-audit.md，确定已有覆盖与唯一缺口。使用显式释放的暂停门，不用固定睡眠或等待完整流才检查。暂停时检查 generation progress（名称 Write）已到达展示输入、工具组有生成 Write、目标文件尚不存在；释放后正式项接管且只有一个结果。

```ts
const generation = await nextGenerationEvent; // 由真实受控流触发，不伪造最终成功结果。
expect(generation.tools[0].toolName).toBe("Write");
expect(generatedGroup.toolName).toBe("Write");
expect(generatedGroup.toolUseId).toBeUndefined();
expect(executions).toBe(0);
releaseArguments();
```

- [x] 13.2 复用取消、模型失败重试、晚到 ID、多同名工具、终态和正式工具交接回归。若当前行为已满足，补证据/测试，不为了“有改动”重写生产 UI；不能以 loading 可见代替工具组。

  已确认的 Task 13 修正：先补有效 UI RED，证明相邻已完成工具与生成 Write 位于同一工具活动区域、折叠标题仍看得到 Write；展开后生成行没有空详情、不计作已调用/编辑。复用 ToolActivityGroup，只移入既有生成行并删独立 tool-generation 内容分支；不新建组件/动画/状态管理。保留普通单工具直接展示、原展开状态、叙事/终端边界和正式结果。暂停测试必须断言真实组结构及内部 Write，而不是孤立文案；初始化 store/会话放入受保护 try/finally，关闭已创建的资源，临时目录只用本次 mkdtemp 的准确返回值。
- [x] 13.3 主代理新鲜运行三个任务受影响测试和类型、文档/架构/diff 检查；必要 Desktop 独立构建到新的忽略目录，不覆盖已有 out。汇总删除/新增、正常与恢复调用次数、真实模型未验证等限制，再对本轮实际增量做最强独立整体审核。
- [x] 13.4 在 §24 写审核、修正和交付证据；保留本轮基点和报告，不动其他任务证据，不提交/push/部署/重启。

## 24. 文件工具收敛执行账本

- [x] §22 Spec 子代理审核 Spec Approved；建议已明确写入 §23，未实现前不把设计批准当成功。
- [x] §23 同文件计划与职责/接口自检。
- [x] Task 11 实施及独立审核。
- [x] Task 12 实施及独立审核。
- [x] Task 13 时序验证、最终检查及整体审核。

| 任务/关系 | 交界检查 | 结论 |
|---|---|---|
| Task 11 | schema 普通 object，执行只收有效平面输入，安全断言不删 | 与 §22 一致；不以直接 execute 新建成功替代引擎测试 |
| Task 12 | 包装修正与失败正文读取各自验证；无自动混合合并 | 与 §22 一致；扫描整链后给引用，提示/使用共用判断 |
| Task 13 | 实时展示和正式调用的现有交接；暂停门先断言再释放 | 与 §22 一致；不要求同一数据库 part |
| 11 → 12 | schema/reuse/helper 共享两处文件与联测 | 串行实施；12 不恢复动态准备，不引入根级 oneOf |
| 11/12 → 13 | 模型/工具完成边界与现有生成卡 | 只补缺失时序证据，生产 UI 默认保持 |

工作区：codex/tool-workflow-audit-convergence，HEAD b7988381；本轮开始已有前轮未提交修改。沿用已约定 checkout，不另建 worktree、不自动提交；审核使用 `.superpowers/write-workflow-convergence/base/` 十九份本轮起点，不能用 HEAD diff 把前轮修改误算成本轮。技能 Bash 脚本会重定向写文件并默认使用旧统一文档目录，本轮用 apply_patch 实现相同的 brief/diff 包装规则，并使用独立证据目录。

基线 core 参数/schema 与 reuse 两文件的首次命令仅因沙箱不能读取已安装 Vitest 依赖退出，不是行为 RED；原命令通过审批后重试。后续记录真实结果。

基线复验：core/tool-input-schema.test.ts 45 与 query-tool-preparation.reuse.test.ts 21，共 66/66 通过，exit 0。Task 11 已交独立实施者，尚未审核；Task 12 未开始。生成展示只读审计确认现有生产路径满足设计、位于 HEAD，缺的是受控暂停的跨入口时序证据，不是已发现的展示实现故障。

Task 11 范围补充：协调员只读确认 read.ts:121 的工具说明仍要求 Write action=prepare，明确纳入删去这一句的同步；不改 Read.info_only 数据与策略行为。实施者先补当前副本，仍按最小提示消费/文件安全回归验证。

并发工作区事实：实施期间 HEAD 被外部更新为 aa36b9e9（Desktop 任务耗时与单次工具展示提交），包含部分当前 core 改动；协调员和实施者没有 Git 写操作。保留该提交和其他并发文件，本轮仍按起点副本生成增量，不用变化后的 HEAD 隐藏已经发生的修改。

Task 11: review Needs fixes — Critical 0 / Important 1 / Minor 0。删除准备专用测试时同时删去 Write 入口的新建竞争者保护回归；生产排他创建逻辑仍在，协调员已核对旧副本，要求迁入 write.test.ts 的普通平面调用。先保存修正前测试副本，原实施者做限定测试修正；Task 12 仍未开始。

Task 11: complete — 有效一次 Write 引擎回放 RED→GREEN；tools 48、core 72 与 index 29、prompts 48、Read+workflow 51（范围有重叠）及三包类型通过。I1 仅迁移旧竞争安全测试，新增用例 1/1、Write 全文件 29/29，实际原始终端输出在报告末尾；既有行为首次即绿，不伪称新 RED。限定复审 I1 ADDRESSED，无新问题，最终 Spec Compliant / Quality Approved。核心和工具调用现在是稳定平面参数、正常新建一个 Write，两次模型请求，无准备/先读。四个准备专用实现/测试移除，起点副本可恢复；并发 HEAD 保留。

Task 12: in_progress — 七个新的任务起点副本已存 task-12-base，沿用普通 schema 和当前历史，只做有限纯包装解包与唯一完整正文恢复；不自动执行混合包装。

Task 12: complete — 仅两个生产文件及三个现有测试。有效 RED 为 core 11 项、真实 mixed Write 缺引用提示 1 项；声明业务字段根正文另补 1 项 RED。GREEN 为 core 89/89、tools reuse/workflow 7/7，core/tools 类型通过。真实临时文件：mixed 首次 not_started 且未写；下一轮从失败正文取得 opaque 引用，平面参数重新确认后逐字节落盘，正文只提交一次。不同正文/多分支/业务字段/组合 schema 的内部/循环/九层拒绝；根层空串及同值候选保持兼容。独立 Spec Compliant / Quality Approved，无三档问题；没有参数混合自动执行、缓存或新引用形式。

Task 11 格式收尾：竞争测试迁移后的 write.test.ts 多余 EOF 空行已由原实施者仅用 apply_patch 移除，单文件 diff check 从 1 转 0；没有改断言/生产代码，不重复 29/29 绿测。最终审核包含当前版本。

Task 13: in_progress — 采用审计确认的既有生产路径；优先在 Desktop 主进程的现有订阅测试增加一个受控 OpenAI 原始流暂停的全链成功案例，临时隔离数据库和文件，不碰用户数据。不重建 UI、事件或状态表。

Task 13: review Needs fixes — 真实 provider→IPC→Transcript 的暂停时序和一次落盘成立，但独立审核指出生成项仍由 assistant-message 的独立 tool-generation 分支渲染，未进入用户要求的 ToolActivityGroup。协调员核对源码及早先明确“loading 可见而 tool group 无 Write”的反馈后确认该缺口；不能把区域中的一条状态行解释为已经满足组内展示。§22.4 与本 Task 13 最小修正范围已澄清，保持现有风格、真实未执行事实和不重复交接。另一个测试资源初始化清理建议一并处理。此前60项绿测和构建只证明原状态行可见，不作为这一组内要求的最终完成证据；最终应对修正后的版本重新验证/构建到新目录。

Task 13: fix round 1 addressed — 澄清 Spec 子审 Approved；有效 UI RED 为单生成项无组容器、Read组无Write，两项失败。仅 assistant-message.tsx 将既有生成行移入既有 ToolActivityGroup，删除独立内容分支；折叠标题含Write，展开没有空详情，统计只算正式项。两个既有测试文件补真实组内/全生成项断言和临时资源初始化清理，不加组件、状态、事件或依赖。相关七文件98/98、Desktop Node/Web类型、边界及检测器[]通过；限定复审 P1/P2 ADDRESSED、Spec Compliant / Quality Approved，无新阻断。13.3/13.4 尚待协调员最终验证与最强整体审核。

整体增量起点：包含补存 Read 与两份首次 UI 修改前副本，共23个源码/测试变化文件（包括此前未跟踪准备专用文件的删除），增加516/删除956，净减440行；不含本文档、忽略证据、前轮Shell/AskUser/Edit反馈和用户并发任务耗时代码。空白 EOF 副本噪声已明确从审核包排除。当前完整包为 final-review-complete.diff，不用当前HEAD差异代替。

Task 13: complete — 协调员独立新鲜验证：core171、tools140、prompts48、API23、runtime7、server投影13、修正后的Desktop98，共500项Vitest范围（不叠加实施者/早期60项重叠测试），全部exit0；另31项架构检查器契约通过。core/tools/prompts与Desktop Node/Web类型、371文档、architecture122、Desktop工作区边界、完整diff检查通过。最终构建使用已安装桌面构建器，输出到全新 desktop-build-reviewed/，main/preload/renderer三阶段exit0，main/index.js、main/host-entry.mjs、preload/index.js、renderer/index.html四入口存在。未覆盖out、启动应用或动当前任务。

最终最强独立整体审核：23文件完整增量及跨任务消费边界，Spec Compliant / Quality Approved、Critical0、Important0、Minor1，可交付。非阻断Minor是测试等待事件永不到达时，Vitest外层超时不保证等待中的测试体进入finally，临时DB/Run可能保留至worker结束；属于测试清理韧性，当前正常/初始化异常清理和取消/重试回归通过，不增加生产恢复平台。报告与完整证据位于本轮忽略目录 final-review.md、final-verification.md。

实际收敛：生产代码11文件（含准备实现删除）增加86/删除294，净减208行；测试12文件增加430/删除662，净减232行。正常新建一个Write/一次正文/两轮模型请求；混合包装恢复为首次拒绝、下一次明确参数引用正文，两个Write/一次正文，不再先准备。保留所有执行前权限及文件保护；UI生成项现在属于真实工具组，而非独立loading行，不计已执行/已编辑。

交付边界：仅本地脚本化客户端和真实临时文件/数据库回放，未调用真实收费模型、比较供应商速度、做实际Electron窗口截图或使用用户数据库，不声称真实模型错误率或首次生成速度已经改善。原生供应商尚未给工具名/参数片段时不能提前显示Write，历史压缩仍可能使正文引用丢失。非致命构建提示保持原样（新outDir不自动清空、prompt混合动态静态导入、pet.test无Route），不为它们扩展此轮范围。保留并发aa36b9e9及当前功能分支；协调员/实施者未提交、push、合并、删除分支或重启。当前运行服务不因源代码更新自动刷新，需用户加载新版本后以新任务验证实际效果。

## 25. Shell 长输出：短预览、有限留存与补读 Spec

### 25.1 目标与已确认的原因

前台 Shell 当前只在内存保留约 12,000 字符的首尾；中间内容丢失后，再放大模型输出预算也找不回来。旧执行器还存在只取头部、逐块解码的问题。后台已经使用 10 MiB 的日志文件，但保留最新尾部，超过上限时旧内容确实丢失；JobRead 是进度读取，不是完整日志分页。

本轮使普通长命令输出在首次执行时就能有限留存，返回短预览和可补读的引用，不要求模型重跑命令。遵循 OpenCode 的有效原则：捕获原输出与模型预览分开，省略时给出补读入口；不照搬其目录、附件系统或第二套执行器。

范围包含内置前台 Shell 的执行环境路径（本机、WSL）及默认旧执行器路径；默认运行时接入日志能力，直接使用工具而未注入日志能力时保持兼容并明确不能补读。后台复用已有落盘限制，在现有任务 metadata／JobRead snapshot 中补齐上限、写入失败的真实说明，原日志文本及字符游标不改变；不把 JobRead 的更新时间游标宣传成逐页读取。后台既有日志不迁移、不额外复制，也不改变“查看最新进度”的语义。

不处理供应商耗时、模型选择、自动重跑、实时 UI 日志流、历史压缩的永久保存、任意工具输出的通用文件仓库，或原生插件协议改造。现有短命令、退出码、权限、取消、真实后台任务启动条件保持不变。

### 25.2 运行过程与职责边界

1. 默认运行时把一个可选的 Shell 输出日志接口放入 ToolContext；引擎只传递接口，不知道磁盘目录，也不决定截取方式。
2. Shell 在命令真正执行前取得本次捕获对象。stdout、stderr 分别流式解码，再把已解码片段交给日志和首尾预览；不能先截断再保存。
3. 输出超过 12,000 字符时，把先前保留的短缓冲和后续片段落盘。短输出不建日志文件。默认旧执行器增加可选输出回调，现有两参数调用仍可用；不用另起进程跑相同命令。
4. 捕获结束后，Shell 返回原来的执行结果、短预览、短日志引用，以及留存状态。失败、超时、取消和执行器异常也尽量返回已经收到的内容；没有确认正常收完的结果不能声称日志完整。
5. Read／Grep 识别日志引用后交给该接口处理，普通文件继续走原有路径和权限检查。附件 Read 的现有包装仍可委托普通 Read，因此不用另注册同名替代工具。
6. 模型历史预算只负责减少文本，同时保留至多一个有界的补读提示。恢复历史或下一次请求再次缩短结果时也不能悄悄丢掉提示。

代码归属：core 定义小接口、传递上下文和执行通用预算；services 保管有限日志和执行受控补读；tools 负责 Shell 捕获、预览以及 Read／Grep 的日志分支；agent-runtime 负责默认装配。通过 tools 已有的 services 依赖导出窄工厂给运行时使用，不给 agent-runtime 新增 services 依赖。不得新增数据库表、事件、模型工具、日志代理、独立进程运行器或磁盘路径权限例外。

### 25.3 日志引用、留存与资源限制

- 引用格式为 `shell-output://<UUID>`，UUID 由宿主生成，不从模型提供的 toolUseId、文件路径或命令拼出。磁盘只使用固定托管目录下的严格 UUID 文件名，引用中不含真实路径。
- 元信息记录拥有者的 sessionId 摘要、留存字节数、日志上限状态及是否确认正常收完。只允许当前 ToolContext.sessionId 与拥有者精确匹配；子会话不自动继承父会话日志权限，无 sessionId 时不返回可读引用。跨会话、非法引用、不存在和到期统一返回不可用，不暴露其他会话是否存在。
- 前台保留最前面的最多 10 MiB UTF-8 内容，达到上限后停止落盘但继续收集最后预览；实际拒写后续字节时说明“仅保留前部，后续已丢失”，不能称完整日志。恰好填满上限而没有额外字节不算丢失。这样游标稳定，也避免超过上限后每个小片段重写整个日志。在已有 bounded-output-file 帮助函数中增加前部保留模式并返回实际丢弃事实，默认尾部模式不变。
- 只在完整字符边界落盘和分页；stdout/stderr 的先后为回调收到顺序，不承诺还原两个独立管道的绝对时间顺序。
- 托管目录默认保留 7 天、最多 64 份日志，每份最多 10 MiB；创建时清理到期及最旧的已结束日志。活动捕获不清理；64 份全在活动时不创建第 65 份，返回日志不可用但命令仍照常执行。计数覆盖所有会话，不能只约束单个目录。
- 目录和日志须为托管位置的普通目录／文件，拒绝符号链接和重解析到目录外的对象；读者不能把引用转换为任意宿主路径。清理只处理本机制严格命名的文件和对应元信息，不清理现有 tasks、用户目录或其他工作区。
- 写入失败不改变命令成功／失败事实，也不终止原命令；日志不可完整补读时必须明确说明，不能只在后台吞掉异常。部分文件若可验证并读取，可标记“不完整”并返回已有内容；不能验证时不返回有效引用。
- 元信息采用同目录小文件，不建索引数据库或全文件内容缓存；只维护活动捕获必要的状态。重启后仍可验证所属会话及已完成日志，未正常完成的日志按不完整处理。无合法元信息的非活动、严格命名、普通日志文件也要按现有时间／配额规则回收，不能因一次创建失败永久占住名额；活动、链接和非托管文件不误删。

### 25.4 Read／Grep 的补读约定

Read 通过 `file_path` 收取日志引用，日志分支新增 `cursor`（非负安全整数，UTF-8 字节位置），默认 0；每次最多返回 8 KiB 正文，结果给出下一次 cursor 和是否到末尾。core 导出已有通用工具预算额度的只读函数，Read 按本次有效 inline 限额扣除短页头所需空间后请求页面；宿主钳制 maxBytes 至 8 KiB。返回总文本不能触发第二次截断，nextCursor 只按实际可展示的正文 UTF-8 字节数推进。最小 inline=256／preview=128 时仍能读取至少一个完整字符，不能为了保正文绕过总预算。普通路径的 offset／limit 行语义完全不变，cursor 对普通文件不产生新含义。日志不加普通文件的行前缀，允许长单行通过多页完整读取。游标若落在多字节字符内部或超出留存范围，明确返回输入错误，不静默跳过内容。日志分支拒绝 info_only、offset、limit 等冲突用法并给正确示例。

Grep 通过 `path` 收取日志引用，保留 pattern 的正则表达式含义和 caseSensitive，返回有界的匹配位置和短片段，再用 Read cursor 查看上下文。截取匹配短片段时只用系统内置的可见字符分段，避免拆开复合表情；这是显示预览的规则，不改变日志原文或 Read 的 UTF-8 字节分页。使用宿主 ripgrep 的直接参数调用，不拼 shell 命令；超长单行不能因为普通 Grep 的整行过滤而误报无匹配。搜索最长 5 秒，最多 32 KiB 子进程输出及 200 个匹配，最终工具文本不超过约 8 KiB。正则无效、搜索输出超过上限或缺少 ripgrep 时给明确反馈和 Read 补读示例，不回退到对 10 MiB 日志执行无时限 JS 正则。日志不参与 include 文件 glob，传入时提示移除。

日志读／搜属于已有 Read／Grep 工具调用，仍经过引擎的工具许可、确认及取消机制；引用不会执行命令，也不能授权写、Edit 或 ApplyPatch。

参数冲突、坏游标和无效正则才归参数错误；资源不可用、缺少宿主／搜索程序、超时或取消分别保留真实原因，不能把正确参数导入“修正调用”的纠错计数。确知尚未开始才能给 not_started，无法确认搜索是否执行过时保守给 unknown；不改变普通文件错误平台。

### 25.5 用户与模型看到的事实

- 预览省略但日志全部留存：说明中间只是未展示，提供 Read／Grep 示例。
- 因 10 MiB 上限实际拒写了后续内容：说明留存的前部范围及后续无法恢复；短预览仍可包含最后收到的内容。
- 异常、取消或日志写入失败：区分命令结果与日志不完整／不可用，不建议自动重跑有副作用的命令。
- 未注入日志能力：保留现有短预览并说明中间未保存，不给虚假的日志引用。
- 后台因现有尾部留存上限实际裁剪了早期内容：说明早期内容已经丢失；写入失败说明日志不完整。保持 JobRead 的最新进度语义，不声称用旧 cursor 就能补回中间内容。

补读提示使用一个独立短文本块 `[tool-output-ref: shell-output://<UUID>]`，不超过 96 字符。通用预算至多保护一个格式正确的短引用块；额外空间固定有界，不保护任意正文、路径或指令。错误格式化的状态／恢复提示可以放在前面，但不能把这个短块再次切掉。引用不是高优先级指令，读取时仍检查当前会话。UI 不需要新增卡片或流式事件，本轮只保证真实结果中有提示。

### 25.6 验收

- 同一条超过预览上限但未超过留存上限的命令，只执行一次；首尾预览在限额内，Read 能找回位于原先省略中间的独特文本。
- 普通短输出不落盘；整块大输出、小块跨 UTF-8 字符、stdout/stderr 交错、超长单行均覆盖；分页拼接与留存内容一致。
- 10 MiB 上限、到期清理、64 份全活动、写入失败、目录／文件链接、坏游标、跨会话、缺少会话、重启后的元信息均有有效断言。
- 默认运行时、附件 Read 包装、执行环境 Shell 和默认旧执行器各有消费端证据；直接未注入接口调用保持兼容。
- 错误结果、取消／异常已收到的输出，以及最小历史预算与再次预算时的引用保留有回归测试。真实引擎以最小预算反复调用 Read，正文分页拼接与留存内容一致，不能只测试直接 execute 的 nextCursor。
- 后台旧尾部策略、真实任务生命周期与现有 JobRead 游标不改变；新增日志上限和写入失败说明有测试。
- 不修改并发任务的请求设置／能力测试、其他文档，不启动应用、覆盖 desktop/out、重跑真实用户命令或使用用户数据库。完成后只报告本轮范围的测试和未覆盖的实际模型／桌面体验，不宣称供应商耗时或错误率已经下降。

## 26. Shell 长输出实施计划

权威：已获独立审核批准的 §25。执行分为三个顺序任务；每个任务先有有效 RED、再最小实现、再限定独立审核，最后协调员验证实际消费端并整体审核。代码只在 `codex/shell-output-retention` 分支改动，不提交、不重启。忽略证据目录为 `.superpowers/shell-output-retention/`，不覆盖前轮证据。

### 全局约束

- 不新增依赖、模型工具、数据库表、事件、日志代理或第二套进程运行器；后台不改成前部留存，前台不假冒后台任务。
- 日志由宿主管理，引用不能包含真实路径；每次补读精确检查当前 sessionId。普通文件和附件路径不放宽权限。
- 默认前台预览 12,000 字符，日志最多前部 10 MiB，7 天／64 份全局限制，活动日志不删；Read 正文最多 8 KiB且服从有效历史预算；Grep 正则搜索最多 5 秒／32 KiB 进程输出／200 匹配，最终约 8 KiB。
- 实际拒写／裁剪才标丢失；写入失败不能改变原命令结果；未知是否收完不能称完整；不自动重跑。
- 保留并发文件；本轮不修改 `docs/README.md`、原生插件 Spec、请求配置测试、`run-capability-mcp.test.ts` 和 `run-capability-view.test.ts`。测试仅用 mkdtemp 的准确临时目录及脚本化客户端，清理只涉及本轮夹具。

### Task 14：小接口和有界日志保管

- [x] 14.1 core `types/tools.ts` 定义 `ShellOutputLogHost`、捕获对象及日志状态／页结果，ToolContext 加可选 `shellOutputLogs`；`types/runtime.ts` 的 QueryEngineOptions 同样加可选接口，`index.ts` 导出类型。采用 begin(sessionId, inlineChars) → append(text)／finish(complete)；read 接收 sessionId、reference、cursor、maxBytes；search 接收 sessionId、reference、正则参数和取消信号。finish 可重复调用但只完成一次，不让日志错误逃出至原命令。
- [x] 14.2 在已有 `bounded-output-file.ts` 添加前部留存模式与 `{retainedBytes, discardedBytes}` 返回；三参数默认尾部策略不变。前部模式只 append、不重写旧内容，以 UTF-8 完整边界保存字符串，严格保证上限及实际拒写事实。
- [x] 14.3 services 新建一个集中但不泛化的 `shell-output-log.ts`：懒落盘、严格 UUID 引用、会话摘要验证、独立托管子目录、小元信息、全局清理与活动配额、有界读取及直接受限 ripgrep 搜索。默认目录为已有 tasks 目录的 `shell-output` 子目录，创建时才访问；测试可指定临时目录。不让模型选择目录。services executions 子入口导出工厂。
- [x] 14.4 core `query-tool-limits.ts` 导出现有 inline 预算额度的只读函数供 Read 取页；不复制环境变量解析。此任务不实现引用保护，留 Task 16。
- [x] 14.5 services 与 core 针对相关新行为先 RED 再 GREEN：大块、边界、分页长单行、坏游标、跨会话／缺会话、重启、配额／TTL、链接、写入失败和搜索真实正则/超限反馈。仅运行受影响测试和 core/services 类型；写完整报告，限定独立审核后才能下个任务。

### Task 15：前台捕获与现有 Read／Grep 补读

- [x] 15.1 tools Shell 两条路径在预览丢弃前调用捕获。默认 executor.run 增加可选第三参数输出回调，保留现有调用；stdout／stderr 独立流式解码并保留现有可支持编码，默认预览也统一首尾。正常 close、异常、超时／取消都正确收尾，不遗漏已收到内容或把确认未知状态改成成功；已取消输入不启动进程。
- [x] 15.2 Shell 输出用独立短块 `[tool-output-ref: shell-output://<UUID>]` 给定位，其他块给首尾和留存说明。没有接口／sessionId／可用文件时明确不可补读；输出上限和日志写入失败不得改命令退出事实。
- [x] 15.3 普通 `fileReadTool`／`grepTool` 增加日志引用分支，schema 和说明给调用方式；Read 页头保持短，按 Task 14 导出的 inline 限额减去页头空间取最多 8 KiB，实际返回总文本不触发引擎再次截断；nextCursor 对应实际展示正文。日志明确拒绝普通行参数和 info_only，普通路径仍完全走原来逻辑；Grep 明确拒绝日志 include，保持正则并返回可用字节位置。
- [x] 15.4 tools 导出窄日志工厂，让下一任务的默认运行时无需新增包依赖。不要为静态 Read／Grep 工厂化或换注册系统。
- [x] 15.5 有效测试涵盖两条 Shell 路径、单次执行找回中间、短输出不写、编码跨块、长单行、失败／取消／异常、未注入兼容、普通文件原行为以及附件 Read 委托。最小 inline 额度下直接返回页不超预算；真正引擎历史循环验收留 Task 16。测试和 tools 类型通过，写报告，限定独立审核。

### Task 16：默认装配、历史保护与后台事实

- [x] 16.1 agent-runtime 在默认创建 QueryEngineOptions 时提供 Task 15 窄工厂的日志接口；QueryEngine 传入真实 ToolContext。自定义直接引擎可通过该可选 Options 注入；不加 RunCapabilityView 能力选择或 RuntimeEnginePort setter，不改原生插件传输协议。
- [x] 16.2 通用 `applyToolOutputBudget` 至多保留一个格式正确且不超过 96 字符的独立 `[tool-output-ref: <无空白引用>]` 文本块；不识别 Shell 目录／权限，也不保护任意正文。截短 notice 在恰好按块耗尽预算时也要真实说明。覆盖错误格式化后、最小预算、重复／伪长提示、图像和历史再次预算。
- [x] 16.3 后台 supervisor 依据帮助函数真实 discardedBytes 在 task.metadata 增补 `outputDiscardedBytes`（已知正整数计数的十进制字符串），写入失败置 `outputWriteFailed="1"`。第一次产生裁剪／失败事实时发布既有 updated 事件，正常终态再发布最终统计，不逐输出块额外发事件。原 readOutput 保持纯日志，不拼说明文字、不影响字符游标。server 既有 `session-execution-projector.ts` 仅窄映射这两个合法字段（不全量复制任意 metadata），沿既有持久任务到 daemon JobRead snapshot 返回；local snapshot 原来就复制元信息。验证真实工具结果能读到说明，不能只测 supervisor 内存。查看最新尾部及已有游标类型不变，不加额外文件／schema／UI／新后台工具。
- [x] 16.4 脚本化真实引擎用日志引用连续补读，尤其 inline=256／preview=128 的长单行，拼接确认无跳字节。默认运行时注入、附件包装、后台裁剪／失败通过 local 及 daemon 既有投影→JobRead snapshot 的消费链，和权限拒绝／跨会话消费边界有证据；不访问用户日志或调用实际模型。
- [x] 16.5 主代理新鲜运行受影响范围、类型和文档／架构／diff 检查；不为无前端改动执行桌面构建。整体独立审核全增量与跨任务交界，有发现则一个统一修订任务并限定复审。本文 §27 记录数量、验证、限制及交付状态。

## 27. Shell 长输出执行账本

- [x] §25 Spec 独立审核与修订，最终 Approved；修订了 Read 二次预算造成游标漏读和“恰好填满即丢失”的错误断言。
- [x] §26 同文档计划及职责／接口自检。
- [x] Task 14 有界日志与小接口（限定独立审核及第一轮修复复审通过；工具消费链待后续任务）。
- [x] Task 15 前台捕获、Read／Grep（独立审核及两轮限定修正复审通过；真实运行时／引擎消费待 Task 16）。
- [x] Task 16 默认运行时、历史保护、后台事实及整体验证。

| 任务／交界 | 实际检查 | 结论 |
|---|---|---|
| Task 14 | 新端口只收会话、引用和受限读参数；上限事实与默认尾部模式分开 | 与 §25 一致；不放入工具注册／UI |
| Task 15 | 可选捕获回调与原 executor 参数兼容；静态 Read 分支仍被附件包装委托 | 与 §25 一致；不新造同名工具 |
| Task 16 | 固定可选 QueryEngineOptions 到真实上下文，不加能力 setter；通用预算不认识宿主目录 | 与 §25 一致 |
| Task 14 → 15 | typed capture/page API、UTF-8 字节、inline 预算额度 | 后者按实际展示推进游标；不复制解析逻辑 |
| Task 14 → 16 | appendBoundedOutput 返回真实丢弃统计，默认 tail 不变 | 后者只增事实，不迁移后台文件 |
| Task 15 → 16 | 固定短 ref 块与窄工厂、Read bounded page | 后者保护有界引用，并验真实引擎循环无漏读 |

执行起点：`124254275340d7528b58bb28fc5258eebfd62133`。已有并发变更不属于本轮。使用当前独立功能分支而非新 linked worktree，避免现有 workspace 依赖链接指回原目录；不混入无关变更，不提交／合并／push。证据目录保留至用户需要的提交操作，不按通用 Skill 自动删除未提交证据。

最终实施／审核结果：Task 14（宿主）第一次独立审核发现分页 FEFF、捕获后父目录链接替换及 NUL 搜索误报，修正与限定复审通过。Task 15（工具）修正长匹配误报、UTF-8 字节限额及复合表情预览，原首尾／兼容／普通文件边界通过。Task 16（消费）修正读取异常假空输出／游标归零，命令状态不改，只有明确已知写失败的 local 消费者用现有 details 说明不可读并保留 after；未知纯读失败继续传播，监听／超时 promise 正确清理并拒绝。各阶段原始 RED、GREEN 与范围记录在本轮忽略证据目录，重复测试不相加。

最强整体审核完整 34 文件增量，初次 3 Important、1 Minor：环境入口流首 FEFF、孤儿配额永久占满、搜索失败误触发参数纠错及真正新进程恢复证据。一个统一修订 wave 在现有函数内完成；最后 Read 日志 unavailable 分类变化导致 server 附件消费者的一条旧 invalid_input 断言失败，按批准分类更新为 unknown_outcome／unknown 后同会话正文／跨会话拒绝均保持。七文件限定复审 I1／I2／I3／M1 全 ADDRESSED，未发现新 Critical／Important，可以交付。没有把“测试绿”当成静态审核问题已经解决的证据。

协调员最终有效门禁：core 80、services 69、tools 143、agent-runtime 40、server 43，共 **375** 项全部 exit 0；这是各范围最新修订状态，不叠加实施者／早期 358、363 或定向复验。最小 inline=256／preview=128 的真实脚本化 QueryEngine 约 129 页完整拼接、BOM／NUL／长中文及复合表情、同会话／跨会话、真实新进程无 finish／正常 finish 恢复、活动配额／孤儿回收、后台 supervisor→投影→临时 DB 关闭重开→真实 JobRead JSON均有证据。五个包最终 TypeScript exit 0、无诊断；文档 373 Markdown、职责边界 122 条检查和仅本轮 diff 检查通过。架构依赖首次受 sandbox 限制及关闭 autocrlf 产生的 CR 假阳性已排除，不因此改依赖或 Git 配置。

规模／边界：34 个源码和测试文件；生产 19 文件 +645／−79，净增 566 行；测试 15 文件 +1165／−6，净增 1159 行。只新增一个专用生产日志保管模块，复用原有限落盘、工具注册、运行时装配、上下文、后台 metadata 与投影；没有新依赖、模型工具、DB 表、事件类型、进程运行器、权限例外、日志索引或前端组件。一般命令仍一个 Shell 执行；补读是新的 Read／Grep 调用，不重跑有副作用的命令。

本轮两个明确裁定：后台说明进入既有 metadata／snapshot，原 readOutput 不拼文字，避免破坏字符 cursor；若消费界面需另显示，后续只调整显示位置，不删除或改变原日志。Grep 的匹配短预览用系统内置 Intl.Segmenter，不拆复合表情，不推广成 Read 或全部文本的分段平台；若这项显示要求不必要，可去掉小分段与对应测试，原字节配额仍有效。

交付限制：未调用真实模型、比较供应商耗时、读取用户数据库／日志、做真实 Electron 窗口验证或启动／重启应用；不能据此宣称实际模型错误率或首次生成速度下降。默认运行时已接入日志；直接自定义 ctx 未注入或缺 sid 会明确不可补读。前台最多前部 10 MiB，七天／64 份回收后不保证永久可读；后台仍是旧最新 tail 和进度 cursor，不承诺完整分页；普通 Read 仍按行。TOCTOU 对抗交换和主机断电耐久性不作保证，正常链接替换和新进程无 finish 退出恢复已测；历史整体压缩或工具外层超时可能使引用不可用，不为这些边界扩成永久恢复平台。

Git 交付：当前保留 `codex/shell-output-retention`，本轮未提交／合并／push／删除分支；HEAD 的并发 `ac0f47e2` 仅提交此前用户 request-configuration.test.ts 上下文，不属于本轮，未撤销或混入审核。保留并发 docs／原生插件计划／两份能力测试；忽略证据目录不自动清理。未改变运行中的应用，用户加载新版本后才可观察实际体验。

## 28. 文件工作流后续验收 Spec（2026-10-03）

用户已经确认工具组会显示 Write 正在生成参数及接收字符数，本轮不改生成展示。模型／供应商耗时对比和首次生成提速继续排除。以现有实现为起点，修复有证据的问题，不重新引入准备协议、读取状态缓存或通用重试机制。

### 28.1 已确认的事实与范围

- Write 的 `content_from` 已能复用失败正文，重新检查权限和当前文件；现有范围测试通过。模型仍全文重发属于调用选择问题，不能把脚本化模型测试当作真实模型遵从率证据。本轮保留机制，增加两次调用间文件实际变化的安全验收，不自动猜测覆盖意图或重试。
- 最近 Edit 失败的旧字符串含字面量 `\n`。既有 EscapeNormalized 匹配会找到实际多行原文，但跨度保护按未展开的一行输入比较，返回“匹配范围过大”。新字符串也含字面量 `\n`，不能仅放开保护或自动解码新字符串，否则可能写入错误内容或破坏合法源码转义。本轮准确诊断这个已确认场景，并保留拒绝和有界原文，让模型直接纠正参数。
- Shell 已实现有限留存和引用补读。已有 tools 主链测试主要使用受控执行器；本轮补一项真实本机进程经默认 Shell 捕获，再由同会话 Read／Grep 补读的验收，不新建日志体系。

### 28.2 职责与不变条件

- Edit 的特殊说明只放在 `tools/file/edit-feedback.ts`。仅当 `disproportionate` 首步失败只有一个候选，且原文候选切片（按已有 BOM／CRLF 规则对齐）严格等于把旧字符串字面量 `\n` 展开后的文本时，说明换行输入问题；普通跨度异常、歧义及未匹配反馈不变。保留 `invalid_input/not_started` 和原有匹配诊断字段，不更改匹配算法或替换文本。
- Write 仍由 core 展开正文、权限层重新授权、文件工具核对目标。复用引用不继承源路径、覆盖意图、hash 或许可，不复制失败正文到反馈。
- Shell 仍由工具捕获、宿主保管日志，Read／Grep 使用原引用和会话约束。真实验收只在测试临时目录生成合成输出，不触碰用户任务目录或历史日志。
- 不修改已确认工作的 UI、不新增依赖／工具／DB 表／事件／生产状态；保留无关工作区改动，不提交、push、重建 out 或重启应用。

### 28.3 验收条件

1. 复现最近的六行 Edit：字面量换行参数仍不写文件，但明确说明应使用实际换行，返回原文；修正为实际换行后下一次 Edit 成功。合法源码中的字面量转义不被自动改写；原歧义、跨度、批次原子性、BOM／CRLF 回归保留。
2. 首次 Write 失败后，测试真实改变目标内容；下一次只给 `content_from`、显式覆盖和旧 hash，必须拒绝且保持新文件内容。正常短引用复用与重新授权继续通过。
3. 一个真实本机命令只运行一次，产生超限输出后给出引用；首尾预览省略中间标记，Read 分页完整还原，Grep 找回标记，跨会话拒绝。失败退出的留存事实继续由已有范围测试验证。
4. 仅运行受影响测试和类型检查；独立审核文档与最终增量。自动测试不等于真实模型错误率下降，也不证明正在运行的桌面进程已经加载本轮源码。

## 29. 文件工作流后续实施计划（2026-10-03）

**Goal:** 明确诊断已确认的换行参数问题，并补齐已有复用／补读机制的真实边界验收。

**Architecture:** 只修改现有 Edit 反馈函数；预览、匹配、替换和授权路径保持不变。其余两项仅补测试，不创建新的运行机制。

**Tech Stack:** 现有 TypeScript、Vitest、Node.js 文件及子进程能力，无新依赖。

**Spec:** 本文 §28，独立审核已通过；采用现有功能分支，不创建依赖链接可能指回主工作区的 linked worktree。

**Global Constraints:** 不改 UI／匹配算法／覆盖规则，不自动解码新字符串；不调用真实模型／用户数据库，不重启／构建 out／提交／push。

### Task 17：换行参数诊断

**Files:** `tools/file/edit-feedback.ts`；`tools/file/__test__/edit-batch.test.ts`。

**Interfaces:** 消费现有 `EditPlanError`、首个原文候选和 `ToolResult.recoveryHint`；不新增字段或导出。

- [x] 在既有临时文件 fixture 添加最近六行文本的字面量换行失败、纠正后成功，以及合法源码转义保持原样的回归。有效 RED 失败于缺少准确的换行纠正提示，不是加载错误。
- [x] 最小实现按以下条件选择说明，保留原始错误种类、原文窗口、字节不变及下一次正常修改：

```ts
const escapedLineBreaks = error.editIndex === 1 && error.match?.kind === "disproportionate"
  && error.match.matchCount === 1 && error.edit?.old_string.includes("\\n")
  && error.match.locations.length === 1
  && body.slice(error.match.locations[0]!.start, error.match.locations[0]!.end)
    .replaceAll("\r\n", "\n") === error.edit.old_string.replaceAll("\\n", "\n");
```

- [x] 仅在此条件下说明 old_string 应使用实际原文换行，new_string 仍为字面替换，只有确需多行时才传实际换行；不解码字符串，不写失败步骤。
- [x] 运行 `edit-batch.test.ts`、`edit.test.ts`、`edit-replacers.test.ts`，保留原歧义／跨度／两行转义契约。

### Task 18：复用内容遇到真实目标变化

**Files:** `tools/file/__test__/write-content-reuse.integration.test.ts`。

**Interfaces:** 既有真实 QueryEngine／Write 和脚本化模型 fixture；新增选项只属于测试函数。

- [x] 让场景在两轮调用之间实际 `writeFile(file, "externally updated")`，引用调用携带旧文件 `sha256("old")`。
- [x] 断言新调用没有 content、只引用已生成正文，真实文件保持 `externally updated`，结果为 `invalid_input/not_started`。现实现通过，仅补验收，不改生产逻辑。
- [x] 运行该文件及既有 `write.test.ts`、`file-workflow.integration.test.ts`。

### Task 19：真实 Shell 进程补读

**Files:** `tools/shell/__test__/shell-output-log.test.ts`。

**Interfaces:** 默认 `createShellTool()`、现有日志工厂、真实 Read／Grep；不用自造执行器。

- [x] 在测试临时目录写 Node 合成输出脚本：启动计数写入该目录，输出前后长中文段及唯一中间标记。Windows 使用 PowerShell 调用运算符和单引号参数，POSIX 使用标准单引号参数；不访问外部数据。
- [x] 显式 timeout 走前台一次命令；断言首尾预览可见且无中间标记、引用可消费、Read 游标前进并完整拼接、Grep 找回标记、跨会话拒绝，以及启动计数为 1。
- [x] 运行日志工具、真实引擎补读及 services 日志范围；现实现通过，仅补验收，不改生产逻辑。

### Task 20：范围验证与独立审核

- [x] 合并运行受影响 tools 范围，执行 tools TypeScript 检查和本轮 `git diff --check`；不重复完整工作区测试。
- [x] 由未参与实现的审核员检查本轮限定增量与 §28，不混入已有无关改动；记录真实结果及未验证边界。

## 30. 后续验收结果（2026-10-03）

Spec 与最终增量均经独立审核，未发现 Critical／Important。审核建议补验真实 Shell 首尾预览，已补断言并复验。Edit 的有效 RED 为新增回归缺少准确换行说明；随后三文件 101 项通过。最终 tools 八文件 **158 项通过**，tools TypeScript exit 0；审核员另跑三变更测试文件 54 项通过，首尾断言补充后 Shell 文件 19 项通过。这些是同一批测试的不同阶段，不累加成额外覆盖数量。实施前另有 core 34／services 22 项既有复用及日志范围通过。

本轮只改变 Edit 的纠正说明，原非法输入仍拒绝，匹配和替换协议不变；Write 与 Shell 的运行机制没有改变。真实命令验收在当前 Windows 主机完成，其他平台仅有分支实现与既有测试，未做现场验收。未调用真实模型、读取用户数据库、重建 out 或重启应用；不能宣称真实模型已停止全文重发、错误率下降或正在运行的应用已加载本轮代码。功能分支 `codex/file-workflow-followup` 保留，本轮未提交／合并／push，已有无关改动保持原样。

后续授权：用户要求提交并 push 本轮代码，覆盖此前“不提交／push”的交付边界。提交范围仅为本轮 Edit 反馈、三份验收测试及本文档，共五个文件；推送当前功能分支，不合并主分支、不创建 PR，不包含其他未提交改动。实际提交与远端状态以 Git 验证结果为准。
