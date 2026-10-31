# 文件编辑与补丁

处理替换定位、批量编辑、补丁计划、差异和编辑反馈。

## 主要文件

| 文件 | 主要导出 |
| --- | --- |
| [apply-patch.ts](./apply-patch.ts) | `PatchFailureKind`、`PatchToolError`、`PatchOperation` |
| [diff.ts](./diff.ts) | `buildUnifiedDiff`、`MAX_DIFF_PAYLOAD_LINES`、`truncateDiff` |
| [edit-feedback.ts](./edit-feedback.ts) | `editFailureResult` |
| [edit-plan.ts](./edit-plan.ts) | `EditPlanError`、`parseTextEdits`、`planTextEdits` |
| [edit-replacers.ts](./edit-replacers.ts) | `EditMatchErrorKind`、`editMatchMessage`、`EditMatchError` |
| [edit.ts](./edit.ts) | `createFileEditTool`、`fileEditTool` |
| [patch-path.ts](./patch-path.ts) | `PatchPathStyle`、`PATCH_DEV_NULL`、`isDevNullPath` |

## 入口与处理步骤

主要入口或定义见 [apply-patch.ts](./apply-patch.ts)。

先把输入整理成编辑计划，检查匹配及补丁路径，再通过文件操作执行，生成差异和简明反馈。

`Edit` 在读取目标原始字节前获取文件修改锁，持有到规划、快照复核与原子替换结束。`ApplyPatch` 先解析补丁并一次收集全部执行路径，再统一加锁；加锁后才读取任一目标、生成完整计划、复核哈希并依序写入或删除。锁由[文件工具公共入口](../README.md)选择后端实现，不能在回调内重复加锁。公开的 `planPatch` 仍是只读预览；执行工具会在锁内重新规划，不直接使用锁外预览的内容。

## 状态放在哪里

编辑计划和差异保存在单次调用中；执行后的内容写入目标文件。

## 新代码与测试

与本目录职责一起修改的代码放在这里；跨分类的公共入口由上层目录组织。

测试位于 [`__test__/`](./__test__)；只覆盖下级分类的测试放在对应分类的 `__test__/`。
