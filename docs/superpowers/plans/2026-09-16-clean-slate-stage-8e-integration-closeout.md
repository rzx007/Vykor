# Clean-slate Stage 8E：集成验收与收口实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 用隔离空环境证明当前代码可完整运行，清理剩余旧引用和历史状态说明，并准备不自动执行的本机数据重置手册。

**架构：** 集成测试只使用临时配置、项目、Desktop userData 与本地假 Provider，不访问真实 home 或公网。代码验收和本机数据删除是两个独立状态，删除动作必须在停进程、二次解析路径并获得逐项授权后执行。

**技术栈：** Node.js test runner、Vitest、CLI/Desktop builds、PowerShell、SQLite

---

## 文件结构

- 创建：`scripts/clean-slate-smoke.mjs`、`scripts/clean-slate-smoke.test.mjs`——隔离空环境 smoke harness。
- 创建：`scripts/verify-clean-slate.mjs`、`scripts/verify-clean-slate.test.mjs`——统一静态/产物检查入口。
- 创建：`docs/development-data-reset.md`——仅人工执行的数据路径审核与重置手册。
- 修改：`docs/architecture-migration-status.md`、各包 README、根 `package.json`。
- 修改：旧 Stage 8 计划头部，标注被 clean-slate 方案取代；不重写历史正文。

### 任务 1：建立隔离空环境 smoke test

- [ ] **步骤 1：写 harness 安全测试**

测试传入临时 `configDir`、`projectDir`、`desktopUserDataDir` 和本地 loopback fake provider URL。若任一路径等于用户 home、仓库根或其祖先，harness 必须在启动任何进程前失败；HTTP mock 记录所有请求，发现非 loopback URL 即失败。

- [ ] **步骤 2：运行测试确认脚本尚不存在**

运行：`node --test scripts/clean-slate-smoke.test.mjs`

预期：FAIL，找不到实现。

- [ ] **步骤 3：实现空环境流程**

流程固定为：创建临时目录 → 写当前最小配置 → 启动本地 fake provider → 启动 daemon → 等待 `/health` → Client 自动 `/capabilities` 握手 → 创建 Session → 提交 Prompt → 等待 Run → 查询最终状态 → 关闭 daemon → 断言无子进程和端口残留。所有临时目录在成功和失败时都清理。

- [ ] **步骤 4：覆盖 CLI 与 Desktop userData**

CLI 使用同一临时配置和项目执行当前命令；Desktop 主进程测试注入临时 `userData` 并证明建库路径位于该目录。这里不启动可见 GUI，也不读取真实用户目录。

- [ ] **步骤 5：验证 smoke test**

运行：`node --test scripts/clean-slate-smoke.test.mjs`

预期：PASS，日志列出临时根、协议版本、创建的 session/run id 和清理结果，不包含 token 或真实 home。

### 任务 2：建立全仓 clean-slate verifier

- [ ] **步骤 1：写失败 fixture**

临时 fixture 分别放入旧 Client 方法、`--bare`、`.claude/skills` 扫描字符串、plugin `compatibility` 字段、`legacyShellDescriptor` 和第二个 migration SQL，断言 verifier 报出分类、文件和行号。

- [ ] **步骤 2：实现统一校验**

`verify-clean-slate.mjs` 组合 forbidden scanner、Client contract 对比、migration 文件数量、protocol version/header、workflow 结构和 build artifact inventory；返回非零退出码时打印全部问题而不是首错退出。

- [ ] **步骤 3：接入根脚本**

增加：

```json
{
  "check:clean-slate": "node scripts/verify-clean-slate.mjs",
  "test:clean-slate": "node --test scripts/verify-clean-slate.test.mjs scripts/clean-slate-smoke.test.mjs"
}
```

并让 `check:architecture` 包含 `check:clean-slate`。

- [ ] **步骤 4：执行旧引用归零审计**

运行：

```powershell
rg -n -i '(client-compat|removal ledger|compatibility lifecycle|legacyShellDescriptor|\.claude/skills|--bare)' packages apps scripts tests docs/*.md .github package.json
```

每条结果必须是 forbidden 清单、专用负向测试或历史 `docs/superpowers`；其他结果当场删除、重命名或根据设计矩阵证明为当前可靠性能力。

### 任务 3：更新当前文档与历史状态

- [ ] **步骤 1：更新当前入口说明**

Client README 只展示 Resource；Services README 说明 Repository/Transaction 与保留的数据库 kernel；Protocol README 说明版本 4、握手例外和 header；Skills/Plugins README 只描述当前目录、schema 与 scope。

- [ ] **步骤 2：收口架构状态**

`docs/architecture-migration-status.md` 写明 Stage 8 clean-slate 完成、旧 A/B/C 发行策略取消、历史计划被设计文档取代。删除递减数量和“等待下一发行”的状态。

- [ ] **步骤 3：编写数据重置手册**

手册固定要求：列出 override config 的 OpenHarness 独占叶子、默认配置叶子、项目 `.openharness-ts`、Desktop userData 和 cache；对每项输出输入路径、规范绝对路径、symlink/junction 最终路径、允许根、可恢复性。禁止盘符根、home、workspace root 及其祖先。

手册中的 PowerShell 预检使用 `Resolve-Path` 与 `[IO.Path]::GetFullPath()`，删除前后各执行一次；停止 daemon/CLI/Desktop 后重新解析同一清单。删除命令只在用户逐项明确授权后手工填写精确 `-LiteralPath`，文档不得提供通配符或递归删除用户目录的示例。

- [ ] **步骤 4：标记旧计划被取代**

给 `2026-09-16-client-stage-8a` 至 `8f` 和旧 Stage 8 overview 增加醒目标记，链接 clean-slate 设计与总计划；保留原文作为决策历史。

### 任务 4：全仓验证与最终提交

- [ ] **步骤 1：运行快速静态门禁**

```powershell
pnpm check-types
pnpm check:architecture
pnpm check-docs
pnpm test:scripts
pnpm check:clean-slate
git diff --check
```

预期：全部 PASS。

- [ ] **步骤 2：运行完整测试与构建**

```powershell
pnpm test
pnpm build
pnpm test:clean-slate
```

预期：全部 PASS。若 Windows/WSL 并发出现已知 `AttachConsole failed`，只串行复跑失败文件并在验收记录中保存原始失败和串行通过输出。

- [ ] **步骤 3：执行包级重点回归**

```powershell
pnpm --filter @openharness/protocol test
pnpm --filter @openharness/client test
pnpm --filter @openharness/services test
pnpm --filter @openharness/server test
pnpm --filter @openharness/plugins test
pnpm --filter @openharness/plugin-converters test
pnpm --filter @openharness/agent-runtime test
pnpm --filter @openharness/desktop test
```

预期：全部 PASS。

- [ ] **步骤 4：提交 8E**

```powershell
git add scripts package.json docs packages apps .github
git commit -m "test: close clean-slate compatibility removal"
```

- [ ] **步骤 5：停止在代码完成边界**

报告 commit、验证结果和已知环境例外。不得自动 push、创建 tag、发布或删除真实数据。若用户随后要求数据重置，先按 `docs/development-data-reset.md` 展示精确路径并取得逐项授权。
