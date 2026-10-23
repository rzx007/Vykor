# 配置文件与路径

确定配置与 Git 路径，并提供配置文件的原子写入。

## 主要文件

| 文件 | 主要导出 |
| --- | --- |
| [atomic-json-write.ts](./atomic-json-write.ts) | `AtomicJsonWriteOperations`、`writeJsonFileAtomically` |
| [git.ts](./git.ts) | `GitRepositoryInfo`、`resolveGitRepository` |
| [paths.ts](./paths.ts) | `PROJECT_CONFIG_DIR_NAME`、`ResolvedPaths`、`resolvePaths` |

## 入口与处理步骤

主要入口或定义见 [atomic-json-write.ts](./atomic-json-write.ts)。

先计算用户或项目路径，读取需要的文件信息；写入时准备临时文件并按现有替换规则保存。

## 状态放在哪里

配置文件保存在用户或项目配置目录；读取结果和单次修改上下文由调用方持有。

## 新代码与测试

与本目录职责一起修改的代码放在这里；跨分类的公共入口由上层目录组织。

测试位于 [`__test__/`](./__test__)；只覆盖下级分类的测试放在对应分类的 `__test__/`。
