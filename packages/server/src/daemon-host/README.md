# 守护进程宿主管理

为桌面端和命令行提供系统服务、自启动与进程生命周期管理。

## 入口与流程

调用方通过 `@vykor/server/daemon-host` 访问系统服务与自启动控制器，后者读取偏好、检查现有进程，并安装、启停或等待进程退出。

Desktop 无窗口入口和 CLI 本机登记入口调用 `runRegisteredDaemon()`。进程先取得登记所有权，再打开会话库，最后发布地址和 token。进程退出前先关闭应用和监听器，再清理自己的登记。系统常驻进程遇到已有后台时等待所有权释放。CLI 显式停止前先通过带 token 的本机请求核对 PID。进程退出后，取得登记所有权才能清理原记录。

连接时，CLI 和 Desktop 用同一套规则决定是否启动系统服务。Windows 计划任务空闲且后台已退出时立即触发一次检查。Unix 服务已运行，或 Linux 的 systemd 正在启动服务时，客户端等待后台发布登记。需要改动启动项时，先取得控制锁，再核对设置和服务状态。

产品默认运行固定使用当前用户根的 canonical 数据库；旧 data-location 只作迁移来源，根切换由宿主协调器关闭旧进程后启动新进程。显式注入 baseDataDirectory 的嵌入调用仍保留原有独立数据库和进程内切换契约。

桌面宿主还可在启动服务前调用该入口导出的 `setHostResponseLocale()`，提供操作系统的首选显示语言。普通 Agent 和审批器共享这个进程级默认值；它不持久化为设置，也不改变用户明确指定的回复语言。

## 状态归属

数据根协调与新子进程验证通过 [HTTP 请求入口](../http/daemon-request.ts) 发送带 token 和当前协议版本的请求；宿主继续负责 PID、登记、会话可读性和停写结果检查，以及各请求的超时、取消与重定向策略。普通 `/health` 不证明 PID 或协议版本，不能替代这些检查。

自启动偏好与系统服务配置保存在各自配置位置，进程状态来自操作系统和守护进程登记信息。

用户根下的 `data/daemon/registry.json` 存当前进程地址。产品选择保存在 home 旁的固定 selector；旧 `daemon/data-location.json` 不再覆盖产品 canonical 路径。显式嵌入调用仍用该旧文件记录其独立数据位置。

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
| [data-root-git.ts](./data-root-git.ts) | 只读 Git 登记检查、同锁 repair、限定指针的摘要核验与逆向恢复 |
| [data-root-migration.ts](./data-root-migration.ts) | 停写后的独立复制、相邻安装、同根交换、提交与重复恢复 |
| [data-root-migration-journal.ts](./data-root-migration-journal.ts) | 私有迁移记录、原子落盘、目录身份与源/目标摘要 |
| [data-root-coordination.ts](./data-root-coordination.ts) | 宿主停写、服务协调、验证和解锁后的普通新进程启动 |
| [data-root-service.ts](./data-root-service.ts) | 私有服务定义备份、阶段意图与恢复 |
| [data-root-validation.ts](./data-root-validation.ts) | 真实验证子进程与限定 DB 等价恢复 |
| [migration-validation-entry.ts](./migration-validation-entry.ts) | 普通产品初始化前的受信任内部 child 入口 |
| [system-service.ts](./system-service.ts) | `DaemonSystemServiceState`、`DaemonSystemServiceStatus`、`SystemCommandResult`、`DaemonServiceInvocation` 等 |

## 测试与维护

系统服务和进程控制放在这里；守护进程内部业务组装放在 daemon，保持本目录的公开入口。

测试放在本分类同层的 `__test__/`；覆盖多个子分类的测试放在共同上层的 `__test__/`。迁移文件时同步导入、公开入口、文档链接与旧引用清单。

## 数据根迁移预检

Git 的 main（主仓库）若由停写数据库证明是已分配受管工作区，最终 moves 才覆盖它，Git 设置的 projectPath 随之重定位。公开请求没有“已证明”或忽略保护参数；仅 Git 登记产生的 `git_main_ownership_pending` 可等待独立数据库副本完成归属检查，宿主与数据库中的真实项目保护仍优先。完整业务复制前必须消除所有 blocker。

`data-root-git.ts` 检查明确 Git 登记和最终文件清单中的受管 `.git` 文件，因此默认 child manager、没有 Desktop 登记的工作树也进入同一宿主流程。预检只执行 rev-parse、symbolic-ref 和版本查询，关闭 Git 可选锁及 fsmonitor，不执行可能运行过滤器的 status；锁定、丢失/不一致的登记、不能安全修复的布局会返回具体路径。WSL 登记使用指定发行版的 Git，Native 参数先通过现有 sandbox 挂载盘转换，输出及指针转回 Native 后核验；默认发行版在预检时固定到 journal，无法双向映射的 Linux 私有路径会阻止。版本也来自同一执行环境，主仓库实际路径改变时要求 Git 2.48+，因为更旧的 repair 会继续使用仍存在的旧主仓库；主仓库附带本次未搬的外部 worktree 时也阻止。

