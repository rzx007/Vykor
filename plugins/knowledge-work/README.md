# 研究与写作

OpenHarness 官方 Native 插件，提供研究助手和写作助手。桌面应用的插件页提供“研究与写作”添加入口，添加后在会话中启用；复用现有技能、工具和子智能体机制。也可通过已有插件安装入口选择本目录。

## 能力

| 内容 | 名称 | 作用 |
| --- | --- | --- |
| 研究助手 | `vykor.knowledge-work:researcher` | 多来源调研、比较与核验，交付带出处和限制的报告 |
| 写作助手 | `vykor.knowledge-work:writer` | 从资料或报告成稿，并继续修改同一稿件 |
| 研究技能 | `knowledge-research` | 研究取证、引用和报告交付规则 |
| 写作技能 | `knowledge-write` | 写作、改写与证据边界规则 |
| 整理技能 | `knowledge-organize` | 整理用户提供的资料并保留出处 |
| 引用检查工具 | `KnowledgeResearchCheck` | 核对来源标识、引用绑定及原句匹配 |

模型通过 `Skill` 加载正文，例如 `Skill({"name":"knowledge-work:knowledge-research"})`；另外两个调用名为 `knowledge-work:knowledge-write`、`knowledge-work:knowledge-organize`。简单写作可由主助手加载技能完成，复杂任务可调度对应专家。Agent 中的 `skills` 字段不承担自动加载正文的功能。

典型使用流程：

1. “调研这个领域，给出有来源的结论。” → 研究助手交付报告。
2. “把报告写成面向产品经理的文章。” → 写作助手读取报告和证据成稿。
3. “缩短一点，保留风险部分。” → 读取当前稿件并更新同一文件。

## 文件约定

长任务按主题保存在当前可写工作目录；用户指定路径优先。

```text
knowledge-work/<topic>/
  report.md       # 当前研究报告
  draft.md        # 当前稿件
  sources.json    # 实际读取的来源数组，需要引用或交接时保存
  evidence.json   # 关键说法及对应原句数组
  check.json      # 实际运行引用检查后的结果
```

继续修改沿用当前文件，新任务使用新目录。短答案和纯文风修改不强制生成全部文件。

## 检查范围与依赖

`KnowledgeResearchCheck` 接收 `{ sources, claims }`，来源包含 `id/text`、可选 `title`，以及网页 `url` 或本地 `path` 二者之一；说法包含 `id/text/evidence`，每条证据包含 `sourceId/quote`。工具只处理传入数据，不联网、不读取文件，不判断真实性、时效性、来源独立性或原文是否足以支持结论。`attributionPassed` 为真意味着传入数据的引用对应关系正确，仍需智能体核对原文上下文和事实边界。

使用已有 `Read`、`Write`、`Edit`、`Grep`、`Glob`、`WebSearch`、`WebFetch`、`Skill` 和 `ListSkills`，不依赖 Orkas 运行环境、Python 脚本或新增服务。工具受会话已有权限控制。第一版只承诺现有工具能读取的网页、文本、Markdown、CSV 和 JSON；文件格式不支持时记录缺口，不声称已完成读取。

研究与写作规则改编自 Orkas 的 DeepResearcher、ContentWriter、deep-research、content-writer 和 material-organizer。版权及许可见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。
