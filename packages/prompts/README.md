# @vykor/prompts

组装模型使用的系统提示词，汇总身份、环境、权限说明、项目规则、个人资料和项目记忆。

默认从工作目录向上加载 `AGENTS.md`、`CLAUDE.md`、`.claude/CLAUDE.md`
和 `.claude/rules/*.md`。提示词明确要求就近目录的规则优先，同目录下
`AGENTS.md` 优先于 Claude 规则；用户明确要求优先于项目流程建议，权限边界仍须遵守。

技能按用户点名或当前任务的实际需要加载，简单修改不强制进入规划或审批流程。

## 目录与入口

公开入口是 [`src/index.ts`](src/index.ts)，通过 `@vykor/prompts` 导入 `buildRuntimeSystemPrompt()`、`buildPromptLayers()`、个人提示词文件 API 和上下文用量分段 API。

| 文件与目录 | 用途 |
| --- | --- |
| [src](src/README.md) | 源码导航、提示词组装流程和扩展位置 |
| [src/prompt-segments-assembly.ts](src/prompt-segments-assembly.ts) | 按来源和层次组装片段 |
| [src/personal-prompt-files.ts](src/personal-prompt-files.ts) | `SOUL.md`、`USER.md` 的检查、加载与更新 |
| [src/ledger-segments.ts](src/ledger-segments.ts) | 供上下文用量估算使用的分类片段 |
| [src/reply-styles.ts](src/reply-styles.ts) | 三档回复风格与共享沟通规则 |
| [src/__test__](src/__test__) | 提示词层次、规则加载和分类统计测试 |

宿主调用构建函数后，模块读取环境与文件来源，整理为稳定、项目上下文、易变内容三组，再按顺序渲染为字符串返回。组装结果由调用方保存；个人提示词和待确认更新保存在配置目录，项目事实由 personalization 包保存，项目记忆正文由宿主传入。

新增提示词段放入现有组装流程，文件读写集中在个人提示词文件模块，测试放 `src/__test__/`。

## 回复风格

`replyStyle` 支持 `collaborative`（协作，默认）、`direct`（直接）、`explanatory`（讲解）。调用 `buildRuntimeSystemPrompt({ replyStyle })` 或 `buildPromptLayers({ replyStyle })` 时选择其中一套，进度通知仍由 `workStyle` 控制。快速模式保留这两项偏好及必要验证，不另行强制简短回答。

桌面在“设置 → 常规 → 回复风格”修改全局默认。程序接口通过 Agent 配置或 `host.configuration.updateConfiguration({ replyStyle: "direct" })` 为当前 Agent 选择风格；会话 runtime 的 `replyStyle: "inherit"` 恢复跟随全局默认。会话显式值优先，子 Agent 未设置时继承父 Agent 当前请求采用的值。宿主显式传入完整 `systemPrompt` 时保留原文，不附加风格段。

自动化测试验证配置最终进入模型请求，不把提示词字符串检查当成真实模型风格评测。[人工对照场景](reply-style-evaluation.md) 说明如何比较实际生成结果。

当前风格段由四条共用规则和所选档的简短表达偏好组成：协作连接结论、理由与影响；直接减少铺垫并紧凑表达；讲解解释已有依据、关键因果或术语。共用规则保留必要事实、当前限制和未验证项，并让用户明确要求优先。没有固定字数、段落配额、内部清单流程或校准示例。

判断、行动和验证遵循原有 Agent 规则，风格只调整表达。风格段仍位于稳定层末尾，不新增模型调用、状态或返回字段，不截断或重写输出；后续项目规则和个人偏好仍可调整表达。提示词仍可能影响模型生成，不能把执行代码未改当成模型判断绝对不受影响，需用真实模型检查遗漏与事实边界。

上下文用量优先统计 Agent 已采用的真实提示词；修改偏好后、下一次请求之前，活跃会话仍显示上一份提示词的用量。新建个人提示词模板会跟随所选风格，已有 `SOUL.md` 与 `USER.md` 不自动改写。

## 设计

- [Prompt 三层分层与 SOUL.md / USER.md 迁移](../../docs/prompt-layering-design.md)

## 测试

```bash
pnpm --filter @vykor/prompts test
```
