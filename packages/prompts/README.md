# @vykor/prompts

Prompt 模板管理系统。

默认从工作目录向上加载 `AGENTS.md`、`CLAUDE.md`、`.claude/CLAUDE.md`
和 `.claude/rules/*.md`。提示词明确要求就近目录的规则优先，同目录下
`AGENTS.md` 优先于 Claude 规则；用户明确要求优先于项目流程建议，权限边界仍须遵守。

技能按用户点名或当前任务的实际需要加载，简单修改不强制进入规划或审批流程。

## 设计

- [Prompt 三层分层与 SOUL.md / USER.md 迁移](../../docs/prompt-layering-design.md)

## 测试

```bash
pnpm --filter @vykor/prompts test
```
