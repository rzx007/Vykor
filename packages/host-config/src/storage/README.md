# 配置文件与路径

统一计算用户数据与项目配置路径，提供 Git 路径查询和配置文件的原子写入。

## 主要文件

| 文件 | 主要导出 |
| --- | --- |
| [atomic-json-write.ts](./atomic-json-write.ts) | `AtomicJsonWriteOperations`、`writeJsonFileAtomically` |
| [data-root-selection.ts](./data-root-selection.ts) | 纯根选择、固定定位记录、启动保护、稳定锁与进程内固定选择 |
| [private-file-permissions.ts](./private-file-permissions.ts) | 新定位文件与锁的私有权限；保留既有 home 权限 |
| [git.ts](./git.ts) | `GitRepositoryInfo`、`resolveGitRepository` |
| [managed-path-map.ts](./managed-path-map.ts) | 读取迁移映射，仅识别旧受管工作区与隐藏迁移暂存/保留项目 |
| [managed-path-relocation.ts](./managed-path-relocation.ts) | 完整根路径校验、最长目录边界映射、现存父目录与 junction 边界检查 |
| [paths.ts](./paths.ts) | `UserDataPaths`、`ResolvedPaths`、`resolveUserDataPaths`、`resolvePaths`、`getDataRoot` 及命名路径 getter |

## 入口与处理步骤

只需要路径时从 `@vykor/host-config/paths` 导入；这个入口仅依赖 Node 标准库，不加载设置读取或服务端业务。

`getProjectDirectoryKey(cwd, foldWindowsCase)` 共享规则、长期记忆与会话记忆的既有目录键算法，不读取全局根或创建目录。仅长期记忆传 `true`，继续折叠 Windows 路径大小写；规则与会话记忆保持原来的大小写。副本迁移用同一函数计算新旧键。

`resolveUserDataPaths(dataRoot)` 接收明确的用户根，返回全部用户目录和固定文件路径，不读取环境变量、cwd 或文件系统，不创建目录。迁移可分别调用 `resolveUserDataPaths(sourceRoot)`、`resolveUserDataPaths(targetRoot)`，无需临时修改环境变量。默认布局把 `cache`、`channels`、`workspaces`、`worktrees` 放在根下，运行数据和桌面业务文件分别放在 `data/`、`data/desktop/` 下；插件内部结构、数据库和附件相邻关系保持原样。

`initializeDataRoot()` 必须在导入会创建持久化 store 的业务模块前完成：锁内按显式参数、`VYKOR_CONFIG_DIR`、`~/.vykor-root.json`、默认 `~/.vykor` 的顺序选择，拒绝损坏定位、待恢复迁移、已迁出源根与找不到的已选数据库。它将所选根固定到当前进程，并把同一根传给子进程；普通默认启动不写定位记录、不创建用户根。`getInitializedDataRootSelection()` 返回原始来源，预检不能把内部写入的环境值误判为用户固定覆盖。`getDataRoot()` 在产品初始化后一直返回固定根，切根必须重启；未初始化的嵌入调用按只读选择解析。`getConfigDir()` 只委托它。`resolvePaths(projectRoot?)` 在用户路径之外添加兼容的 `configDir` 和项目 `.vykor/memory` 路径；不缓存带项目路径的结果，因此 cwd 改变后不会串用上一个项目的记忆目录。`getProjectMemoryDir()` 是另一种现有用途：按项目路径生成稳定标识，将长期记忆存到用户 `data/memory/` 下。

为后续迁移保护接入保留兼容行为：`resolvePaths()` 暂时仍接受 `VYKOR_DATA_DIR`，`resolveChannelWorkspaceRoot()` 保留显式嵌入兼容规则；`getChannelWorkspaceRoot()` 直接返回规范 `getChannelsDir()`，不读取旧渠道覆盖。新纯函数不接受这些旧覆盖；新 `getChannelsDir()` 使用用户根内的规范位置。`inspectLegacyDirectoryOverrides(dataRoot, env)` 纯检查旧 `VYKOR_DATA_DIR`、`VYKOR_CHANNELS_DIR`、`VYKOR_IMAGE_ATTACHMENT_CACHE_DIR`，返回来源、原值与规范目标；相同目标可接受。普通 CLI/Desktop 在初始化之后、导入业务模块之前调用 `assertNoLegacyDirectoryOverrides` 拒绝冲突，显式嵌入文件路径仍由调用方负责。实际数据搬迁与旧渠道、选库和后台路径替换由后续模块完成，不能据此宣称已完成数据搬迁。

