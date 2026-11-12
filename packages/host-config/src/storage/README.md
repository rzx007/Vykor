# 配置文件与路径

统一计算用户数据与项目配置路径，提供 Git 路径查询和配置文件的原子写入。

## 主要文件

| 文件 | 主要导出 |
| --- | --- |
| [atomic-json-write.ts](./atomic-json-write.ts) | `AtomicJsonWriteOperations`、`writeJsonFileAtomically` |
| [data-root-selection.ts](./data-root-selection.ts) | 纯根选择、固定定位记录、启动保护、稳定锁与进程内固定选择 |
| [git.ts](./git.ts) | `GitRepositoryInfo`、`resolveGitRepository` |
| [paths.ts](./paths.ts) | `UserDataPaths`、`ResolvedPaths`、`resolveUserDataPaths`、`resolvePaths`、`getDataRoot` 及命名路径 getter |

## 入口与处理步骤

只需要路径时从 `@vykor/host-config/paths` 导入；这个入口仅依赖 Node 标准库，不加载设置读取或服务端业务。

`resolveUserDataPaths(dataRoot)` 接收明确的用户根，返回全部用户目录和固定文件路径，不读取环境变量、cwd 或文件系统，不创建目录。迁移可分别调用 `resolveUserDataPaths(sourceRoot)`、`resolveUserDataPaths(targetRoot)`，无需临时修改环境变量。默认布局把 `cache`、`channels`、`workspaces`、`worktrees` 放在根下，运行数据和桌面业务文件分别放在 `data/`、`data/desktop/` 下；插件内部结构、数据库和附件相邻关系保持原样。

`initializeDataRoot()` 必须在导入会创建持久化 store 的业务模块前完成：锁内按显式参数、`VYKOR_CONFIG_DIR`、`~/.vykor-root.json`、默认 `~/.vykor` 的顺序选择，拒绝损坏定位、待恢复迁移、已迁出源根与找不到的已选数据库。它将所选根固定到当前进程，并把同一根传给子进程；普通默认启动不写定位记录、不创建用户根。`getInitializedDataRootSelection()` 返回原始来源，预检不能把内部写入的环境值误判为用户固定覆盖。`getDataRoot()` 在产品初始化后一直返回固定根，切根必须重启；未初始化的嵌入调用按只读选择解析。`getConfigDir()` 只委托它。`resolvePaths(projectRoot?)` 在用户路径之外添加兼容的 `configDir` 和项目 `.vykor/memory` 路径；不缓存带项目路径的结果，因此 cwd 改变后不会串用上一个项目的记忆目录。`getProjectMemoryDir()` 是另一种现有用途：按项目路径生成稳定标识，将长期记忆存到用户 `data/memory/` 下。

为后续迁移保护接入保留兼容行为：`resolvePaths()` 暂时仍接受 `VYKOR_DATA_DIR`，旧 `resolveChannelWorkspaceRoot()` / `getChannelWorkspaceRoot()` 暂时仍使用原渠道规则。新纯函数不接受这些旧覆盖；新 `getChannelsDir()` 使用用户根内的规范位置。旧覆盖冲突检查和数据迁移由后续模块接入，不能据此宣称已完成数据搬迁。

[atomic-json-write.ts](./atomic-json-write.ts) 负责准备临时文件并按现有替换规则保存。

## 状态放在哪里

用户文件保存在所选用户根下；真实项目配置继续保存在传入项目内。纯路径计算只返回字符串；启动选择模块仅持有进程内已初始化选择。固定定位记录位于用户 home，迁出标记为 `<root>/data/migrations/moved-root.json`。

`readDataRootSelector(homeDir)` 与纯 `selectDataRoot` 供维护命令读取状态；它们不会创建目录。普通发现使用带保护的 `resolveDataRootSelection`，锁存在时拒绝发现。`withDataRootLock(homeDir, operation)` 使用固定 `.vykor-root.json.lock`，独占期间可调用回调参数 `lock.writeSelector()` 原子提交；`writeDataRootSelector()` 是独立取锁写入入口。锁保存 PID 和随机 ownerToken，不按年龄偷锁；恢复调用 `readDataRootLockState()` 核验持有进程，未知状态视为仍可能活跃。迁移恢复逻辑负责确认持有者已退出后处理遗留锁。

## 新代码与测试

与本目录职责一起修改的代码放在这里；跨分类的公共入口由上层目录组织。

测试位于 [`__test__/`](./__test__)；只覆盖下级分类的测试放在对应分类的 `__test__/`。
