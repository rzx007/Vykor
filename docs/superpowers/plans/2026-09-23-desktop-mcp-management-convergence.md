# 桌面端 MCP 管理入口与真实配置收敛实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法跟踪进度。当前工作区有用户的其他改动，逐任务核对差异，仅提交本任务文件。

**目标：** 主页面“插件 → MCP”管理与 CLI 共用的全局 MCP 配置、OAuth 和真实运行状态，启停同时作用于已有与新建会话，并移除设置页的重复入口。

**架构：** 全局设置由跨进程读改写入口持久化。Desktop 主进程提供无敏感字段的 MCP 列表快照与按需读取的编辑配置，应用服务负责配置变更、凭据清理和通知 daemon。活动 Session 按服务名及来源核对最新有效配置，更新连接、工具和运行能力视图。

**技术栈：** TypeScript、Node.js 文件系统、Electron IPC、React、Vitest、现有 `@openharness/core/server/mcp` 包。

**规格：** `docs/superpowers/specs/2026-09-23-desktop-mcp-management-convergence-design.md`

---

## 文件职责

- `packages/core/src/config/settings.ts`、新增 `settings-mutation.ts`：全局设置的跨进程串行读改写；现有设置写入者迁移到共同入口。
- `packages/core/src/types/settings.ts`、`packages/core/src/types/mcp-oauth.ts`：`enabled` 与通用 Runtime 核对契约。
- `packages/mcp/src/oauth/snapshot.ts`：启用状态的安全快照；HTTP OAuth 身份逻辑保持独立。
- `packages/server/src/application/mcp-config-application-service.ts`：全局 MCP 增删改、启停、编辑冲突与部分成功结果。
- `packages/server/src/application/mcp-runtime-connection-coordinator.ts`、`packages/server/src/http/routes/mcp.ts`：按全局服务名触发活动 Session 核对，保留已有 OAuth 指纹同步入口。
- `packages/agent-runtime/src/runtime-integrations.ts`：按当前有效配置及来源核对连接、工具注册与能力视图。
- `apps/cli/src/commands/mcp.ts` 和其他全局设置写入者：使用共同的设置修改入口，并输出实际 `enabled`。
- `apps/desktop/src/main/features/mcp/`、`apps/desktop/src/shared/`、`apps/desktop/src/preload/desktop-api.ts`：Desktop 操作、IPC 契约、无敏感列表快照。
- `apps/desktop/src/renderer/src/components/desktop/plugin-page/mcp-*`：保留现有列表及弹窗结构，改接真实 API；表单与 JSON 只提交真实配置字段。
- `apps/desktop/src/renderer/src/components/desktop/settings-page/`：移除重复 MCP 管理入口及旧组件。

## 任务 1：全局设置事务写入

**文件：** 新增 `packages/core/src/config/settings-mutation.ts` 及测试；修改 `packages/core/src/config/settings.ts`、`packages/core/src/index.ts`；迁移生产调用处：`apps/cli/src/commands/{mcp,provider,sandbox,setup}.ts`、`apps/cli/src/index.ts`、`packages/tools/src/{mode/plan-mode,meta/config}.ts`、`packages/server/src/{daemon-host/auto-start-controller,application/default-services/shared,application/mcp-oauth-application-service}.ts`。

- [ ] 先写设置并发测试：两个独立调用同时修改不同字段，最终两项都存在；第二个调用在锁内看到第一个调用的最新值；编辑目标已变化时返回冲突且不写入。运行 `pnpm --filter @openharness/core exec vitest run src/config/settings-mutation.test.ts`，确认测试因缺少入口失败。
- [ ] 新增统一入口。用标准库原子创建锁文件并在 `finally` 释放；等待有上限，崩溃遗留锁有受限恢复策略。锁内加载最新配置、执行修改函数、调用现有原子 JSON 写入。契约示例：

  ```ts
  export async function updateSettings(
    change: (current: Settings) => Settings | Promise<Settings>,
  ): Promise<Settings> {
    return withSettingsFileLock(async () => {
      const current = await loadSettings()
      const next = await change(current)
      await saveSettings(next)
      return next
    })
  }
  ```

