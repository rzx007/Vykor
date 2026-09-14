# Native Plugin Runtime 诊断 v1 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 给 Native Plugin 管理接口和 Desktop 插件页增加一个简单可读的 Runtime 状态，让用户知道插件是已禁用、等待生效、已加载、部分能力不可用还是加载失败。

**架构：** 不新建持久化状态。`Plugin Service` 继续读取安装记录、安装校验、组件加载诊断和 Native Tool Host 状态，然后计算 `runtimeStatus`。Desktop 只展示这个派生状态，底层 diagnostics 仍保留给详情。

**技术栈：** TypeScript、Vitest、React、现有 `@openharness/plugins`、`@openharness/agent-runtime`、Server Plugin Service 和 Desktop 插件页。

---

## 文件结构

- 修改：`packages/client/src/types/index.ts`
  增加 `PluginRuntimeStatus` 类型，并把 `runtimeStatus` 加到 `PluginInfo`。

- 修改：`packages/server/src/application/settings-api.ts`
  同步服务端接口类型，保证 Server 与 Client 结构一致。

- 修改：`packages/server/src/application/default-services/plugin-service.ts`
  增加状态映射函数，根据 enabled、verification、loaded diagnostics 和 toolRuntime 计算 `runtimeStatus`。

- 修改：`packages/server/src/application/default-services/plugin-service.test.ts`
  覆盖 disabled、pending_reload、failed、degraded 和 loaded 映射。

- 修改：`packages/client/src/transport/__test__/http-client.test.ts`
  更新 PluginInfo fixture，保证客户端类型和 HTTP 传输测试包含 `runtimeStatus`。

- 修改：`packages/server/src/http/routes/service.test.ts`
  更新服务路由测试 fixture。

- 修改：`apps/desktop/src/main/features/plugin/plugin-service.test.ts`
  更新 Desktop 主进程测试中的插件 fixture。

- 修改：`apps/desktop/src/renderer/src/components/desktop/plugin-page/plugin-manager.tsx`
  列表和详情使用 `runtimeStatus` 展示主状态。

- 修改：`apps/desktop/src/renderer/src/components/desktop/plugin-page/plugin-manager.test.tsx`
  覆盖至少一个失败状态和一个等待生效状态。

- 修改：`docs/native-plugin-authoring.md`、`docs/plugins-contributions-design.md`、`docs/plugin-system-handoff.md`、`docs/native-plugin-next-stage-handoff.md`、`docs/README.md`
  记录 Runtime 诊断 v1 的完成边界和阅读入口。

## 任务 1：定义 Runtime 状态类型

**文件：**
- 修改：`packages/client/src/types/index.ts`
- 修改：`packages/server/src/application/settings-api.ts`

- [ ] **步骤 1：写失败的类型用例**

在现有使用 `PluginInfo` 的测试 fixture 中先加入 `runtimeStatus`，预期 TypeScript 还没有字段时失败。最小形状：

```ts
runtimeStatus: {
  state: "pending_reload",
  message: "已启用，下一次对话生效。",
  action: "reload",
}
```

- [ ] **步骤 2：增加共享类型**

在 client 类型中增加：

```ts
export type PluginRuntimeStatus =
  | { state: "disabled"; message: string; action: "enable" }
  | { state: "pending_reload"; message: string; action: "reload" }
  | { state: "loaded"; message: string; action: "none" }
  | { state: "degraded"; code: string; message: string; action: "details" | "reimport" | "approve" | "disable" }
  | { state: "failed"; code: string; message: string; action: "reimport" | "approve" | "disable" | "uninstall" };
```

然后在 `PluginInfo` 增加：

```ts
runtimeStatus: PluginRuntimeStatus;
```

`settings-api.ts` 若已有独立接口定义，同步引用或复制等价类型，不引入跨包循环。

- [ ] **步骤 3：运行聚焦类型检查**

运行：

```powershell
pnpm --filter @openharness/client run check-types
pnpm --filter @openharness/server run check-types
```

如果本机 `pnpm` 卡住，使用已知 fallback pnpm：