[atomic-json-write.ts](./atomic-json-write.ts) 负责准备临时文件并按现有替换规则保存。

## 状态放在哪里

用户文件保存在所选用户根下；真实项目配置继续保存在传入项目内。纯路径计算只返回字符串；启动选择模块仅持有进程内已初始化选择。固定定位记录位于用户 home，迁出标记为 `<root>/data/migrations/moved-root.json`。

`readDataRootSelector(homeDir)` 与纯 `selectDataRoot` 供维护命令读取状态；它们不会创建目录。普通发现使用带保护的 `resolveDataRootSelection`，锁存在时拒绝发现。`withDataRootLock(homeDir, operation)` 使用固定 `.vykor-root.json.lock`，独占期间可调用回调参数 `lock.writeSelector()` 原子提交；`writeDataRootSelector()` 是独立取锁写入入口。锁保存 PID 和随机 ownerToken，不按年龄偷锁；恢复调用 `readDataRootLockState()` 核验持有进程，未知状态视为仍可能活跃。迁移恢复逻辑负责确认持有者已退出后处理遗留锁。

## 新代码与测试

与本目录职责一起修改的代码放在这里；跨分类的公共入口由上层目录组织。

测试位于 [`__test__/`](./__test__)；只覆盖下级分类的测试放在对应分类的 `__test__/`。

已保存的 selector 表示恢复既有根：除根目录外，规范 sessions.db 或旧 data-location 指向的数据库也必须存在。首次新建应使用尚未保存选择的显式参数、环境或默认根；不能通过保存一个空目录跳过恢复保护。

已保存的数据集还会拒绝零字节数据库，防止 SQLite 将损坏或截断的旧文件当作新空库打开；未保存选择的新 profile 仍可首次初始化。此启动保护只检查文件存在、类型和非零长度，完整 SQLite 验证仍属于停写副本步骤。

保护性 resolver 按真实目录身份识别已保存根，显式参数或环境变量改用 junction / 符号链接别名不能跳过恢复检查。根缺失时解析最近存在的父目录及悬空链接的指向；只读身份判断不创建目录。纯 `selectDataRoot` 仍只比较输入优先级，不读取文件系统，真正不同的新 profile 仍可首次初始化。

显式传入 env 缺少 HOME/USERPROFILE 时，`dataRootHome` 使用操作系统账户 home（`userInfo()`），不回读全局环境；默认调用仍可使用 process.env。异步启动用 `waitForDataRootSelection(input, {deadline, signal})` 等待正常根锁竞争并重新校验，迁移中、迁出、损坏和丢失库仍直接报错。

定位候选文件和锁先收敛权限再写内容：POSIX 新文件为 0600；Windows 设置并核验受保护 ACL，只允许当前用户与 SYSTEM，失败不发布候选文件。既有 home 的模式和 ACL 不修改。Windows 权限工具只在临时隔离 profile 下运行，避免 PowerShell 初始化目录污染调用者 home。

`parseDataRootArgument` 仅识别第一个参数位置的 `--data-root <路径>` 或 `--data-root=<路径>`，后面的参数原样交给宿主选项解析，防止把其他选项的文本值误当作根。

根和 home 必须是当前系统的完整绝对路径。Windows 的 `\volume-relative`、`/volume-relative`、`C:relative` 在创建定位锁前就拒绝；完整盘符路径和 UNC 共享路径可用。`getInitializedDataRootInputs()` 返回初始化前的 home、显式根和四个相关目录环境变量的副本，不采集其它环境值；它保留被显式根遮住的外部设置，区别于初始化后为子进程注入的 `VYKOR_CONFIG_DIR`。`getInitializedDataRootSelection()` 的原合同保持不变。

