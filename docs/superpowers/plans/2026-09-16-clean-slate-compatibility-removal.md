# Clean-slate 兼容层清理总实施计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 删除 OpenHarness 自身历史兼容入口，只保留当前 API、配置、协议和数据库基线，并保持当前可靠性与跨平台能力。

**架构：** 工作分为五个可以独立审查的批次。前四批依次收口 Client、应用与存储边界、其他消费者与底层包、协议与数据库；第五批统一验证、更新事实源并准备受控的数据重置。旧名只保留在测试专用 forbidden-surface 清单中，生产代码和当前文档不得引用。

**技术栈：** TypeScript、Node.js、pnpm/Turborepo、Vitest、Hono、Drizzle ORM、SQLite、Electron、GitHub Actions

---

## 执行规则

- 使用独立 worktree 和 `codex/clean-slate-compatibility-removal` 分支。
- 按 8A → 8B → 8C → 8D → 8E 顺序执行；每个子计划通过自己的验证后提交一次或多次小提交。
- 不运行真实发布，不创建 tag，不推送，不删除本机数据；这些动作分别等待用户明确授权。
- `OpenAI-compatible` Provider、Codex/Claude 插件导入、Attachment capability、Windows/WSL/PowerShell/Bash 选择以及事务、恢复、重试、取消均为当前能力，不属于删除对象。
- 遇到包含 `legacy`、`compatibility`、`migration` 或 `fallback` 的代码时，先根据调用链判断它是否服务当前行为；不得按关键词批量删除。
- Windows/WSL E2E 并发出现 `node-pty AttachConsole failed` 时，只串行复跑对应文件；串行仍失败即视为真实失败。

## 子计划与交付顺序

| 批次 | 文档 | 独立交付物 | 进入条件 |
| --- | --- | --- | --- |
| 8A | `2026-09-16-clean-slate-stage-8a-client-governance.md` | 118 个 Client facade 和兼容发行治理一次性删除，永久旧名负向门禁生效 | 当前 main |
| 8B | `2026-09-16-clean-slate-stage-8b-application-storage.md` | Session 应用服务与 Store 只保留当前职责 | 8A 通过 |
| 8C | `2026-09-16-clean-slate-stage-8c-consumers-packages.md` | Desktop/Frontend/CLI 与底层包不再接受旧入口 | 8B 通过 |
| 8D | `2026-09-16-clean-slate-stage-8d-protocol-database.md` | 协议精确握手与单一数据库基线 | 8C 通过 |
| 8E | `2026-09-16-clean-slate-stage-8e-integration-closeout.md` | 空环境集成验收、文档收口和安全重置手册 | 8D 通过 |

## 全局完成门禁

- [ ] `pnpm check-types`
- [ ] `pnpm test`
- [ ] `pnpm build`
- [ ] `pnpm check:architecture`
- [ ] `pnpm check-docs`
- [ ] `pnpm test:scripts`
- [ ] `git diff --check`
- [ ] 在临时配置、项目和 Desktop userData 目录中完成空环境启动与当前 Client/CLI 会话流程。
- [ ] 旧名除 `scripts/forbidden-compatibility-surfaces.json` 和专用负向测试外全仓归零。
- [ ] 本机真实数据仍未删除；若需要切换，单独执行 8E 的人工授权步骤。

## 计划完成后的状态

代码合并完成只表示仓库已支持 clean-slate 当前版本，不表示用户数据已经切换。最终交接必须分别记录：

1. 代码是否合并并推送；
2. 临时空环境验证是否通过；
3. 本机数据是否仍保留；
4. 若已重置，本次用户逐项授权的精确路径和删除后验证结果。