有 `withInstalledCopy` 时，核心在持有稳定锁和 pending 的阶段先从最终主仓库执行 `git worktree repair`，再把控制交给验证/提交回调。动作前写 journal 意图，只允许 worktree 的 `.git` 和主仓库下对应 `gitdir` 两种指针变化；指针内容、权限、top-level/common-dir、HEAD、分支与 index 均核验，其余目标树及外部 Git 元数据保持原摘要。没有回调的文件层入口仍停在 verified；有工作树而未完成 repair 时禁止独立 commit。

恢复先核对副本并恢复目录，再从旧主仓库 repair 旧位置。逆向 repair 可能重写内容相同的旧 `.git`，所以另存限定恢复指针的摘要，不刷新原完整 sourceTrees 基线；其它文件或时间戳改变仍拒绝。正向/逆向意图均可重复恢复，未完成时 pending 一直保留，成功后仍保留 stage/旧业务副本。真实验证位于 [Git 测试](./__test__/data-root-git-migration.test.ts) 和 [POSIX 跨文件系统与进程中断测试](./__test__/data-root-git-migration.posix.mjs)。

停写及复制后，`relocateDataRootFiles({stagedRoot,targetRoot,moves,workflowDirectories,settingsPaths})` 处理 `data/desktop` 下的 composer 恢复记录和 Git 设置，以及根设置。`workflowDirectories` 和附加 `settingsPaths` 必须是副本内部、由已知受管 cwd 推导的明确物理路径。composer 只处理 mention/skill 路径，保留 revision、inputId、assetId、顺序和文本；当前附件卡片没有 sourcePath。Git 按 `<configDir>/worktrees` 与最终目录的关系同步修改 path/configDir/偏好基目录，保留外部 projectPath、分支和 baseCommit。

设置处理器只访问 MCP stdio.cwd、sandbox 文件系统路径列表、permission.pathRules.pattern 和明确 shell executable。命令、参数、环境变量、密钥、OAuth、供应商配置和正文不改写。当前凭据/OAuth、便签恢复、图片批注格式没有待搬迁的路径字段，原文件保留。文件工作流仅解码活动 v1 快照；终态快照和 NDJSON 事件原文不变。全部已知文件解析通过后才写入；非空 `unsupported` 阻止本轮 JSON 写入，写入故障由协调器丢弃或恢复本次副本，不能继续安装。

`relocateProjectStorageKeys({stagedRoot,cwdPaths,moves})` 使用原写入者共享的目录键算法，重命名副本内 local_rules/projects、data/memory 和 data/session-memory 的旧 cwd 键。候选路径既包含数据库登记，也包含最终复制清单中的受管工作区、渠道与 worktree 目录及来源别名；临时会话或已删除会话没有数据库登记，也不会遗漏其已保存的长期事实。先一次读取已有键名，只有命中完整旧键才检查和重命名，避免对工作区中每个目录重复探测三类存储。先核对全部源/目标及真实路径边界；不同内容冲突抛错且不覆盖，相同内容的已有目标保留，正文、来源、ID 和整理时间不重写。所有写入都显式指向 `stagedRoot`，不读取进程全局根。

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

只要定位记录带有 pending，提交、发布及恢复入口都必须同时匹配本 journal 的 ID 和路径；旧记录的重试不能清除后续迁移的指针。已发布且没有 pending 的重试不重写定位记录；若本次发布在写入 `writersReleased` 后中断，则重试只清除仍属于本记录的 pending。

写旧根迁出标记前，journal 先记录本次新增的 `data`、`data/migrations` 目录链。恢复先逐层确认只有预期子目录和本记录的标记，再按原始源树摘要校验，最后从深到浅移除这些新目录。链上出现未知文件或链接就保留现场并拒绝恢复；不会忽略整个 `data` 树或刷新源摘要。创建或清理中断后，只处理已记录且仍存在的目录。

`recoverDataRootMigration(path,{homeDir})` 先验证记录路径、物理父目录和各副本身份，再选择回退步骤。它把已安装的新树移回暂存、把 backup 还原，不删除任一业务副本；失败阶段保留，重复调用不会再导入草稿或生成会话。未知路径、摘要变化、丢失旧副本会阻止启动并保留现场。已发布普通写入后只允许修复当前目标或显式反向迁移，不能自动换回旧数据。没有 journal 的普通死亡启动锁通过 `withDataRootRecoveryLock(homeDir, operation)` 显式恢复；它不猜测数据根。

## 全写入者与新实例协调

