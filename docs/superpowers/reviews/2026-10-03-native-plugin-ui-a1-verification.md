# Native Plugin UI A1 实施与验收记录

> 状态：当前 A1 实施验收记录；完整插件交互 UI 尚未交付。
> 日期：2026-10-03
> 分支：codex/plugin-ui-a1
> 基线：4bafd311

## 已交付范围

- 公共 UI 定义、限额、数量类型和确定的 JSON 规范化。
- 严格 UI schema、普通 UTF-8 文件有界读取、包内路径与 symlink / junction 检查、组件和 HTML 摘要。
- 安装前校验 UI 内容，加载阶段不执行 HTML 或第三方 Tool 模块。
- 根据 UI 声明推导两项授权，校验已有批准与不可变快照，不给旧记录自动批准。
- ZIP / Git 共用的安装预览和插件列表提供准确静态数量；Desktop 确认框和详情提供中文说明。
- 组件无法校验时保留已知文件数，组件数显示为未知，拒绝加载并建议修复。

实现位于隔离 worktree；原 main 工作区的其他未提交修改保留。锁文件只新增 protocol 的 workspace 直接依赖，没有第三方版本升级。依赖准备使用离线缓存并关闭安装脚本。

## 验证证据

命令均从隔离工作区执行，pnpm 使用 `--config.manage-package-manager-versions=false` 防止启动器自动取版本。

| 检查 | 结果 |
| --- | --- |
| 插件包全量 Vitest | 15 个文件、88 项通过；随后追加的文件 symlink 与 manifest 文件上限用例在 25 项聚焦测试中通过，共覆盖 90 项不同用例 |
| 公共 JSON 规范化 | 12 项通过 |
| Server 插件服务 | 24 项通过，包括真实 ZIP 安装与损坏 UI 管理反馈 |
| Desktop main + PluginManager | 40 项通过，包括审批、详情和未知数量展示 |
| Client 公共 API 契约 | 4 项通过，正式登记 PluginUiInventory 类型导出 |
| protocol / plugins / client check-types | 通过；plugins 包含 SDK 类型与真实样例检查 |
| Server check-types | 通过 |
| Desktop typecheck:node / typecheck:web | 均通过 |
| 文档与 whitespace 检查 | 使用 node scripts/check-docs.mjs 和 git diff --check 验证 |

对应首版验收为 UI-01–UI-04。文件 symlink 与 Windows directory junction 均实际创建并验证拒绝；没有用空 mock 代替文件边界检查。安装测试复制实际插件快照，源目录删除后仍能验证。

## 独立审查与修正

独立审查发现：损坏 UI 时，原始 invalid 结果丢失根 manifest，导致管理页把已知数量当成没有贡献内容。

先用真实 ZIP 安装、修改安装快照中的 UI JSON，复现数量丢失，再增加单独的 rootManifest 展示信息。invalid 结果仍没有可执行 plugin；verify 显式检查 status，runtime discovery 仍跳过 invalid。独立复核确认没有放宽加载或执行权限，问题已关闭。

类型检查另检出两个实际接线问题：Client 根入口未导出新增数量类型，以及联合类型在无状态收窄时读取 rootManifest。两处均修正并通过上述类型检查与公共契约验证。

## 环境准备与实际限制

agent-runtime 的 package exports 指向 dist。新 worktree 初次没有声明产物，Server / Desktop 类型检查因此报无法解析该包。根据现有构建脚本，在此 worktree 的包内 dist 生成产物后再检查；没有通过修改业务代码或引用另一个 checkout 的依赖来掩盖问题。

本阶段没有 iframe、UI 动作执行、ui-sdk 运行入口、MCP Apps 或 pluginUi feature 宣传。界面数量只代表静态定义，不代表前端正在运行。下一阶段按 Spec 实施 A2 的工具来源、可信实例和持久交互链路。

## 关联文档

- [完整 Spec](../specs/2026-10-02-native-plugin-ui-design.md)
- [A1 实施计划](../plans/2026-10-02-native-plugin-ui-a1.md)
- [当前作者指南](../../native-plugin-authoring.md)
