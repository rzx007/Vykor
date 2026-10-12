# 研究工具

只在开展取证、预算、压缩、引用检查或恢复研究时读取。所有示例中的主题、URL、来源 ID 和快照 UUID 都是示例，实际调用必须使用工具返回的值。

## 实际来源与抓取记录

WebFetch 返回的 `Tool-Result-Id` 是本轮工具调用编号，不是持久来源 UUID。先调用 `{"op":"import","tool_result_id":"实际编号"}`，插件取得实际结果并保存，返回 `source_ref`。学术检索直接保存每篇资料并返回来源 UUID，无需导入。后续读取、压缩和引用检查都使用 `source_ref`。

`KnowledgeResearchSources` 接收 `source_refs`（最多 24 个插件来源 UUID）、可选 `since`（ISO 时间）和 `max_chars`（默认 12000，范围 0–50000，是所有返回来源共享的正文字符预算）。它读取实际来源记录，返回 `sources`、当前会话的 `fetch_ledger`、`as_of`、`ledger_complete` 和 `issues`；找不到、读取失败、记录不完整或截断时按返回问题处理。

研究开始先取时间起点：

```json
{"source_refs":[]}
```

保存返回的 `as_of` 为 `started_at`。网页成功和失败都应导入；本轮结果过大、已被淘汰或跨 Run 时无法导入，必须记录缺口。学术结果检查 `storage_issues`，保存失败的资料不能冒充已有持久来源。取回原文和本研究已保存的请求账本：

```json
{"source_refs":["11111111-1111-4111-8111-111111111111"],"since":"2026-10-12T00:00:00.000Z","max_chars":12000}
```

来源工具只读 `plugin.dataDir/research`。插件自行保存正文、URL 与书目，并用校验和检测记录损坏；它不是宿主认证或不可篡改的审计证据。

来源只截取部分正文时，引用不得超出实际已取得的范围。用户本地材料使用真实路径和读取的正文；没有快照引用时仅能作传入文字的对应检查。校验和不证明来源内容真实或结论语义正确。

## 预算

`KnowledgeResearchBudget` 接收 `op: "plan" | "account"`，返回 `{ "ok": true, "data": ... }`。计划去重并裁剪问题，提供实际生效的上限。子问题数量还会受总抓取次数限制，无法分配至少一次抓取的问题会列在 `dropped.fetch_budget`：

```json
{"op":"plan","subquestions":["产品实际能力","使用限制"],"caps":{"max_fetches":12,"max_subquestions":4}}
```

把真实结果与起点保存为：

```text
research-plan.json = { started_at: 实际as_of, budget_plan: 实际plan返回值 }
```

统计时将 `budget_plan` 原样传到 `plan`，不要将整个带 `started_at` 的存档作为工具的 `plan`。将真实 `fetch_ledger` 的 `kind/status/url` 字段按工具输入形状投影后传入，不改变值、不丢弃失败尝试；快照引用和时间等完整元数据仍保存在本地台账。

```json
{"op":"account","plan":{"caps":{"max_fetches":12}},"fetch_ledger":[{"kind":"fetch","url":"https://example.org/report","status":"error"}]}
```

失败也算一次尝试；学术工具记录实际 HTTP 请求，PubMed 的查询和取摘要分别计数，重定向也计数。网页账本来自实际结果的显式导入，同一 Run 同一调用重复导入不重复计数。每次 `account` 使用自 `started_at` 起的已保存账本，不能只传最新一批。`ledger_complete` 只说明账本读取完整，不保证网页均已导入或写入从未失败。缺少记录时不得声称预算准确。模型调用和费用仍需真实记录，不能把默认零当实际支出。

## 学术检索

`KnowledgeAcademicSearch` 接收 `query`、可选 `sources`、`limit`（每来源默认 5）和 `timeout`（秒，默认 30），返回 `{ "ok": true, "data": { "results": [...], "errors": [...] } }`。

```json
{"query":"enterprise knowledge management retrieval","sources":["arxiv","crossref"],"limit":5,"timeout":30}
```

支持 arXiv、OpenAlex、Crossref、Semantic Scholar、PubMed。各服务可能限流、拒绝或无法访问，成功调用不代表所有来源成功。结果的 `text` 是 API 实际提供的摘要，可能为空或本身不完整；保留书目、实际链接、DOI、`source_ref` 和限制，不据此声称读了全文。论文方法、实验细节和完整结论需要另外读取可用全文。

## 证据压缩

`KnowledgeEvidenceCompress` 接收 `query`、`sources`、`max_chars`（默认 12000）、可选 `max_per_source` 和 `min_score`，返回 `{ "ok": true, "data": { "kept": [...], "stats": ... } }`。

```json
{"query":"适用限制","sources":[{"id":"S1","url":"https://example.org/report","text":"实际取得的来源原文"}],"max_chars":12000,"max_per_source":4}
```

`kept` 中的 `source` 是输入来源 ID，`chunk` 是保留原句，`chunk_index` 是片段位置。输入保留 `source_ref`、`text_truncated` 和工具允许的书目字段，压缩片段继续携带这些值；原始来源表也保留它们，以 ID 关联回去。查看 `stats` 的裁剪与遗漏，重要证据被去掉时定向补读，而非把未返回内容当作已经核实。

## 引用和比较检查

`KnowledgeResearchCheck` 省略 `op` 时兼容 `{ sources, claims }` 的旧 `evidence: [{ sourceId, quote }]` 结构。新研究使用完整 `op: "verify"`；`references` 整理书目，`report` 返回格式化报告内容。完整检查支持原句、DOI、URL 归属和逐字段比较，不做语义推理。

来源保留 `id`、实际 `url` 或本地 `path`、正文 `text`、实际存在的书目和 `source_ref`。说法使用 `id/text` 和 `citations`：

```json
{
  "op":"verify",
  "recorded_only":true,
  "sources":[{"id":"S1","url":"https://example.org/report","source_ref":"11111111-1111-4111-8111-111111111111","text":"试点覆盖三个团队，但尚未测量长期效果。"}],
  "claims":[{"id":"C1","text":"试点覆盖三个团队，长期效果未测量。","citations":[{"source":"S1","quote":"试点覆盖三个团队，但尚未测量长期效果。"}]}]
}
```

网页与学术研究使用 `recorded_only: true`，要求来源能与插件来源记录对应。原句不足 12 个字符只标为弱证据，不能作为充分核对结果；未知来源、原句缺失、DOI 格式或归属问题需要补充有效证据、缩小说法或公开缺口。本地用户材料不伪造快照引用。

对比表的 `comparison` 每行使用 `candidate`、`evidence_sources` 和 `field_claims`；事实字段必须绑定其候选来源的具体说法 ID，不能用一条总引用装饰整行。模板字段为 `os/setup_ease/model_capabilities/local_offline/privacy_data_handling/pricing_cost/key_limitations`；不适用或缺乏证据时填 `Not verified`，不为填满表格编造信息。`best_for/ideal_user` 是智能体判断，说明依据。

`report` 还接收 `title` 与 `analysis_markdown`，保留分析中的 Markdown 换行并返回 `report_markdown`。它只组装提供的分析和检查表，最终事实结论、限制和推荐仍由智能体负责。工具返回后用已有 `Write/Edit` 保存报告，它不会替你修改文件。