```powershell
C:\Users\ruanz\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback\pnpm.cmd --filter @openharness/client run check-types
C:\Users\ruanz\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback\pnpm.cmd --filter @openharness/server run check-types
```

## 任务 2：在 Plugin Service 计算展示状态

**文件：**
- 修改：`packages/server/src/application/default-services/plugin-service.ts`
- 修改：`packages/server/src/application/default-services/plugin-service.test.ts`

- [ ] **步骤 1：写状态映射测试**

在 `plugin-service.test.ts` 增加或扩展用例，至少断言：

```ts
expect(plugin.runtimeStatus).toEqual({
  state: "pending_reload",
  message: "已启用，下一次对话生效。",
  action: "reload",
});
```

再补 4 个场景：

- `record.enabled = false` → `disabled`；
- `verifyInstalledNativePlugin` 返回 digest / cache 相关错误 → `failed`，`action: "reimport"`；
- loaded diagnostics 含 `native_component_unsupported` warning → `degraded`；
- toolRuntime active 且没有 error → `loaded`。

- [ ] **步骤 2：增加映射函数**

在 `plugin-service.ts` 添加纯函数，输入保持简单：

```ts
function runtimeStatusForPlugin(input: {
  enabled: boolean;
  installation: PluginInfo["installation"];
  diagnostics: PluginInfo["diagnostics"];
  toolRuntime?: PluginInfo["toolRuntime"];
}): PluginInfo["runtimeStatus"] {
  // 先 disabled，再 failed，再 degraded，再 loaded，最后 pending_reload。
}
```

错误码映射使用小表：

```ts
const diagnosticActions: Record<string, { code: string; action: "reimport" | "approve" | "disable" | "uninstall" | "details" }> = {
  plugin_cache_missing: { code: "snapshot_missing", action: "reimport" },
  plugin_content_digest_mismatch: { code: "snapshot_tampered", action: "reimport" },
  plugin_permissions_missing: { code: "permission_missing", action: "approve" },
  native_component_unsupported: { code: "component_unsupported", action: "details" },
};
```

未知 error 映射为：

```ts
{ state: "failed", code: "runtime_failed", message: "加载失败：插件运行状态异常，请查看详情。", action: "disable" }
```

- [ ] **步骤 3：把结果写入 PluginInfo**

在 `plugins.push` 前先组装：

```ts
const diagnostics = [...verification.diagnostics, ...(loaded?.diagnostics ?? [])];
const toolRuntime = manifest?.components.tools ? { ... } : undefined;
```

然后：

```ts
runtimeStatus: runtimeStatusForPlugin({
  enabled: record.enabled,
  installation,
  diagnostics,
  toolRuntime,
})
```

- [ ] **步骤 4：运行聚焦测试**

运行：

```powershell
pnpm --filter @openharness/server exec vitest run src/application/default-services/plugin-service.test.ts
```

## 任务 3：更新 Desktop 插件页展示

**文件：**
- 修改：`apps/desktop/src/main/features/plugin/plugin-service.test.ts`
- 修改：`apps/desktop/src/renderer/src/components/desktop/plugin-page/plugin-manager.tsx`
- 修改：`apps/desktop/src/renderer/src/components/desktop/plugin-page/plugin-manager.test.tsx`

- [ ] **步骤 1：更新测试 fixture**

所有 `PluginInfo` / `DesktopPluginInfo` fixture 加上：

```ts
runtimeStatus: {
  state: "pending_reload",
  message: "已启用，下一次对话生效。",
  action: "reload",
}
```

- [ ] **步骤 2：列表主状态改用 runtimeStatus**

在 `plugin-manager.tsx` 增加一个小函数：

```ts
function pluginRuntimeLabel(plugin: DesktopPluginInfo): string {
  return plugin.runtimeStatus.message;
}
```

列表主状态显示这个 message。`needsAttention` 改成优先看：

```ts
plugin.runtimeStatus.state === "failed" || plugin.runtimeStatus.state === "degraded"
```

保留现有 diagnostics 详情，不删除原始错误信息。

- [ ] **步骤 3：详情页展示建议动作**

