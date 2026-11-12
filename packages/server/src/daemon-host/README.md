# 守护进程宿主管理

为桌面端和命令行提供系统服务、自启动与进程生命周期管理。

## 入口与流程

调用方通过 `@vykor/server/daemon-host` 访问系统服务与自启动控制器，后者读取偏好、检查现有进程，并安装、启停或等待进程退出。

Desktop 无窗口入口和 CLI 本机登记入口调用 `runRegisteredDaemon()`。进程先取得登记所有权，再打开会话库，最后发布地址和 token。进程退出前先关闭应用和监听器，再清理自己的登记。系统常驻进程遇到已有后台时等待所有权释放。CLI 显式停止前先通过带 token 的本机请求核对 PID。进程退出后，取得登记所有权才能清理原记录。

连接时，CLI 和 Desktop 用同一套规则决定是否启动系统服务。Windows 计划任务空闲且后台已退出时立即触发一次检查。Unix 服务已运行，或 Linux 的 systemd 正在启动服务时，客户端等待后台发布登记。需要改动启动项时，先取得控制锁，再核对设置和服务状态。

按需后台切换数据前用同一把控制锁挡住启停操作，并检查当前工作已经结束。后台记录切换 ID，关闭旧监听器，再在原进程内打开目标。目标就绪后提交选择、发布新地址并启动定时任务和渠道。恢复库必须在 SQLite 打开时存在。目标打开失败时用旧位置重新启动。

桌面宿主还可在启动服务前调用该入口导出的 `setHostResponseLocale()`，提供操作系统的首选显示语言。普通 Agent 和审批器共享这个进程级默认值；它不持久化为设置，也不改变用户明确指定的回复语言。

## 状态归属

自启动偏好与系统服务配置保存在各自配置位置，进程状态来自操作系统和守护进程登记信息。

基础数据目录下的 `daemon/registry.json` 存当前进程地址，`daemon/data-location.json` 存已提交的数据位置和最近一次切换结果。两份文件都用原子替换写入。启动过程读取已提交位置，切换中断后也从该位置打开数据。

## 主要文件

| 文件 | 主要接口或用途 |
| --- | --- |
| [auto-start-controller.ts](./auto-start-controller.ts) | `DaemonAutoStartSnapshot`、`DaemonAutoStartAction`、`DaemonAutoStartController`、`DaemonAutoStartControllerOptions` 等 |
| [index.ts](./index.ts) | 汇总本分类的公开接口 |
| [lifecycle.ts](./lifecycle.ts) | `daemonPidAlive`、`terminateDaemonProcess`、`forceKillDaemonProcess`、`waitForProcessExit` 和 `stopRegisteredDaemon` |
| [registered-daemon.ts](./registered-daemon.ts) | 本机登记入口、退出和进程内数据切换 |
| [registry-lease.ts](./registry-lease.ts) | 协调启动、启停和切换的控制锁，以及后台持有的登记所有权 |
| [data-location.ts](./data-location.ts) | 读写已提交的数据位置和最近的切换结果，校验恢复目标 |
| [data-root-sources.ts](./data-root-sources.ts) | 只读清点旧来源、文件摘要、具体迁移映射、冲突和后续必验条件 |
| [data-root-file-relocation.ts](./data-root-file-relocation.ts) | 副本中的桌面、Git、设置、文件工作流字段与项目哈希目录键处理器 |
| [data-root-migration.ts](./data-root-migration.ts) | 停写后的独立复制、相邻安装、同根交换、提交与重复恢复 |
| [data-root-migration-journal.ts](./data-root-migration-journal.ts) | 私有迁移记录、原子落盘、目录身份与源/目标摘要 |
| [system-service.ts](./system-service.ts) | `DaemonSystemServiceState`、`DaemonSystemServiceStatus`、`SystemCommandResult`、`DaemonServiceInvocation` 等 |

## 测试与维护

系统服务和进程控制放在这里；守护进程内部业务组装放在 daemon，保持本目录的公开入口。

测试放在本分类同层的 `__test__/`；覆盖多个子分类的测试放在共同上层的 `__test__/`。迁移文件时同步导入、公开入口、文档链接与旧引用清单。

## 数据根迁移预检

