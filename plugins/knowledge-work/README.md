# 研究与写作

OpenHarness 官方 Native 插件，版本 1.1.0。插件包括研究与写作流程及六个检查／整理脚本，使用 Node 标准库。

## 安装、升级和授权

桌面应用插件页的“研究与写作”内置行，未安装时显示“添加”，已安装 1.0.0 时显示“更新”。点击后沿用现有安装及权限确认流程，成功后从下一次对话生效；原本已禁用的插件保持禁用。也可导入同 ID 的新版包，或用 CLI 安装本目录并通过 `--approve` 明确批准 manifest 请求的权限。只重载旧安装快照不会升级工具或补齐新增权限。

本版本需要两类插件权限：读写插件自己的数据目录；来源读取限定在 `plugin.dataDir/research`；访问五个固定 HTTPS 学术 API（arXiv、OpenAlex、Crossref、Semantic Scholar、PubMed）。来源读取工具严格限定在该目录，学术访问仅用于检索书目与摘要。普通网页读取和稿件读写仍通过应用已有的 `WebFetch/Read/Write/Edit` 及会话权限执行，插件权限不替代这些授权。新增权限需要安装链路确认，具体以 [.vykor-plugin/plugin.json](.vykor-plugin/plugin.json) 和应用的权限列表为准。

同一插件 ID 的导入就是更新；旧版批准不足以覆盖本版时会重新显示新增权限。安装后不会自动启用原本已禁用的插件。

## 角色和调用

| 内容 | 名称 | 作用 |
| --- | --- | --- |
| 研究助手 | `vykor.knowledge-work:researcher` | 多来源调研、比较与核验，交付有出处和限制的报告 |
| 写作助手 | `vykor.knowledge-work:writer` | 从资料或报告成稿，并继续修改当前稿件 |
| 研究技能 | `knowledge-work:knowledge-research` | 真实取证、预算、压缩和引用规则 |
| 写作技能 | `knowledge-work:knowledge-write` | 写作、忠实改写、覆盖检查与审校 |
| 整理技能 | `knowledge-work:knowledge-organize` | 整理用户提供的资料并保留出处 |

主助手可以直接加载技能处理简单任务，也可调度对应专家，例如：

```javascript
Skill({ name: "knowledge-work:knowledge-write" })
Agent({ description: "调研知识管理工具", subagentType: "vykor.knowledge-work:researcher", prompt: "比较这些工具的能力和限制，保存有来源的研究报告。" })
Agent({ description: "从报告写文章", subagentType: "vykor.knowledge-work:writer", prompt: "读取 knowledge-work/topic/report.md 及来源文件，写成面向产品经理的文章。" })
```

实际稿件路径由任务决定。Agent 的 `skills` 字段不负责自动加载正文，角色提示词明确要求通过 `Skill` 调用。

## 工具

| 名称 | 作用 | 返回范围 |
| --- | --- | --- |
| `KnowledgeResearchSources` | 读取宿主保存的实际来源和当前会话抓取尝试 | 来源原文、引用、起点时间与台账是否完整 |
| `KnowledgeResearchBudget` | 去重研究问题，计算累计预算 | 停止建议，不自动拦截其他工具 |
| `KnowledgeAcademicSearch` | 并行检索五个学术 API | 真实书目和摘要，各来源失败单独报告 |
| `KnowledgeEvidenceCompress` | 原文切片、去重、排序并按预算保留 | 来源 ID 与原句，不生成模型摘要 |
| `KnowledgeResearchCheck` | 引用、原句、DOI、比较字段检查及报告组装 | 归属与结构检查，不判断语义支持 |
| `KnowledgeWritingGate` | 写作所需证据分类覆盖、来源去重、日期提醒 | `READY_TO_DRAFT / CONTINUE_RESEARCH` |
| `KnowledgeContentAudit` | 稿件统计、表达候选和源文词法对照 | 候选问题，不自动判定事实或发布通过 |

参数与调用样例见[研究工具手册](skills/research/references/tools.md)和[写作检查手册](skills/write/references/checks.md)，角色只按当前任务加载需要的说明。

## 使用流程与成果

