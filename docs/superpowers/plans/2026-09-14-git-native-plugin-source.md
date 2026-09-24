# Git Source Resolver v1 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** Desktop 插件页支持从 Git URL 安装 Native Plugin。

**架构：** `@vykor/plugin-sources` 负责 clone、固定 commit、清理临时目录；Server Plugin Service 负责预览、权限确认和安装；Desktop 只在“添加”菜单下打开 Git 安装弹窗，并给出简单反馈。

**技术栈：** TypeScript、系统 `git` CLI、现有 Plugin Service、现有 Desktop IPC。

---

### 任务 1：Git Source Resolver

**文件：**

- 创建：`packages/plugin-sources/src/git-source.ts`
- 创建：`packages/plugin-sources/src/git-source.test.ts`
- 修改：`packages/plugin-sources/src/index.ts`

- [x] 增加 `resolveGitPluginSource()`，调用系统 `git`，返回 `candidateRoot`、`commit`、`sourceDigest` 和 `cleanup`。
- [x] 拒绝空 URL、控制字符、以 `-` 开头的 URL/ref。
- [x] checkout 后删除 `.git`。
- [x] 失败时清理临时目录。

### 任务 2：Server 与 Client 接口

**文件：**

- 修改：`packages/server/src/application/settings-api.ts`
- 修改：`packages/server/src/application/default-services/plugin-service.ts`
- 修改：`packages/server/src/http/routes/service.ts`
- 修改：`packages/client/src/types/index.ts`
- 修改：`packages/client/src/transport/http-client.ts`

- [x] 新增 `previewGit()` 和 `installGit()`。
- [x] 预览复用 Native validation/load/inventory/permissions。
- [x] 安装时重新 resolve 并核对 `expectedSourceDigest`。
- [x] 复用 mutation lease，成功后关闭当前 Runtime。

### 任务 3：Desktop 最小入口

**文件：**

- 修改：`apps/desktop/src/shared/plugin-types.ts`
- 修改：`apps/desktop/src/shared/ipc-channels.ts`
- 修改：`apps/desktop/src/shared/desktop-api-contract.ts`
- 修改：`apps/desktop/src/preload/desktop-api.ts`
- 修改：`apps/desktop/src/main/features/plugin/plugin-service.ts`
- 修改：`apps/desktop/src/main/features/plugin/ipc.ts`
- 修改：`apps/desktop/src/renderer/src/components/desktop/plugin-page/plugin-page.tsx`
- 修改：`apps/desktop/src/renderer/src/components/desktop/plugin-page/plugin-manager.tsx`

- [x] 顶部“添加”菜单增加“从 Git 安装”，点击后打开 Git URL 和可选 ref 弹窗。
- [x] 无权限请求时直接安装。
- [x] 有权限请求时复用现有确认弹窗。
- [x] 失败只显示简单错误和详情 code。