停写及复制后，`relocateDataRootFiles({stagedRoot,targetRoot,moves,workflowDirectories,settingsPaths})` 处理 `data/desktop` 下的 composer 恢复记录和 Git 设置，以及根设置。`workflowDirectories` 和附加 `settingsPaths` 必须是副本内部、由已知受管 cwd 推导的明确物理路径。composer 只处理 mention/skill 路径，保留 revision、inputId、assetId、顺序和文本；当前附件卡片没有 sourcePath。Git 按 `<configDir>/worktrees` 与最终目录的关系同步修改 path/configDir/偏好基目录，保留外部 projectPath、分支和 baseCommit。

设置处理器只访问 MCP stdio.cwd、sandbox 文件系统路径列表、permission.pathRules.pattern 和明确 shell executable。命令、参数、环境变量、密钥、OAuth、供应商配置和正文不改写。当前凭据/OAuth、便签恢复、图片批注格式没有待搬迁的路径字段，原文件保留。文件工作流仅解码活动 v1 快照；终态快照和 NDJSON 事件原文不变。全部已知文件解析通过后才写入；非空 `unsupported` 阻止本轮 JSON 写入，写入故障由协调器丢弃或恢复本次副本，不能继续安装。

`relocateProjectStorageKeys({stagedRoot,cwdPaths,moves})` 使用原写入者共享的目录键算法，重命名副本内 local_rules/projects、data/memory 和 data/session-memory 的旧 cwd 键。先核对全部源/目标及真实路径边界；不同内容冲突抛错且不覆盖，相同内容的已有目标保留，正文、来源、ID 和整理时间不重写。所有写入都显式指向 `stagedRoot`，不读取进程全局根。

`inspectDataRootMigration({homeDir,sourceRoot,targetRoot,...})` 从明确的根、已知位置记录和宿主输入收集来源，返回清单，不修改正在运行的库或创建文件。`legacy.documentsDir` 和 `legacy.userDataDir` 应取宿主真实系统位置；已有 Desktop 扫描收据也可提供这两个位置。没有这些信息时返回待补齐条件，不猜测 `home/Documents`。`legacy.databasePath/dataLocationPath/imageAttachmentCacheDir` 和相关旧目录环境值限定额外来源；`legacy.workspacePaths`、`projectPaths` 是宿主已知登记，缺失与空列表由 `registrationSnapshot` 区分。

`sources` 和 `moves` 使用既有 kind/from/to。`entries` 列出文件、目录与链接的来源、目标、字节数及文件摘要；同一真实路径只扫描一次。自定义数据库、WAL/SHM、附件、笔记、策略和用量设置有具体映射；其它运行日志和任务仍进入 `data/`，旧 CLI 图片目录进入 `data/attachments/images/`。Documents 渠道与已登记工作区单列；未登记文件进入 `workspaces/legacy/`。真实项目不复制，映射也不覆盖；Desktop 浏览器与窗口偏好不迁入。活动登记、token 所在的 registry 和已知活动锁排除，SQLite WAL 不属于可丢弃缓存。

预检不连接 SQLite，仅检查文件头、大小和摘要。`databases[].inspection = file-only` 不代表库为空或已通过完整性校验。`requiredValidations` 是后续执行的必要门槛：停写后独立副本上的 SQLite 完整性、记录/schema 与登记路径读取；源稳定性；目标写权限与复制空间；已知桌面 profile 的冻结后新扫描。宿主提供的登记也要与副本复核，不能用空数组跳过。T8 必须用副本补齐工作区/真实项目列表，再重新预检生成最终清单，之后才可复制完整业务树或交换根。

根是磁盘根、home 或真实项目祖先，根互相包含、不同数据库、内容/大小写碰撞、非空且未确认归属的目标、越界 junction、可判断的权限或容量失败都会形成 blocker。同根升级单独标记。外部符号链接只保留链接及原指向；受管指向按映射登记修复，不跟随链接复制根外内容。

从 dataDir 或旧 data-location 派生的数据库保留原目录归属；在加入来源、读文件头或摘要之前，必须确认真实路径仍在该范围内。同名 WAL/SHM 也受原目录约束，旁资源不能越出数据库所在目录。仅明确传入的 custom databasePath 可独立授权其数据库及相邻资源，不能将越界的派生路径自动提升为独立来源。