`migrateDataRootAndRestart(request, coordination)` 先列出 CLI/TUI、Desktop、SDK 控制写入者；这些进程在稳定 home 锁内取得根内资格，已有工作排空及资格释放不等待该锁。源 daemon 必须与登记 PID/token 的鉴权响应一致，目标活进程、控制锁竞争或非 daemon 写入者阻止复制。维护入口还拒绝未处理的临时聊天。

唯一主 journal 先持久化，再写 pending，然后捕获服务定义和停写；`preparation.complete` 独立于操作进度，只有合法 flush/退出后才建立完整 sourceTrees。早期 stage 必须为空；本次服务原定义保存在固定的 `<journal>.service.json` 私有文件，主记录只存路径、摘要和意图。数据库检查副本位于完成停写后的 stage/.database-snapshot，不通过空库证明旧数据可用。

`data-root-service.ts` 在动作前记录暂停、安装和恢复意图；Windows 原任务 XML/launcher、macOS plist、Linux unit 只进入私有备份。目标定义安装时保持停止，原来不存在的服务不会新增。恢复顺序为目录/Git、暂停状态的原定义、原 selector，之后用新的短锁恢复原 enabled/running；Linux start 使用 --no-block，不等待新 Node 进程取得同一 home 锁。

捕获与暂停前都要核对实际服务定义的根参数，不能用新建 adapter 的路径证明全局服务归属。Linux 还核对系统当前加载的主文件、附加配置和重载状态；macOS 已加载的服务还要求实际 program/arguments 与 plist 完全相同并明示根参数；Windows 核对任务实际引用的 launcher、脚本文本和物理路径。Linux 和未加载的 macOS 旧服务可用明示的 `VYKOR_CONFIG_DIR` 或本次已核准的 `VYKOR_DATA_DIR` 绑定源；已加载 macOS 服务或旧 Windows launcher 没有明示根参数时，继承的环境或 selector 可能选择另一个根，因此拒绝迁移并提示重装或移除旧自启动。异根、未知语法及捕获后被替换的定义都在暂停前拒绝。

`data-root-validation.ts` 启动真实新子进程。内部验证入口仅接受活跃锁持有者父进程、匹配 pending/journal/目标和本次记录 PID；不提供公开 ignore 开关，也不发布普通 registry。应用延迟运行恢复、定时任务、渠道和附件资源清理。验证关闭后核对全部业务表和其它文件，只忽略本次已退出 PID 的运行 owner，再从私有 `<journal>.validation/database.db` 恢复原 DB 字节及时间。备份必须匹配进入回调时的 verified 树；未知变化、活子进程或不同业务行均保留现场并拒绝恢复。

同锁回调按 validate → commit → markWritersReleased 执行。普通子进程只在核心解锁后启动，以显式目标参数及原始外部目录环境输入初始化；不修改旧 parent 的 pinned 根。新 PID/token 和正式登记从普通新进程产生。放行目标写入后启动失败只报告向前修复。恢复旧源也先持久化 recoveryWritersReleased；之后服务 resume 失败不能再回退数据或重挂旧 pending，遇到后续迁移直接跳过旧服务恢复。

旧分离数据集同样走高层：只选inspect.sources中origin=runtime-data与canonical sourceRoot/data的有限目录，检查单一活registry和其数据库身份；多活源拒绝。早期journal记录这些已存在目录身份，原服务launcher/logs只从同组目录派生，不为了发现旧库创建新canonical库。Windows固定launcher/logs在stagedTree与Git基线之前生成，最终安装相同文本不重写；未知业务改动仍按全树摘要拒绝。

`prepareLegacyDesktopSessionLookup(request)` 是本机维护窗口的准备入口。在 home 锁内复用有限来源、唯一 DB、PID/token 和写入者检查；可信旧 daemon 逐 ID 鉴权查询，覆盖归档与 memory，不用分页缺项判断不存在。无 live 源时复制停写 DB/WAL/SHM 到 home 下私有临时目录，校验当前 schema、完整性、外键后读取正式 ID，核对源前后身份和摘要，成功后仅清理已核对临时目录。结果为内存分类函数及可选的宿主来源收据，均不含正文；未知 ID 为 unknown；不改 selector、服务或源库，也不代替正式迁移的最终停写和新扫描。

旧环境覆盖的来源证据保存在现有 legacy-import.json 顶层 legacySources，避免业务 scan 失效时丢失它。data-root-legacy-receipt.ts 绑定 sourceRoot 目录身份、宿主 profile/Documents 和已核实来源身份；只补当前缺省来源，原 rootInputs 外部 pin 不改。已有 canonical DB 优先于旧 DB/runtime 候选，独立 channels/images 仍可补回；坏绑定或被替换的来源拒绝。T8 在受管 staged 副本将状态改为 consumed，原副本保留 pending，same-root 新目录身份也不会令已消费来源复活。
