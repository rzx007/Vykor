# 文件访问检查

检查执行环境路径、宿主管理文件和文件修改权限。

## 主要文件

| 文件 | 主要导出 |
| --- | --- |
| [environment-path.ts](./environment-path.ts) | `resolveToolPathInContext` |
| [file-mutation-guard.ts](./file-mutation-guard.ts) | `SYSTEM_DIR_PREFIXES`、`isSystemPath` |
| [managed-persistence-path.ts](./managed-persistence-path.ts) | `ManagedPersistencePathKind`、`managedPersistencePathKind` |
| [sandbox-guard.ts](./sandbox-guard.ts) | `sandboxPathDecision`、`sandboxPathError` |

## 入口与处理步骤

主要入口或定义见 [environment-path.ts](./environment-path.ts)。

工具解析目标路径后，先调用这些规则确认访问方式和可修改范围，再进入实际文件操作。

## 状态放在哪里

单次调用保存输入、取消信号和执行结果；文件、进程及任务状态由注入的宿主接口或目标系统保存。

## 新代码与测试

与本目录职责一起修改的代码放在这里；跨分类的公共入口由上层目录组织。

测试位于 [`__test__/`](./__test__)；只覆盖下级分类的测试放在对应分类的 `__test__/`。