- [ ] 把上述生产调用处的 `loadSettings() → 修改 → saveSettings()` 改为 `updateSettings(current => next)`；OAuth scopes 回写在同一锁内基于最新配置构造新对象。测试并发 `mcp add` 与 OAuth scopes 回写、两个不同服务的增删、以及其他设置更新，不允许丢掉无关字段。
- [ ] 跑 core、CLI MCP、OAuth 应用服务和被迁移设置命令的目标测试；确认 Windows 下锁释放与失败重试路径。只提交该任务文件，例如 `fix(config): serialize global settings mutations`。

## 任务 2：真实 `enabled` 与新 Session 行为

**文件：** `packages/core/src/types/settings.ts`、`packages/core/src/config/settings.ts`、`packages/mcp/src/oauth/snapshot.ts`、`packages/agent-runtime/src/plugin-discovery.ts`、`packages/agent-runtime/src/runtime-integrations.ts`、`apps/cli/src/commands/mcp.ts` 及各自测试。

- [ ] 写失败测试：旧配置缺 `enabled` 时仍连接；`enabled:false` 通过配置校验、快照和 CLI JSON 显示为停用；新 Session 不连接、不注册该服务工具；同一服务重新启用后新 Session 可连接。分别运行对应 core、mcp、agent-runtime 与 CLI 测试文件，确认旧实现失败。
- [ ] 在两个 `McpServerConfig` 分支中增加 `enabled?: boolean`，设置文件允许该字段并校验布尔值；快照用 `config.enabled !== false`。在 Runtime 建立连接和构建能力绑定前过滤停用项，保留已配置服务供管理快照读取：

  ```ts
  const enabledServers = Object.fromEntries(
    Object.entries(allServers).filter(([, config]) => config.enabled !== false),
  )
  ```

- [ ] CLI `list/get/status` 从快照输出实际启用值，不再写死 `enabled:true`；检查 stdio、HTTP 与 SSE 旧配置兼容。重跑目标测试并提交该任务文件，例如 `feat(mcp): honor server enabled setting`。

## 任务 3：活动 Session 的配置核对

**文件：** `packages/core/src/types/mcp-oauth.ts`、`packages/server/src/application/mcp-runtime-connection-coordinator.ts`、`packages/server/src/http/routes/mcp.ts`、`packages/client/src/` 中 MCP 控制请求、`packages/agent-runtime/src/runtime-integrations.ts`、`packages/server/src/daemon/default-daemon.ts` 及目标测试。

- [ ] 先写失败测试：活动 Session 中新增全局服务能连接；停用、删除、改址可撤下旧工具并断开旧连接；重新启用 stdio、HTTP、SSE 能连接；慢连接完成前发生停用时不能重新发布工具；当前项目若覆盖 `mcpServers`，同名同 URL 也不参与全局核对。运行 `pnpm --filter @openharness/agent-runtime exec vitest run src/runtime-integrations.test.ts` 与 server 协调器测试，确认失败。
- [ ] 为配置变更增加与现有 OAuth 指纹入口并列的控制请求，例如 `POST /mcp/:name/reconcile-global`；daemon Bearer 中间件继续保护该请求。协调器按服务名串行并推进代次，将请求送达所有活动 Session 的通用句柄，句柄自行判断该名称是否由全局配置提供。现有 OAuth `synchronize(identity)` 继续按 HTTP 指纹工作，不改登录协议。
- [ ] Session 句柄保留 `cwd`、原连接状态和配置来源。核对时检查 `loadProjectSettings(cwd)` 是否声明了 `mcpServers`；若声明，当前项目配置整体覆盖全局，该 Session 跳过全局核对。否则读取最新全局服务配置及原有插件来源，与已连接的旧配置比较；对被删除、改址或停用的连接先撤下工具并断开，再按最新有效配置连接：

  ```ts
  async function reconcileGlobal(name: string, generation: number): Promise<void> {
    if (await projectOverridesMcpServers(cwd)) return
    const desired = await resolveEffectiveMcpServer(cwd, name)
    if (currentSource(name) !== "global" && desired?.source !== "global") return
    await disconnectAndRemoveTools(name)
    if (desired?.config && desired.config.enabled !== false)
      await stageAndActivate(name, desired.config, generation)
  }
  ```

