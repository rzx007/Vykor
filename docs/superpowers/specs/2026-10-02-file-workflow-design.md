# 文件修改完整流程：统一 Spec 与实施记录

> 状态：第一轮完整流程与生成工具卡修订已完成（§1–§14）；整体审核后的收口修正正在推进（§15 起）。交付为工作区改动，不替用户提交、部署或重启应用。

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
