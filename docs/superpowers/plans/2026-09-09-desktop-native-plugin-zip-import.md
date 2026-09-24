# Desktop 本地 Native Plugin ZIP 导入实现计划

> **面向 AI 代理的工作者：** 使用 superpowers:subagent-driven-development 或 executing-plans 逐任务实施；遵循 TDD、逐任务审查和完成前验证。

> 状态：本阶段已完成。用户要求停止继续扩大测试；已完成的验证记录见各任务报告。

**目标：** 在 Desktop 插件页面一键导入本地 Native Plugin ZIP，后台安全校验，只有申请权限时出现一次确认。

**架构：** `@vykor/plugin-sources` 负责安全解压；Server PluginService 负责 preview/install；Desktop main 持有文件路径与短期 selection；Renderer 只显示成功、失败或权限确认。Native Installer 保持只接收目录。

**技术栈：** TypeScript、Node.js streams、yauzl、Hono、Electron IPC、React、Vitest。

**设计依据：** [Desktop ZIP 导入设计](../specs/2026-09-09-desktop-native-plugin-zip-import-design.md)。

> 阶段状态：Task 5 已完成；全套最终验证由主代理统一执行，不在此处填写汇总测试数。

### 任务 1：安全 ZIP Source Resolver

**文件：** 新建 `packages/plugin-sources/package.json`、`tsconfig.json`、`src/index.ts`、`src/local-zip.ts`、`src/local-zip.test.ts`；更新 `pnpm-lock.yaml`。

- [x] 先用测试 helper 生成 ZIP，写下有效根目录和单层包装目录用例；运行后确认 `resolveLocalPluginZip` 不存在而失败。
- [x] 实现源文件 lstat、100 MiB 上限、私有临时副本与 SHA-256；所有输出由 `cleanup()` 回收。
- [x] 用 yauzl lazy entries 实现中心目录检查和流式提取，落实设计中的 250 MiB、5,000 文件、100 MiB 单文件、200 压缩比、1,024 字节路径和 32 层目录限制。
- [x] 增加 traversal、absolute、backslash、drive、NUL、Windows reserved、尾随点空格、NFC/大小写重复、文件目录冲突、symlink/特殊类型、encrypted、截断、CRC、声明/实际字节不符测试。
- [x] 增加零/多个/deep manifest、wrapper 外多余文件、失败无残留、同内容同摘要、改动内容摘要变化测试。
- [x] 运行包测试与类型检查；审查临时目录删除只针对 resolver 创建的路径。

### 任务 2：Server 预览与安装 API

**文件：** 修改 `packages/server/src/application/settings-api.ts`、`default-services/plugin-service.ts` 及测试、`http/routes/service.ts` 及测试；修改 `packages/server/package.json`；修改 `packages/client/src/types/index.ts`、`transport/http-client.ts` 及测试。

- [x] 先定义 `PluginArchivePreview`、`PluginArchiveError` 与 client 方法测试，确认路由/API 尚不存在而失败。
- [x] PluginService preview resolve ZIP、validate/load、返回 identity/permissions/inventory/diagnostics，并在 finally cleanup；error 组件诊断返回结构化失败。
- [x] install 重新 resolve，摘要与 expectedArchiveDigest 不同则返回 `plugin_archive_changed`；再次静态校验后调用 Native Installer。
- [x] preview 路由不获取 mutation lease；install 路由使用 global lease，仅成功时 closeAllRuntimes。权限数组必须和实际 requested permissions 完全一致。
- [x] 测试无权限成功、漏批/多批拒绝、损坏 ZIP、摘要变化、managed ID 冲突、Installer 失败、临时清理及不可变快照。
- [x] Client 解析结构化响应，不从 message 或 stderr 推断 code/diagnostics；运行 server/client 测试和类型检查。

### 任务 3：Desktop main 文件选择与短期确认

