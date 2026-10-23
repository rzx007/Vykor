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
| [src/__test__](src/__test__) | 提示词层次、规则加载和分类统计测试 |

宿主调用构建函数后，模块读取环境与文件来源，整理为稳定、项目上下文、易变内容三组，再按顺序渲染为字符串返回。组装结果由调用方保存；个人提示词和待确认更新保存在配置目录，项目事实由 personalization 包保存，项目记忆正文由宿主传入。

新增提示词段放入现有组装流程，文件读写集中在个人提示词文件模块，测试放 `src/__test__/`。

## 设计

- [Prompt 三层分层与 SOUL.md / USER.md 迁移](../../docs/prompt-layering-design.md)

## 测试

```bash
pnpm --filter @vykor/prompts test
```
