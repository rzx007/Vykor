# 配置文件与路径

统一计算用户数据与项目配置路径，提供 Git 路径查询和配置文件的原子写入。

## 主要文件

| 文件 | 主要导出 |
| --- | --- |
| [atomic-json-write.ts](./atomic-json-write.ts) | `AtomicJsonWriteOperations`、`writeJsonFileAtomically` |
| [git.ts](./git.ts) | `GitRepositoryInfo`、`resolveGitRepository` |
| [paths.ts](./paths.ts) | `UserDataPaths`、`ResolvedPaths`、`resolveUserDataPaths`、`resolvePaths`、`getDataRoot` 及命名路径 getter |

## 入口与处理步骤

只需要路径时从 `@vykor/host-config/paths` 导入；这个入口仅依赖 Node 标准库，不加载设置读取、文件锁或服务端业务。

`resolveUserDataPaths(dataRoot)` 接收明确的用户根，返回全部用户目录和固定文件路径，不读取环境变量、cwd 或文件系统，不创建目录。迁移可分别调用 `resolveUserDataPaths(sourceRoot)`、`resolveUserDataPaths(targetRoot)`，无需临时修改环境变量。默认布局把 `cache`、`channels`、`workspaces`、`worktrees` 放在根下，运行数据和桌面业务文件分别放在 `data/`、`data/desktop/` 下；插件内部结构、数据库和附件相邻关系保持原样。

`getDataRoot()` 目前接受 `VYKOR_CONFIG_DIR`，否则使用 `~/.vykor`；`getConfigDir()` 只委托它。`resolvePaths(projectRoot?)` 在用户路径之外添加兼容的 `configDir` 和项目 `.vykor/memory` 路径；不缓存带项目路径的结果，因此 cwd 改变后不会串用上一个项目的记忆目录。`getProjectMemoryDir()` 是另一种现有用途：按项目路径生成稳定标识，将长期记忆存到用户 `data/memory/` 下。

为后续迁移保护接入保留兼容行为：`resolvePaths()` 暂时仍接受 `VYKOR_DATA_DIR`，旧 `resolveChannelWorkspaceRoot()` / `getChannelWorkspaceRoot()` 暂时仍使用原渠道规则。新纯函数不接受这些旧覆盖；新 `getChannelsDir()` 使用用户根内的规范位置。启动根定位、旧覆盖冲突检查和数据迁移由后续模块接入，不能据此宣称已完成数据搬迁。

[atomic-json-write.ts](./atomic-json-write.ts) 负责准备临时文件并按现有替换规则保存。

## 状态放在哪里

用户文件保存在所选用户根下；真实项目配置继续保存在传入项目内。路径模块只返回字符串，不持有可写根、项目缓存或文件句柄；读取结果和单次修改上下文由调用方持有。

## 新代码与测试

与本目录职责一起修改的代码放在这里；跨分类的公共入口由上层目录组织。

测试位于 [`__test__/`](./__test__)；只覆盖下级分类的测试放在对应分类的 `__test__/`。