详情页显示 `runtimeStatus.message`。如果 action 不是 `none`，显示短提示：

```ts
const actionHints = {
  enable: "启用后下次对话生效。",
  reload: "新开对话或重载插件后生效。",
  reimport: "请重新导入 ZIP。",
  approve: "请重新导入并确认新增权限。",
  disable: "可以先禁用该插件。",
  uninstall: "可以卸载该插件。",
  details: "请查看下方诊断详情。",
};
```

不要新增复杂按钮。已有启停、卸载、导入按钮继续复用。

- [ ] **步骤 4：运行 Desktop 聚焦测试**

运行：

```powershell
pnpm --filter @openharness/desktop exec vitest run src/main/features/plugin/plugin-service.test.ts src/renderer/src/components/desktop/plugin-page/plugin-manager.test.tsx
```

## 任务 4：文档收尾

**文件：**
- 修改：`docs/native-plugin-authoring.md`
- 修改：`docs/plugins-contributions-design.md`
- 修改：`docs/plugin-system-handoff.md`
- 修改：`docs/native-plugin-next-stage-handoff.md`
- 修改：`docs/README.md`

- [ ] **步骤 1：更新作者指南**

在排障章节说明：

```text
安装成功只代表 ZIP 或目录已经写入安装记录；运行状态以插件页和 `ohs plugin details` 返回的 Runtime 诊断为准。
```

- [ ] **步骤 2：更新当前实现文档**

在 Native Plugin 当前实现中说明 Runtime 诊断 v1：

- 插件页显示 `disabled`、`pending_reload`、`loaded`、`degraded`、`failed`；
- 失败建议只给一个动作；
- 不包含自动修复和自动更新。

- [ ] **步骤 3：更新交接文档**

把 Runtime 诊断 v1 从「推荐下一阶段」移动到「已完成」或「本阶段进行中」，并保留后续路线：

```text
Agent 对话安装、output_styles、Marketplace、远程来源继续暂缓。
```

- [ ] **步骤 4：运行文档检查**

运行：

```powershell
git diff --check
```

如果可用，再运行：

```powershell
pnpm check-docs
```

## 任务 5：最终验证与提交

**文件：**
- 所有本阶段修改文件

- [ ] **步骤 1：运行最终聚焦验证**

至少运行：

```powershell
pnpm --filter @openharness/server exec vitest run src/application/default-services/plugin-service.test.ts
pnpm --filter @openharness/desktop exec vitest run src/main/features/plugin/plugin-service.test.ts src/renderer/src/components/desktop/plugin-page/plugin-manager.test.tsx
pnpm --filter @openharness/client run check-types
pnpm --filter @openharness/server run check-types
pnpm --filter @openharness/desktop run typecheck
git diff --check
```

如果 `pnpm` 环境异常，使用 fallback pnpm，并在交付说明中明确。

- [ ] **步骤 2：提交**

```powershell
git add packages/client/src/types/index.ts packages/server/src/application/settings-api.ts packages/server/src/application/default-services/plugin-service.ts packages/server/src/application/default-services/plugin-service.test.ts packages/client/src/transport/__test__/http-client.test.ts packages/server/src/http/routes/service.test.ts apps/desktop/src/main/features/plugin/plugin-service.test.ts apps/desktop/src/renderer/src/components/desktop/plugin-page/plugin-manager.tsx apps/desktop/src/renderer/src/components/desktop/plugin-page/plugin-manager.test.tsx docs/native-plugin-authoring.md docs/plugins-contributions-design.md docs/plugin-system-handoff.md docs/native-plugin-next-stage-handoff.md docs/README.md docs/superpowers/specs/2026-09-14-native-plugin-runtime-diagnostics-v1-design.md docs/superpowers/plans/2026-09-14-native-plugin-runtime-diagnostics-v1.md
git commit -m "feat(plugins): show native runtime diagnostics"
```

- [ ] **步骤 3：交付说明**

交付时说明：

- 新增了哪些状态；
- Desktop 展示怎么变；
- 运行过哪些聚焦验证；
- 没有做哪些暂缓项。