`access(W_OK)` 只报告可只读判定的权限失败；Windows 完整 ACL 不能据此宣称验证成功，因此始终保留 `target-write-permissions` 门槛。T8 在业务复制和根交换前，通过受管相邻暂存目录的实际创建、写入和权限验证解除该门槛；日志父目录无权限时应在写 pending 选择前安全失败，不伪造日志位置。预检不会启动可能创建 profile 缓存的 PowerShell。

`desktopExportPath` 指向既有 `legacy-import.json` 收据；它不是 LevelDB 或业务正文导出目录。只认可绑定真实 userData 的完整支持键扫描（含零键）及对应来源摘要。未 ACK 的 partial 返回 `needs_desktop_export` 和未解决会话数量；旧目标正常编辑不会因历史 targetDigest 变化而失败。CLI 只读该收据，不能检测未知旧进程对 LevelDB 的离线改动。T10 必须保持冻结并调用 Desktop 新扫描准备接口，T11 在用户明确处理 partial 后重试；已有收据只支持预览，不充当本次停写证明。

## 复制、交换与恢复

`migrateDataRoot(request, coordination)` 是已知路径的文件操作入口。`homeDir` 必须明确提供。它持有定位记录旁的稳定锁，调用必填的 `prepareStoppedCopy()` 停写接点；协调者负责关闭写入者、冻结 Desktop 并继续保持冻结。接点可返回本次 `desktopExportPath/freshDesktopScanId`，旧扫描收据不能替代本次冻结证明。

核心先在目标相邻的私有暂存目录复制 DB、同名 WAL/SHM，再从真实副本核对 SQL/schema 和登记。它完整带回真实项目路径（包括仅被定时任务引用的项目），重新预检后仅按最终 `entries` 全量复制。缺失数据库不能作为空登记的证明。逐文件比较摘要、大小、模式和修改时间，源树重新核对；不使用硬链接，也不跨卷 rename。未知文件与未知锁保留，活动 registry/token 和已知活动锁遵循预检排除清单。副本完成后才改写最终逻辑路径、哈希键、历史映射及旧数据位置文件，重开 SQLite、附件、笔记和插件确认实物可读。完整用户根副本还覆盖凭据、技能、草稿和工作区，不能用应用备份代替。

记录在目标父目录的 `.vykor-migration-<id>.json`，暂存为 `.vykor-migration-<id>/`；记录只有路径、操作、源条目摘要与改写后树摘要，不保存请求环境、正文或异常 cause。不同根将暂存安装到空目标；同根先将原根移到 `.vykor-migration-<id>-backup`，再安装回原路径。记录保存 `prepared → staged → installed → verified → committed`，操作前写意图。原文件和保留副本默认不删除。

`verified` 后可在同一锁内调用 `withInstalledCopy(handle)`。T9 的 Git 修复、T10 的可信验证实例和服务处理必须放在这个回调内，并补上各自明确的持久意图/恢复记录。验证实例显式使用目标路径及受限上下文，不能等待普通根初始化。`handle.commit()` 与 `handle.markWritersReleased()` 复用当前锁，回调返回后失效。独立 `commitDataRootMigration(path,{homeDir})` 与恢复入口重新获取同一把锁，所以不会抢走正在协调的现场。T8 的无回调调用只返回未发布的 `verified`，产品入口必须提供协调回调。

`commit` 核对安装树与旧副本，保存目标选择及待恢复指针。同根的迁出标记只写旧 backup，不能写到活动新根。`markWritersReleased` 先持久化不可自动回退状态，再清除待恢复指针；协调者随后才能发布新登记、激活普通写入。Git repair 或验证步骤若合法改变了文件，后续任务必须记录具体变化并核对相应文件后更新摘要，不能无条件刷新整棵树来吞掉未知改动。

`recoverDataRootMigration(path,{homeDir})` 先验证记录路径、物理父目录和各副本身份，再选择回退步骤。它把已安装的新树移回暂存、把 backup 还原，不删除任一业务副本；失败阶段保留，重复调用不会再导入草稿或生成会话。未知路径、摘要变化、丢失旧副本会阻止启动并保留现场。已发布普通写入后只允许修复当前目标或显式反向迁移，不能自动换回旧数据。没有 journal 的普通死亡启动锁通过 `withDataRootRecoveryLock(homeDir, operation)` 显式恢复；它不猜测数据根。