- [ ] 现有 `createRunCapabilityView` 不能继续依赖安装时固定的 `servers` 数组；改从当前连接与当前来源构建绑定。插件来源的 MCP 保持其所有权规则；全局删除后不误删插件工具。补状态聚合测试：项目覆盖、插件服务、来源不可确认时，不把连接报为全局已连接。
- [ ] 重跑 Runtime、server route、client 控制请求和 daemon 集成目标测试；核对重复/并发请求的代次行为，再提交该任务文件，例如 `feat(mcp): reconcile global servers in active sessions`。

## 任务 4：MCP 配置应用服务

**文件：** 新增 `packages/server/src/application/mcp-config-application-service.ts` 及测试；修改 `packages/server/src/index.ts`、`packages/mcp/src/oauth/snapshot.ts` 所需的安全摘要辅助函数。

- [ ] 先写失败测试：添加不覆盖同名服务；更新时目标配置变化报冲突；删除先清凭据、再删配置；凭据清理成功但配置写入失败返回部分成功；设置已保存但 Runtime 核对失败返回已保存结果；HTTP URL 改变后要求重新授权。运行新测试确认缺少服务而失败。
- [ ] 定义窄操作结果，避免同步失败被当成保存失败：

  ```ts
  type McpConfigOperationResult = {
    persisted: boolean
    credentialRemoved: boolean
    runtimeFailures: Array<{ runtimeId: string; message: string }>
  }
  ```

- [ ] 应用服务通过 `updateSettings` 在锁内读取、校验并改动目标服务；`update` 接收打开编辑器时的原配置用于冲突比较。`remove` 使用独立的凭据清理操作，不直接复用要求配置仍存在且会同步 Runtime 的 OAuth `logout`；同名登录和删除按服务串行，避免删除时的新凭据回写。成功持久化后调用任务 3 的全局核对，并返回最新安全快照。
- [ ] 添加无敏感列表 DTO、`getConfig(name)` 和 `exportConfig()`；列表摘要中的 URL 去掉用户信息、查询串与 fragment，stdio 只显示命令名，不返回 env/header。完整配置仅在显式编辑或导出请求中返回。重跑目标测试并提交，例如 `feat(mcp): manage global server configuration`。

## 任务 5：Desktop API 与真实状态

**文件：** `apps/desktop/src/shared/{mcp-types,desktop-api-contract,ipc-channels}.ts`、`apps/desktop/src/preload/desktop-api.ts`、`apps/desktop/src/main/features/mcp/{mcp-service,ipc,mcp-runtime-coordinator}.ts` 及测试。

- [ ] 先写失败测试：Desktop 快照含 `enabled`、安全摘要、auth/runtime 分离；`getConfig/exportConfig` 只按需返回完整配置；增删改、启停调用应用服务；保存成功但同步失败保留 `persisted:true`；公开 HTTP 无 OAuth 动作。运行 `pnpm --filter @openharness/desktop exec vitest run src/main/features/mcp/mcp-service.test.ts` 确认失败。
- [ ] 扩展 IPC 的入参与返回类型，并在 preload 暴露 `snapshot/getConfig/exportConfig/add/update/remove/setEnabled/login/logout`；对名称、配置、expectedConfig 做主进程校验。复用现有 daemon registry 与 client，增加任务 3 的按服务名核对调用：

  ```ts
  mcp: {
    snapshot: () => invoke(IpcChannels.mcpSnapshot),
    setEnabled: (input) => invoke(IpcChannels.mcpSetEnabled, input),
    // 其余操作使用对应 IPC channel
  }
  ```

