# Native / WSL 智能体运行环境实现计划

> 状态：已完成并合并到 `main`（2026-09-08）。

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 用轻量 Native / WSL 会话环境替换 Docker Agent Runtime，保留独立 SRT 能力并彻底删除 Docker 专属代码。

**架构：** 保留统一 `ExecutionEnvironmentHandle`，删除容器才需要的 manager/lease。Local 直接使用宿主进程；Windows WSL 通过 `wsl.exe` 提供 POSIX 进程、文件、路径和 PTY。全局设置在 daemon 重启后生效。

**技术栈：** TypeScript、Node.js child_process、node-pty、Electron、Vitest、pnpm workspace

---

### 任务 1：扩展内部环境契约并实现 WSL 基础适配器

**文件：** `packages/environment/src/types.ts`、`packages/sandbox/src/environment/wsl-environment.ts`、`packages/sandbox/src/environment/execution-environment.ts`、对应测试与导出。

- [x] 写失败测试：`local | wsl` binding、Windows 盘符双向转换、UNC 项目拒绝、非 Windows/缺少 WSL 时 fail-closed。
- [x] 实现默认发行版预检、path resolver、`wsl.exe --exec` Shell/argv executor 和 PTY target，不管理发行版列表。
- [x] 保持现有路径临时可编译，运行 environment/sandbox 测试。
- [x] 提交 `feat(runtime): add WSL execution adapter`。

### 任务 2：接通 WSL 文件工具和所有环境工作负载

**文件：** `packages/tools/src/file/operations.ts`、`sandbox-guard.ts`、shell executor/registry、`packages/mcp/src/connections/sandbox-stdio-transport.ts`、`packages/hooks/src/index.ts`、`packages/services/src/lsp/index.ts`、detached supervisor、background shell service 与对应测试。

- [x] 写失败测试：WSL stat/list/text/binary/glob/grep 使用环境进程；`/home` 不因“未挂载”被拒绝；命令转后台后仍使用 WSL executor。
- [x] 实现 WSL FileOperations 和环境进程注入；路径与内容使用 argv/stdin 传输。
- [x] 将 Bash、后台 Shell、MCP stdio、command hook、LSP 统一到 handle.process；保留 Native SRT。
- [x] 更新工具环境声明，Native Plugin Tool 在 WSL 不注册；运行相关测试。
- [x] 提交 `feat(runtime): route WSL workloads through one environment`。

### 任务 3：接通 WSL 终端

**文件：** protocol terminal/serialization、terminal-node target/provider、server daemon terminal、Desktop main terminal service/`apply-preferred-shell`、renderer terminal model/tool 与对应测试。

- [x] 写失败测试：WSL 用户终端与 Agent Terminal 使用相同 execution cwd；Desktop 不注入 PowerShell；input/resize/Ctrl-C 进入 WSL PTY。
- [x] 收敛 `runtime: local | sandbox` 与 `explicitHost`，默认终端跟随环境。
- [x] node-pty 启动 `wsl.exe`；WSL 使用默认 shell，Native 用户终端继续使用 Shell 设置。
- [x] 运行 protocol、terminal-node、server 和 Desktop terminal model 测试。
- [x] 提交 `feat(terminal): follow Native or WSL session environment`。

### 任务 4：切换全局设置和 Desktop 产品表面

**文件：** core settings types/load/tests、sandbox execution config/tests、Desktop shared settings、main settings service/tests、renderer runtime setting model/control/content/tests。

- [x] 写失败测试：默认 `native`；Windows 保存/预检 WSL；macOS/Linux 不显示也拒绝 WSL；旧 Docker 配置不决定环境。
- [x] 新增全局 `agentEnvironment.kind`，映射为内部 `local | wsl`；设置变更要求重启，不新增 session 字段。
- [x] Docker 配置不再进入 Desktop/Agent 主路径；WSL 与 SRT 同时启用时 fail-closed。
- [x] 运行 core、sandbox 和 Desktop settings 测试。
- [x] 提交 `feat(settings): select Native or WSL agent environment`。

### 任务 5：删除 Docker 生命周期和共享实例体系

**文件：** server session environment/daemon application/default application、agent composition；删除 sandbox Docker backend、orphan reconciler、managed mounts、lifecycle、session、environment manager、Dockerfile 和对应测试。

- [x] 调整测试，证明 root/fork/child 从同一全局配置和各自 cwd 获得等价环境，不需要 lease/owner alias。
- [x] server acquirer 改成轻量环境工厂，删除 daemon orphan reconciliation 和 manager dispose。
- [x] 删除 Docker backend、挂载、session、生命周期、复用、label、hash、orphan reconciliation、identity 和 lease。
- [x] 运行 environment/sandbox/server/agent-runtime 测试与类型检查。
- [x] 提交 `refactor(runtime): remove Docker lifecycle`。

### 任务 6：清理 Docker 配置、CLI、依赖和跨包残留

**文件：** core/sandbox 配置、tools/mcp/prompts/hooks/services 残留、CLI sandbox 命令、package manifests、lockfile、测试与 README。

- [x] 写失败测试：公开设置不再接受 Docker backend、docker 配置和 `dockerShell`；SRT policy/config 仍可用。
- [x] 删除 Docker 环境变量、DockerFileOperations、Docker PTY、runtime 状态和工具声明中的 Docker kind。
- [x] 逐包清理依赖，只移除 Docker 用途；保留 SRT/policy/host process 消费者。
- [x] 运行依赖审计、全仓类型检查和非前端测试。
- [x] 提交 `chore(runtime): remove Docker runtime surface`。

### 任务 7：文档与真实 WSL 验收

**文件：** `packages/sandbox/__test__/e2e/wsl.e2e.test.ts`、sandbox scripts、runtime acceptance、sandbox flow/design、安全边界、CLI README。

- [x] E2E 验证 uname、环境变量、退出码、带空格路径、文件、glob/grep、Ctrl-C 和 resize；无 WSL 时明确 skip。
- [x] 验证盘符项目与 Skill 路径映射；验证 WSL UNC 项目返回不支持。
- [x] 验证 WSL 会话中的 `attachment://` 仍走宿主控制面。
- [x] 更新文档，明确 WSL 不是安全沙箱、SRT 仍独立存在。
- [x] 全仓类型检查、非前端测试、可用的 WSL E2E 和 `rg` 残留复盘。
- [x] 提交 `docs(runtime): finish Native and WSL migration`。
