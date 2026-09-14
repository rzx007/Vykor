# Native Plugin Runtime 诊断 v1 设计

> 状态：已批准范围的阶段设计。  
> 日期：2026-09-14  
> 适用范围：Native Plugin 安装后的 Runtime 状态、Plugin Service 返回结构、Desktop 插件页展示和作者排障文档。

## 1. 目标

本阶段补齐「安装成功」之后的状态反馈。

用户当前已经可以在 Desktop 插件页导入 Native Plugin ZIP，也可以重新导入同一插件 ID 完成手动更新或修复。但安装成功不代表当前 Agent Runtime 已经加载。插件可能因为未重载、已禁用、快照损坏、权限变化、组件声明错误或 Native Tool 子进程失败而不可用。

Runtime 诊断 v1 要让插件页能回答 4 个问题：

1. 这个插件装上了吗？
2. 它现在启用了吗？
3. 它是否已经被当前 Runtime 使用？
4. 如果不能用，用户下一步做什么？

普通用户只需要看到简单反馈，例如：

```text
已启用，下一次对话生效
已加载
加载失败：插件文件不完整，请重新导入 ZIP
加载失败：插件请求了新的权限，请重新导入并确认
已禁用
```

## 2. 非目标

本阶段不做新的安装来源，也不改变插件权限模型。

明确不做：

- Agent 对话内安装 Native ZIP；
- 自动更新；
- 独立 Repair 命令；
- 版本回滚；
- 旧快照垃圾回收界面；
- Git、npm、archive URL 或 Marketplace 来源；
- `output_styles` 插件贡献；
- UI 插件贡献；
- 操作系统级沙箱；
- 新的 Runtime 状态持久化数据库。

「手动更新或修复」仍由「重新导入同一插件 ID 的 ZIP」覆盖。

## 3. 当前事实

当前代码已经有这些基础：

- `PluginInfo.activation` 已有 `inactive`、`active`、`partial`、`reload-required`；
- `PluginInfo.diagnostics` 已经能返回安装校验和组件加载诊断；
- `toolRuntime` 已经展示 Native Tool Host 的运行状态；
- `Plugin Service` 会读取安装记录，调用 `verifyInstalledNativePlugin` 和 `loadNativePlugin`；
- Agent Runtime 会在新 Runtime 创建时通过 `discoverOpenHarnessExtensions` 加载插件；
- Native Tool 激活发生在 `configureDiscoveredExtensions`，它能产生 Tool Host 级别诊断。

缺口是：这些诊断没有收敛成用户可读的「运行状态」。插件页只能看到粗粒度 activation 和 diagnostics，不能稳定告诉用户「下一步做什么」。

## 4. 状态模型

新增一个展示层状态字段，建议命名为 `runtimeStatus`。它不替代现有 `installation`、`activation`、`diagnostics` 和 `toolRuntime`，而是从这些事实计算出来，供 Desktop、CLI 和后续 UI 直接展示。

```ts
type PluginRuntimeStatus =
  | { state: "disabled"; message: string; action: "enable" }
  | { state: "pending_reload"; message: string; action: "reload" }
  | { state: "loaded"; message: string; action: "none" }
  | { state: "degraded"; code: string; message: string; action: "details" | "reimport" | "approve" | "disable" }
  | { state: "failed"; code: string; message: string; action: "reimport" | "approve" | "disable" | "uninstall" };
```

解释：

- `disabled`：安装记录存在，但用户禁用了插件；
- `pending_reload`：插件已启用且安装记录有效，但当前管理接口只能确认「下次 Runtime 会尝试加载」；
- `loaded`：当前有足够证据证明 Runtime 已经使用插件能力，第一版主要来自 Native Tool Host active 状态，或后续 Runtime inspection；
- `degraded`：插件部分能力可用，部分组件有 warning / unsupported；
- `failed`：安装记录存在，但验证或加载出现 error，当前 Runtime 不应使用它。

第一版不强行证明所有非 Tool 组件已在某个活跃对话中运行。没有 live Runtime inspection 时，已启用且验证通过的非 Tool 插件显示 `pending_reload`，文案为「已启用，下一次对话生效」。这比假装「已加载」更诚实。

## 5. 状态来源

`Plugin Service` 是管理状态的统一入口，负责把底层事实转成 `runtimeStatus`。

建议计算顺序：

1. `record.enabled === false` → `disabled`；
2. `verification.status !== "valid"` → `failed`；
3. `diagnostics` 中存在 error → `failed`；
4. 存在 warning 或 unsupported 诊断 → `degraded`；
5. 有 `toolRuntime.hostCount > 0` 且 state 为 `active` → `loaded`；
6. 其他启用且有效的插件 → `pending_reload`。

这个顺序能保证禁用插件不被误报成失败，也能保证快照损坏、权限缺失等问题优先展示为失败。

## 6. 错误码映射

第一版只做小而稳定的映射，不暴露 cache path、digest 或内部路径。

| 来源诊断 | runtimeStatus code | 用户动作 |
|---|---|---|
| `plugin_cache_missing`、`native_manifest_missing` | `snapshot_missing` | `reimport` |
| `plugin_content_digest_mismatch`、`plugin_cache_not_regular_directory` | `snapshot_tampered` | `reimport` |
| `plugin_identity_mismatch` | `manifest_mismatch` | `reimport` |
| `plugin_permissions_missing`、`plugin_permissions_changed` | `permission_missing` | `approve` |
| `native_component_unsupported` | `component_unsupported` | `details` |
| `native_*_invalid`、`component_path_*` | `component_invalid` | `reimport` |
| `tool_register_failed`、`native_tool_host_*` | `tool_host_failed` | `disable` |
| 其他 error | `runtime_failed` | `disable` |

映射只影响展示，不改变底层诊断数组。详情页仍可展示原始诊断 code，方便开发者排障。

## 7. Desktop 展示

插件列表页显示一个短状态：

- 已禁用；
- 等待下次对话生效；
- 已加载；
- 部分能力不可用；
- 加载失败。

插件详情页显示：

- 当前状态；
- 一句原因；
- 建议动作；
- 原始 diagnostics 列表（保持折叠或放在详情区域）；
- 现有版本、来源、组件数量和权限摘要。

不增加复杂向导，不新增「自动修复」按钮。失败时只告诉用户最合适的下一步。

## 8. CLI 与 `/reload-plugins`

CLI `plugin details` 可以同步输出 `runtimeStatus`，但不是本阶段必须的 UI 重点。

`/reload-plugins` 继续表示「关闭当前 cwd 的旧 Runtime，下一次使用时重新加载」。它不能承诺所有插件已经在当前对话热加载成功。命令输出应继续提示安装校验状态和诊断。

## 9. 验收标准

本阶段完成后需要证明：

- 禁用插件显示 `disabled`，不显示为失败；
- 有效且启用的插件在没有活跃 Runtime 证据时显示 `pending_reload`；
- 快照缺失或 digest 不一致时显示 `failed`，建议重新导入；
- 新增未批准权限时显示 `failed`，建议重新导入并确认权限；
- unsupported 组件显示 `degraded`，不影响其他组件；
- Tool Host active 时显示 `loaded`；
- Tool Host 启动失败时显示 `failed` 或 `degraded`，不拖垮插件管理页；
- Desktop 使用 `runtimeStatus` 展示主状态，仍保留 diagnostics 详情；
- 文档明确区分安装成功、等待生效和运行成功。

测试以聚焦测试为主，不跑全仓库大套件作为阶段完成的唯一依据。