- [ ] 补 IPC 处理器和 preload 契约测试，确认 Electron 错误传递不泄露凭据。重跑 Desktop main/preload 目标测试和类型检查，提交该任务文件，例如 `feat(desktop): expose MCP management API`。

## 任务 6：对齐编辑器与真实配置

**文件：** `apps/desktop/src/renderer/src/components/desktop/plugin-page/mcp-config.ts`、`mcp-form.tsx`、`mcp-editor.tsx` 及三个对应测试文件。

- [ ] 写失败测试：表单生成真实 stdio/HTTP 配置；`oauth.scopes` 与 `headers` 校验；SSE 在 JSON 模式可编辑；编辑现有服务时两种模式均拒绝改名；保存 Promise 未完成时不关闭弹窗，失败保留输入且不可重复提交。
- [ ] 把演示版字段映射收敛为真实配置字段。JSON 解析允许 `stdio/http/sse`，最终交给应用服务做同一套配置校验；编辑器回调改为 `onSave: (document: McpDocument) => Promise<void>`，成功后关闭，失败显示错误并保留内容：

  ```tsx
  async function save(): Promise<void> {
    setSaving(true)
    try { await onSave(validatedDocument); onClose() }
    catch (error) { report(errorMessage(error)) }
    finally { setSaving(false) }
  }
  ```

- [ ] 重跑三个组件测试及 Desktop renderer 类型检查，提交例如 `refactor(desktop): align MCP editor with runtime config`。

## 任务 7：主页面接入并移除设置页入口

**文件：** `apps/desktop/src/renderer/src/components/desktop/plugin-page/{mcp-manager,plugin-page}.tsx`、`apps/desktop/src/renderer/src/components/desktop/plugin-page/mcp-manager.test.tsx`、`apps/desktop/src/renderer/src/components/desktop/settings-page/{settings-navigation,settings-content,index}.ts(x)`；删除 `settings-page/mcp-settings.tsx` 及对应测试。

- [ ] 写失败交互测试：CLI/真实配置出现在主页面；切换项目列表不变；搜索/筛选/启停操作真实生效；详情按认证方式显示按钮；beUI 无授权按钮；OAuth 授权/退出后刷新快照；保存成功但同步失败显示部分成功；旧 `localStorage` 内容不出现。
- [ ] 将 `McpManager` 的 `read/persist/localStorage` 替换为 Desktop API 调用；`PluginPage` 不再用 `projectPath` 重置 MCP 管理器。列表摘要保持现有安静克制的行式布局，详情承载完整状态和 OAuth 操作：

  ```tsx
  const [snapshot, setSnapshot] = useState<DesktopMcpSnapshot | null>(null)
  useEffect(() => { void window.desktop.mcp.snapshot().then(setSnapshot) }, [])
  ```

- [ ] 删除设置页“MCP 服务”导航、内容分支和 `McpSettings`；只删除确认无引用的旧测试与导出。重跑主页面、路由、设置导航目标测试，提交例如 `feat(desktop): manage MCP from plugin page`。

## 任务 8：端到端核对与交付

- [ ] 用隔离测试配置验证 CLI→Desktop 与 Desktop→CLI 双向可见；分别用公开 HTTP、需 OAuth 的 HTTP、stdio、停用服务覆盖列表与详情。确认 OAuth 凭据不在导出 JSON 中。
- [ ] 验证活动 Session：停用后工具立即消失，启用后工具重新出现；删除/改址后旧连接不能继续工作；项目覆盖同名服务不被全局操作触碰；daemon 未运行时配置仍保存且状态准确。
- [ ] 按改动范围跑 core、mcp、server、agent-runtime、CLI、Desktop 相关测试、类型检查及 `node scripts/check-docs.mjs`。对照规格逐条检查，运行 `git diff --check` 并核对没有纳入用户其他工作区改动。
- [ ] 对跨进程设置写入和活动会话实时核对请求独立代码审查；修订重要问题后只重跑受影响的检查。汇报提交、验证结果和剩余限制。
