# 权限设置

定义审批模式并整理权限设置。

## 主要文件

| 文件 | 主要导出 |
| --- | --- |
| [permission-modes.ts](./permission-modes.ts) | `normalizeApprovalMode`、`isWorkMode` |
| [permission-settings.ts](./permission-settings.ts) | `parsePermissionSettings` |
| [permissions.ts](./permissions.ts) | `PermissionMode`、`PermissionRule` |

## 入口与处理步骤

主要入口或定义见 [permission-modes.ts](./permission-modes.ts)。

调用方传入权限或模式配置，本目录校验并返回明确的设置，再交给实际的权限决策流程。

## 状态放在哪里

配置文件保存在用户或项目配置目录；读取结果和单次修改上下文由调用方持有。

## 新代码与测试

与本目录职责一起修改的代码放在这里；跨分类的公共入口由上层目录组织。

测试位于 [`__test__/`](./__test__)；只覆盖下级分类的测试放在对应分类的 `__test__/`。