**文件：** 修改 `apps/desktop/src/shared/plugin-types.ts`、`ipc-channels.ts`、`desktop-api-contract.ts`、`preload/desktop-api.ts`；修改 `main/features/plugin/plugin-service.ts`、`ipc.ts` 及测试；新增 selection store/helper。

- [x] 先写 service/IPC 测试：取消、无权限直接安装、有权限只返回 confirmation、确认、取消、过期、cwd 不同、并发上限和绝对路径不出 IPC 结果。
- [x] 注入 picker；该阶段的默认 Electron picker 当时只允许一个 ZIP，并绑定发起窗口。扩展名大小写不敏感，非 ZIP 即使由测试/系统返回也拒绝。
- [x] main 调 daemon preview；无权限立即 install，有权限创建 crypto.randomUUID selection。selection TTL 10 分钟、上限 8，确认或取消后删除。
- [x] confirm 只提交预览记录中的 archivePath、digest 和完整权限；cwd 必须相同，renderer 不能提供任意 path/digest/permissions。
- [x] IPC handler 传入 sender 给 picker，preload 只暴露三个高层方法；应用退出清理 selection。
- [x] 运行 Desktop node 测试和 typecheck:node。

### 任务 4：插件页面简化交互

**文件：** 重构 `apps/desktop/src/renderer/src/components/desktop/plugin-page/plugin-manager.tsx` 及测试；修改 `plugin-page.tsx`；删除或停止引用 plugin templates/config/editor 文件（不删除 localStorage 数据）。

- [x] 使用现有 shadcn Button、AlertDialog、Alert、Collapsible 写行为测试；先确认“添加插件配置”仍出现而失败。
- [x] 页面顶部“添加”菜单与空状态改为“导入插件”；调用 `api.importArchive`，busy 时防止第二次调用。
- [x] cancelled 静默结束；installed 更新 snapshot 并提示“已安装，将在下次对话中生效”；approval-required 打开一个确认框，按文件/网络/进程/密钥分组显示通俗权限。
- [x] 确认调用 `confirmArchive`，取消调用 `cancelArchive`；不提供 checkbox、manifest、组件或摘要 UI。
- [x] 失败 Alert 显示短消息，`查看详情` 默认收起并显示诊断 code/path；重新导入可恢复。
- [x] 删除 PluginManager 对 pluginTemplates、PluginEditor、plugin-config/localStorage 的读取和展示。测试预置旧 localStorage，断言未读取、未覆盖、未删除。
- [x] 保留列表搜索、筛选、详情、启停、卸载和 managed 只读行为；运行 renderer 测试、web typecheck 和可访问性断言。

### 任务 5：端到端契约、文档与收尾

**文件：** 新增跨 package acceptance test；更新 `docs/native-plugin-authoring.md`、`docs/plugin-system-handoff.md`、`docs/plugins-contributions-design.md`、`docs/README.md`；更新本计划状态。

- [x] 将 `examples/plugins/text-inspector` 打包为测试 ZIP，经 resolver → Server preview/install → installed snapshot → discover/verify/load；删除 ZIP 后继续从快照读取。
- [x] 验证 archive 路径不进入 renderer DTO、转换器不参与 archive 路径、Installer 仍接收已准备好的目录、失败没有 installed record。
- [x] 文档只描述插件页 ZIP 导入；明确 Agent 对话安装、外部格式和其他来源尚未进入 Desktop。
- [x] 已运行聚焦 acceptance；相关包测试、类型检查、文档检查和差异检查的实际结果记录在 Task 5 报告，Desktop 全包最终重跑按用户要求停止；已完成结果见任务报告。
- [x] 已审查安全边界、错误反馈、权限确认、临时清理、旧 localStorage 保留和测试缓存输入；无本任务范围内的阻断性生产问题。

## 完成标准

用户在插件页选一个 Native ZIP 后只看到成功、失败或一次权限确认；全部校验在后台完成。恶意或损坏 ZIP 无法越界写盘、执行代码或留下半安装状态；成功安装进入现有用户级不可变快照并在下次对话生效。