1. “调研这个领域。” → 保存 `as_of` 起点与预算，取得真实来源，保留 `Tool-Result-Id`，通过来源工具取得 `source_ref`，检查引用并交付报告。
2. “把报告写成文章。” → 读取完整报告、来源和限制，检查所需证据覆盖后成稿。
3. “缩短一点，保留风险部分。” → 重读当前稿件，保留用户手工修改和事实边界，更新同一文件。纯改写不要求重新联网研究。

长任务按主题保存在当前可写工作目录；用户指定路径优先。文件按需创建，短答案和纯文风修改无需生成一套台账。

```text
knowledge-work/<topic>/
  report.md             # 当前研究报告
  draft.md              # 当前稿件
  sources.json          # 实际来源及 source_ref
  evidence.json         # 关键说法与原句、引用
  research-plan.json    # started_at 与预算 plan 结果
  fetch-ledger.json     # 自起点以来的真实抓取尝试
  check.json            # 实际引用检查结果
  writing-gate.json     # 需要交接时的覆盖检查
  audit.json            # 需要交接时的稿件审校
```

继续修改沿用当前文件，新独立任务使用新目录。检索资料由插件保存在稳定的 `plugin.dataDir/research`，默认位于 `~/.vykor/plugins/data/vykor.knowledge-work/research`，与代码升级和项目路径分开。报告、稿件和交付用的来源表继续按用户指定路径保存；来源记录无法取回时记录缺口。

## 检查边界

比较项保持用户给定的含义与顺序，第三方解释、规范、规划和已实现功能分开。引用未匹配时先回查保存原文；来源读取提供保存长度、读取范围和截断状态，不能猜测“记录截断”原因。报告工具只有在引用检查通过时组装分析正文，否则返回 `report_ready: false`、工具错误与缺口报告，不能宣称原结论已核验。研究转写作需加载写作技能，读取检查文件并运行必要覆盖检查与审校，保留用户现有文件内容及未核实项。这些约束减少流程遗漏，不代替模型对含义与事实的判断。

学术工具在实际检索路径直接保存来源，并返回 `source_ref`。网页继续使用 WebFetch：得到 `Tool-Result-Id` 后调用 `KnowledgeResearchSources({op:"import",tool_result_id:"实际调用编号"})` 导入本轮原始结果。宿主只提供有范围和大小限制的结果读取，不自动落盘或签名。导入结果中的 `source_ref` 是插件来源 UUID，后续据此读取、压缩和核对。

研究开始先从 `KnowledgeResearchSources` 取得 `as_of`，预算累计使用 `since: started_at` 的账本。每次 WebFetch 成功或失败结果都应显式导入；学术工具直接记录每次 HTTP 请求，包括多阶段查询与重定向。外部研究用 `recorded_only: true` 和实际 `source_ref` 核对保存资料，不接受模型转抄正文来替代这条路径。

插件自行维护来源格式和请求账本，校验和仅检测损坏，不提供宿主认证、防用户篡改或独立审计保证。数据与插件版本分离，普通更新和卸载保留数据；数据迁移和缓存清理由插件负责。当前没有自动清理或删除数据的界面。

不读取或迁移之前的宿主结果快照与签名记录；旧引用应重新取得。`ledger_complete` 只表示当前账本文件读取完整，不能证明没有漏导入网页结果、写入失败或记录删除。学术返回 `storage_issues`、网页没有可读结果编号或没有成功导入时应记录缺口，不能声称预算已完整核验。宿主结果读取只限本轮，重启后使用插件已经保存的来源。

引用匹配和字段覆盖不证明结论成立。学术结果只是摘要，API 可能限流、失败或不提供摘要；尚未读取论文全文时不声称已完成全文审查。写作覆盖通过只表明输入台账覆盖所需分类，日期是否足够新、来源是否独立仍需判断。稿件对照只比较数字、标记、披露和特定表达，事实、否定、范围和限制的语义保留由智能体逐项核对。

依赖现有工具可读取的网页、文本、Markdown、CSV 和 JSON；未增加 PDF、Word 或 Excel 的解析器。格式不支持时明确记录未处理项。

规则及算法改编自 Orkas，版权和许可见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。