`relocateManagedPath(path,moves)` 复用 `ManagedPathMove`，按最长目录关系匹配，保留相似前缀的兄弟路径和外部路径。Windows 比较大小写和分隔符，POSIX 保留大小写。`assertManagedPathBoundary(path,scope)` 与 `resolveManagedRealPath(path)` 只读检查已存在路径或最近的已存在父目录，不创建缺失目录；映射本身不授予访问权限，也不改写普通文本。

`readManagedPathMap(dataRoot?)` 从规范 `data/migrations/path-map.json` 读取 `{version:1,moves:[{kind,from,to}],excludedRoots?:string[]}`；不存在时返回空映射，损坏时抛错。`ManagedPathMove.kind` 为 `user-root | runtime-data | workspace | channel | worktree`。`getManagedWorkspaceRoots(dataRoot?)`、`isManagedWorkspacePath(path,dataRoot?)` 只识别规范 workspaces/channels 与明确 workspace/channel 映射的 from/to，不把 user-root、runtime-data 或 worktree 当项目外聊天。`isHiddenManagedProjectPath(path,dataRoot?)` 另外识别 excludedRoots，用于隐藏暂存/保留项目。以上识别接口不授予文件访问权限；历史链接须由打开入口重定位到目标，再检查原有访问边界。

`resolveManagedHistoryPath(path,dataRoot?)` 读取已保存的 path-map，只对本机绝对路径按最长目录映射重定位；排除目录、相似前缀和普通文字保持原值。它检查旧范围与目标范围没有被链接替换、目标和最近存在父目录没有越界，且映射目标属于当前用户根。返回路径之后，调用者仍执行原有权限检查；此接口不会增加允许根。Desktop 文件打开/工具图片预览和工具环境路径转换复用它，Native 路径先重定位，再转换到 WSL 等执行环境。

## 稳定启动锁的恢复

`.vykor-root.json.lock/active/owner.json` 保存本次 PID 和 UUID token；固定 `.lock` 目录可以长期存在，只有 active 阻止正常发现。所有启动、迁移和恢复都通过同一目录 lease（独占创建的所有权记录）串行执行。普通操作不偷锁，只有明确的 `withDataRootRecoveryLock` 会处理合法死亡 owner；仅进程探测返回 ESRCH 才认为已退出，不根据时间或文件年龄判断。

恢复把死亡 active 原子移动到 `.lock/claims/<旧 token>`，该非空目录永久保留，再尝试创建新 active。两个恢复者即使同时读到旧 token，迟到者也无法用新 active 覆盖已有非空 claim。正常 release 核对本 PID/token，将自己的 active 移到唯一 released 目录后才删除。恢复在 claim 后再次退出不会留下第二把无法恢复的 guard。旧文件格式、未写完 owner、坏 token、链接或未知文件类型都保留并报错。锁容器与迁移目录使用真实 Windows 私有 ACL，POSIX 使用 0700；不修改已有 home 的权限。

`data-root-writers.ts` 为产品 Desktop、CLI/TUI、daemon 与默认 SDK 控制操作登记写入资格。资格创建与 pending/moved 重验共用稳定 home 锁，覆盖初始化完成到登记之间的窗口；封闭操作完成或 Desktop 封门排空后直接核对并删除自己的 PID/token 文件，不等待迁移持有的 home 锁。CLI/TUI 和 daemon 的进程资格保留至 PID 确实退出，覆盖后注册的同步 exit 写入；只读列表仅在 ESRCH 时忽略死进程记录，迁移不复制这些记录，损坏或不可验证记录保留并拒绝继续。

`dataRootChildEnvironment()` 恢复初始化前的四个目录环境输入，使内部传播的根不会成为下次启动的外部固定配置。内部验证 child 的初始化仅接受持锁父进程和匹配本次 journal/PID 的受信任目标。

home 锁与写资格可接收同一 `deadline`（绝对毫秒时间）和 `signal`；私有权限准备不会重置等待预算。取消会结束实际取锁循环，并在获得锁后、创建资格前及返回资格前重新检查；已创建的本次资格先释放再返回原取消原因。

普通死亡启动锁的产品恢复语法为 `vk data-root recover --startup-lock`；如存在 pending，改用提示的 `recover --journal <完整记录路径>`。活锁、损坏 owner 或无法核对身份的锁保持拒绝。
