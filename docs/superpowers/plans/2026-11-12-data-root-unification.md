# Vykor 用户数据根统一与迁移实施计划

> **面向 AI 代理的工作者：** 实施时使用 `subagent-driven-development` 或 `executing-plans` 逐任务推进；复选框表示尚未执行的工作。用户已于 2026-11-12 授权按计划实施；只在临时数据上验证迁移，不操作真实用户资料。
>
> 状态：已实现并完成自动回归（2026-11-13）；实际平台覆盖和原始失败记录见[验收记录](../../data-root-verification.md)。Windows 跨盘完整提交及真实 Electron profile/图形重启不计作已完成。

**目标：** 用一个 `dataRoot` 决定 Vykor 用户业务数据的位置，补齐受管工作区和散落的数据，提供可检查、可恢复的迁移；临时聊天正文继续仅在内存中，桌面缓存和窗口偏好保持原位置。

**架构：** 扩展现有 `@vykor/host-config`，集中计算路径；CLI、Desktop、后台与客户端使用同一启动定位规则。迁移由后台进程之外的本机宿主执行，复用现有停写、备份、进程控制和原子写入能力，以暂存副本和一份迁移记录协调目录、结构化引用、Git 登记及自启动配置。

**技术栈：** TypeScript、Node.js 文件系统与路径 API、现有 SQLite/Drizzle、Electron IPC、现有 Git 命令、Vitest、现有协议和文档检查。没有新增依赖的计划。

**本轮产出：** 按任务实施并验证统一数据根与迁移；下文类型是接口约定，完成状态以对应任务证据为准。

## 1. 已确定的范围与原则

- 用户根内部统一命名为 `dataRoot`，默认 `join(homedir(), ".vykor")`。禁止把根误认为它下面的 `data/`。
- 继续接受现有 `VYKOR_CONFIG_DIR` 选择用户根；不额外引入含义相同的 `VYKOR_HOME` 或 `VYKOR_DATA_ROOT`。
- 所有产品默认路径从用户根派生。旧的 `VYKOR_DATA_DIR`、`VYKOR_CHANNELS_DIR`、`VYKOR_IMAGE_ATTACHMENT_CACHE_DIR`、`worktreeRoot` 和旧数据库选择记录作为迁移来源识别，不再静默把正式运行的数据分散到根外。
- 旧覆盖恰好等于新规则时可接受；指向其他位置时，预检列出来源和冲突，归并成功前不宣称统一完成。程序嵌入和测试中显式注入的独立存储路径继续由调用方负责，不改变产品启动规则。
- 真实项目目录、用户指定的外部资源、外部链接插件、共享技能目录、Git 全局配置和其他工具的凭据保持原位置。
- 本轮不统一 Electron `userData`、`sessionData`、浏览器缓存、窗口主题、窗口材质、宠物偏好等桌面外壳数据；不调用 `app.setPath("userData", ...)` 达成迁移。
- 普通聊天草稿、待提交提示词、未保存笔记、图片批注、任务 worktree 登记属于业务数据，不能因为它们目前位于桌面存储中就遗漏。
- 临时会话、消息、普通 Run、权限、目标控制记录与会话事件仍只在内存。迁移日志、草稿导出、备份中不能保存它们的正文。
- 临时聊天已经会持久化的附件、工作流、显式长期记忆、工具文件仍按原生命周期保存；统一其位置，不借机扩大删除范围。
- 默认不删除旧数据、不合并两个已有用户根、不自动改写用户全局环境变量，不扫描或修改真实用户目录来验证本计划。

## 2. 当前事实与源码入口

本节记录扫描时的实现，后面的任务定义目标行为。

| 当前事实 | 核实入口 | 实施影响 |
| --- | --- | --- |
| `resolvePaths()` 已统一部分配置与运行数据，但 `configDir` 与 `dataDir` 可以分离 | [paths.ts](../../../packages/host-config/src/storage/paths.ts) | 扩展这里，不另建一个根目录配置系统 |
| 后台切换数据库时在进程内修改 `VYKOR_DATA_DIR`，登记路径仍锚定最初的数据目录 | [registered-daemon.ts](../../../packages/server/src/daemon-host/registered-daemon.ts)、[data-location.ts](../../../packages/server/src/daemon-host/data-location.ts) | 整根迁移必须停止旧进程，不能沿用只换库的流程 |
| 输出样式写死用户主目录；渠道默认位于 Documents | [output-styles](../../../packages/output-styles/src/index.ts)、[渠道组装](../../../packages/server/src/application/channel/channel-runtime-assembly.ts) | 修实际读写入口和目录识别 |
| 无项目新聊天分配 Documents/Vykor/日期/xN | [session-operations.ts](../../../apps/desktop/src/main/features/session/session-operations.ts)、[outside-project-workspace.ts](../../../apps/desktop/src/main/features/session/outside-project-workspace.ts) | 增加 `workspaces/`，更新会话 cwd 和分类 |
| 无项目定时任务也在 Documents/Vykor 下分配目录 | [scheduled-task-executor.ts](../../../packages/server/src/application/schedule/scheduled-task-executor.ts) | 与普通受管工作区统一 |
| Desktop worktree 的默认根及登记在 Electron userData | [git-settings-service.ts](../../../apps/desktop/src/main/features/settings/git-settings-service.ts)、[git-settings-storage.ts](../../../apps/desktop/src/main/features/settings/git-settings-storage.ts) | 迁移目录、登记与受管绝对路径，不移动窗口偏好 |
| 附件、附件运行副本、笔记和维护设置默认位于数据库旁 | [附件组装](../../../packages/server/src/application/attachments/daemon-attachment-services.ts)、[note-repository.ts](../../../packages/services/src/notes/note-repository.ts)、[维护配置](../../../packages/server/src/application/maintenance/maintenance-policy-repository.ts) | 迁库必须连带这些资源 |
| 临时聊天由 JS 内存实现保存，工作流与附件独立持久化 | [chat-persistence.ts](../../../packages/services/src/database/persistence/chat-persistence.ts)、[workflow-repository.ts](../../../packages/services/src/workflows/workflow-repository.ts) | 路径统一不能改变存储归属 |
| 普通草稿、笔记恢复、图片批注还使用 localStorage | [composer-recovery.ts](../../../apps/desktop/src/renderer/src/stores/desktop-session/composer-recovery.ts)、[note-recovery.ts](../../../apps/desktop/src/renderer/src/components/desktop/notes-page/note-recovery.ts)、[use-image-annotations.ts](../../../apps/desktop/src/renderer/src/components/desktop/image-viewer/use-image-annotations.ts) | 需要应用自己的导入流程，不能复制或删除整个浏览器存储 |
| SDK 的 Node 服务发现自行计算根，发布时独立打包 | [registry.ts](../../../packages/client/src/service/registry.ts)、[build.mjs](../../../packages/client/scripts/build.mjs) | 共用轻量 Node 路径入口，同时验证独立安装与浏览器入口 |

## 3. 目标路径与数据归属

### 3.1 默认布局

```text
dataRoot/
  agents/
  cache/models-dev.json
  channels/
  data/
    session-runtime/
      sessions.db
      attachments/{blobs,staging}/
      attachment-session-resources/
      notes/
      storage-policy.json
      usage-settings.json
    attachments/images/
    desktop/
      composer-recovery.json
      notes-recovery.json
      quick-notes-recovery.json
      image-annotations/<imageKey>.json
      git-settings.json
      legacy-import.json
    daemon/
    logs/
    tasks/shell-output/
    sessions/
    feedback/
    memory/
    session-memory/
    memory-backups/
    exports/
    backup-audits/
    maintenance-audits/
    migrations/
      path-map.json
  local_rules/projects/
  output_styles/
  plugins/{cache,data,sources}/
  plugins/installed.json
  skills/
  user_profile_pending/
  workspaces/<YYYY-MM-DD>/<xN 或 scheduled-runId>/
  worktrees/
  channel-credentials.json
  credentials.json
  frecency.json
  mcp-oauth.json
  runtime-environment-secrets.json
  settings.json
  SOUL.md
  USER.md
```

- 保留现有 `local_rules` 拼写、插件内部目录、数据库名称与资源相邻关系，不为了统一根再搬一遍所有子目录。
- `data/sessions` 与 `data/session-runtime` 是不同现有用途，不能凭名称相似合并。
- `attachment-session-resources` 是可清理的运行副本；先等待使用者关闭，再在目标根重建，不把它作为永久附件原件。
- `notes/organization.json`、`organization.previous.json` 及损坏文件留存一起保留。
- `teams/` 与 `.skills_store_lock.json` 未发现当前生产读写者。已有文件按不透明用户数据保留，不新增虚构的持久化模块、不自动删除。
- 根下其他未识别文件也复制并报告。仅跳过明确识别、已停机释放的进程登记、活动租约和可重建暂存项；禁止按 `.lock` 通配删除。
- 记忆目录的 `.consolidate-lock` 含最后整理时间语义，要保留语义与时间信息，不当作一般活动锁丢弃。

### 3.2 启动如何找到用户根

一个可迁移的数据根无法在它自己里面保存唯一定位依据。增加一份固定启动定位记录，作为有意保留的例外：

```text
<homedir>/.vykor-root.json
<homedir>/.vykor-root.json.lock
```

定位记录只包含格式版本、已选择的 `dataRoot`、迁移 ID 和进行中的迁移记录位置，不含凭据、正文或草稿。首次使用默认根时无需创建它；实际选择根或开始迁移时才原子写入。不得借此读取或改写浏览器偏好。

启动优先级固定为：显式宿主参数或 `--data-root` → `VYKOR_CONFIG_DIR` → 定位记录 → 默认 `~/.vykor`。显式参数和环境变量之间有冲突时显示实际来源，不能隐藏覆盖。若迁移提交后仍会被固定的旧环境变量或系统启动参数压过，预检阻止提交并给出需要调整的具体项，不自动修改用户全局环境变量。

启动首先读取定位记录和迁移状态，再创建数据库、凭据 store、目录或后台。记录损坏、迁移中断、源根已标记迁出时，返回可操作的恢复错误，不能悄悄创建一份空数据。

### 3.3 路径接口

在 `packages/host-config/src/storage/` 实现，下面是任务之间共用的接口约定：

```ts
type RootEnvironment = Record<string, string | undefined>;

interface DataRootSelection {
  dataRoot: string;
  source: "explicit" | "environment" | "selector" | "default";
}

interface DataRootSelector {
  version: 1;
  dataRoot: string;
  pendingMigration?: { id: string; journalPath: string };
}

interface UserDataPaths {
  dataRoot: string;
  dataDir: string;
  cacheDir: string;
  channelsDir: string;
  workspacesDir: string;
  worktreesDir: string;
  desktopDataDir: string;
}

// 其余现有命名路径仍由 paths.ts 导出，不复制到第二份常量表。
function resolveUserDataPaths(dataRoot: string): UserDataPaths;
function selectDataRoot(input: {
  explicitRoot?: string;
  env: RootEnvironment;
  homeDir: string;
  selector?: DataRootSelector;
}): DataRootSelection;
function getDataRoot(): string;
```

选择与计算函数本身不创建目录。启动定位文件的读取、校验与原子保存单独放在 `data-root-selection.ts`。`ResolvedPaths` 增加规范的 `dataRoot`；内部消费者统一使用它。若为现有调用者暂留 `getConfigDir()`，它只能直接返回 `getDataRoot()`，不能保留第二份可写根或缓存。

通过 `@vykor/host-config/paths` 暴露仅依赖 Node 标准库的轻量入口。SDK 的 Node 服务入口打包它；浏览器入口不能引入文件系统、设置实现或服务端业务包。生产启动在创建对象前确定根，运行中不再修改 `process.env.VYKOR_DATA_DIR` 来切库。

## 4. 迁移来源与路径改写清单

### 4.1 来源如何收集

只读取当前配置、已知定位记录和明确传入的来源；不遍历所有磁盘寻找“像 Vykor 的目录”。预检输出来源、目标、数量、字节数、冲突和必须关闭的写入者，不输出文件正文与密钥。

| 来源 | 导入规则 |
| --- | --- |
| 旧用户根整棵目录 | 保留已有文件格式与未知用户文件；明确排除活动状态 |
| 旧 `VYKOR_DATA_DIR`、数据位置记录和自定义数据库 | 将唯一选定的运行数据集归入 `data/`；不能把两个不同数据库自动合并 |
| 原数据库旁的附件、笔记、策略、用量设置 | 与数据库作为同一数据集复制并校验，不能只复制 `.db` |
| Documents/Vykor/channels 或显式渠道根 | 导入 `channels/`，保持渠道与聊天目录的相对结构 |
| Documents/Vykor 的普通工作区与无项目定时任务目录 | 导入 `workspaces/`；排除已单独识别的 channels，防止重复复制 |
| 在受管 Documents 根内、但没有记录的文件 | 保留到 `workspaces/legacy/` 并记账；不擅自删除或当作真实外部项目 |
| Desktop `userData` 中任务 worktrees 与 git-settings | 仅业务登记和受管工作目录迁入；浏览器目录与窗口偏好不动 |
| localStorage 中明确支持的业务键 | 由应用按已有格式读出、过滤并写入新业务存储，收到确认后才标记已导入 |
| CLI 图片附件缓存的旧独立目录 | 导入 `data/attachments/images/`；外部原始选图文件不动 |
| `~/.vykor/output_styles` 的旧固定路径 | 当它与旧根不同且确有内容时单独导入；同名不同内容视为冲突 |

有多个旧来源时按真实路径去重。大小写、分隔符和符号链接导致的别名不能复制两次；同名不同内容不能按时间或目录顺序静默选一个。

自定义库可能直接位于旧 dataDir 下，名称也可能不是 sessions.db。此时分别为数据库文件、attachments、notes、策略和用量设置建立具体映射；旧 dataDir 的其余 logs/tasks 仍映射到新 dataDir。不能把整个数据库父目录同时映射到两个目标，或者顺带把日志放进 session-runtime。

### 4.2 只改写运行所需的结构化字段

```ts
interface ManagedPathMove {
  kind: "user-root" | "runtime-data" | "workspace" | "channel" | "worktree";
  from: string;
  to: string;
}

function relocateManagedPath(path: string, moves: readonly ManagedPathMove[]): string;
```

按“最长匹配目录”处理映射，通过路径相对关系判断边界，不能使用无边界的字符串前缀替换。Windows 比较大小写和分隔符；POSIX 保持大小写。路径不存在时验证最近的现存父目录，防止目标通过 junction 或符号链接逃离受管范围。

| 位置 | 需要更新 | 需要保持 |
| --- | --- | --- |
| SQLite session、project location、session task | `cwd`、`path`、`normalizedPath`、相关 `cwdRelative`；只处理映射覆盖的受管目录 | ID、消息顺序、真实项目路径、会话状态 |
| 会话 metadata | 已定义的 `desktop.settingsRoot`、worktree 路径和其他现有类型声明中的宿主路径字段 | 用户正文、历史工具参数原文、供应商 payload |
| 已安排任务 | `projectPathsJson` 中指向已搬工作区的项；对应运行的结构化工作目录 | 外部项目路径、cron、时区、下一次执行时间 |
| 工作流快照与受管文件工作流仓库 | 已有 schema 中的结构化 cwd、任务工作目录和受管日志引用 | prompt、command 字符串、原始事件文本、临时来源标记 |
| `plugins/installed.json` | 属于旧受管缓存的绝对 `cachePath` | 外部 `linkedSourcePath`、授权、版本、行为摘要 |
| 桌面 `git-settings.json` | 受管 `path`、`configDir` 以及随迁移改变的所属受管路径 | 外部主仓库 `projectPath`、分支、baseCommit、未提交内容 |
| 凭据、MCP、设置中的明确路径字段 | 仅经过现有 schema 识别、且映射覆盖的受管路径 | 密钥、普通字符串、外部命令和外部资源 |
| 规则与记忆目录 | 受管 cwd 变化后的项目哈希目录键，含相应记忆与会话记忆 | 真实项目键、记忆内容、ID、来源信息与整理时间 |
| 桌面草稿与附件卡片 | 结构化 mention/skill/sourcePath 等受管路径 | 原 inputId、附件顺序、assetId、用户输入原文 |
| 数据位置指针和系统服务配置 | 新根、数据库、日志和启动器位置 | 外部可执行文件与系统要求的服务文件位置 |

实施时把每个实际可恢复 schema 的字段登记成显式处理器；无法识别且会用于恢复执行的结构化版本应让迁移校验失败，不能递归替换所有 JSON 字符串。终态历史事件、Markdown 和聊天正文保留原文。

为了让历史消息里的旧受管文件链接仍可打开，将映射保存到目标 `data/migrations/path-map.json`，在文件打开、图片预览等入口解析旧受管路径后再做原有访问检查。它不能扩大允许访问的目录，不能重写任意 Shell 命令，也不能把所有旧根外路径都放行。

## 5. 迁移流程与失败恢复

### 5.1 谁执行、结果从哪里返回

- Desktop 设置的本机宿主和 CLI 调用同一个迁移实现。协调器放在 `@vykor/server/daemon-host`，不会随着旧后台关闭而消失。
- 后台复用现有全局维护屏障、`prepareRestart`/停写能力和生命周期控制，只负责停止接纳、排空与关闭；不在即将退出的后台里完成自己的整根迁移。
- Desktop 在开始前等待业务草稿写入与旧 localStorage 导出完成，冻结相应编辑入口。CLI 检测到尚未导出的桌面业务数据时返回 `needs_desktop_export`，不直接解析 LevelDB。
- 同一用户只允许一个根迁移。使用启动定位记录旁的锁协调启动和迁移，复用现有文件锁实现。先停止后台和自启动监督者，再释放会随目录交换失效的根内租约；稳定锁与迁移中标记一直保留。
- 不强杀未知进程。有活跃 Run、终端、上传、插件写入或未释放文件时返回具体 busy 项，默认沿用现有 `stopActive: false`。
- 临时聊天重启会丢失正文。预检明确列出这一影响；不得为迁移而把内存聊天导出到磁盘。未处理的活动临时会话阻止执行。

### 5.2 最小接口与状态

```ts
type MigrationPhase =
  | "prepared" | "staged" | "installed" | "verified" | "committed"
  | "failed" | "rollback_failed";

interface DataRootMigrationRequest {
  homeDir: string; // 宿主提供，用于固定定位记录；测试必须用临时 home。
  sourceRoot: string;
  targetRoot: string;
  desktopExportPath?: string;
}

interface DataRootMigrationPreview {
  sourceRoot: string;
  targetRoot: string;
  moves: ManagedPathMove[];
  blockers: Array<{ code: string; path?: string; message: string }>;
  files: number;
  bytes: number;
}

interface DataRootMigrationResult {
  id: string;
  phase: MigrationPhase;
  journalPath: string;
  writersReleased: boolean;
}

async function inspectDataRootMigration(input: DataRootMigrationRequest): Promise<DataRootMigrationPreview>;
async function migrateDataRoot(input: DataRootMigrationRequest): Promise<DataRootMigrationResult>;
async function recoverDataRootMigration(journalPath: string): Promise<DataRootMigrationResult>;
```

迁移记录保存在目标父目录下的 `.vykor-migration-<id>.json`，暂存目录为相邻的 `.vykor-migration-<id>/`。二者在目录交换期间位置稳定，成功后保留受限权限的结果记录；不建设迁移任务数据库、队列或通用插件式迁移框架。

记录只存路径、阶段、源/目标摘要、文件大小和校验值、已完成操作及其恢复位置，不存文件正文。每次不可逆的外部操作前先记意图，完成后原子记录结果。中断恢复要核对实际文件与摘要，不能只信最后一个状态字。

inspect 只做文件信息、已有记录和只读文件内容检查，不实例化 SessionStore，不打开可能创建 WAL/SHM 的源数据库。需要完整读取数据库记录的校验放在停写后的副本上；不能为了“预览”先修改旧库或临时改其格式。

### 5.3 执行顺序

1. **预检：** 规范化来源/目标，校验目录关系、可写性、空间和文件类型；拒绝根互相包含、目标非空且不是本次可恢复迁移、数据库身份冲突、路径碰撞、未导出业务草稿和固定旧启动参数。用户根不变是允许的特殊情况。
2. **停写：** 锁定定位记录，标记迁移进行中，暂停自启动，持有维护屏障，完成桌面业务内容落盘，关闭后台、SQLite 和受管执行资源。确认源文件无额外写入。
3. **复制：** 到暂存目录建立独立副本，保留权限、必要时间戳和未知用户文件；逐文件核对大小及摘要。跨盘不依赖 rename，不使用会与源共享内容的硬链接。
4. **改写与验证：** 只修改副本的已知引用和哈希目录键。验证数据库完整性、外键、附件 blob、笔记组织、插件摘要及授权不变。原始文件摘要与改写后摘要分开记账。
5. **安装目标：** 不同根且目标为空时，将相邻暂存目录原子安装到目标；同根升级时，先把原根原子改名为相邻保留副本，再把暂存目录改名为原根路径。启动定位记录阻止在两次 rename 的间隙创建空根。
6. **修复外部登记：** 对受管 worktree 执行 Git 的 repair，重建系统启动器和服务参数。保留旧服务定义和每个 Git 登记的恢复位置。不要复制有效 PID、端口、token 或活动锁作为新运行状态。
7. **验证新实例：** 用明确目标根启动验证实例，保持定时任务、渠道、恢复执行和所有普通写入尚未激活；新 token、新服务登记待正式发布。检查数据身份、路径和资源读取。
8. **提交选择：** 原子更新启动定位记录，写入迁移提交状态和旧根迁出标记。确保下一次 Desktop、CLI、SDK 服务发现和系统后台都选择新根。保留需要的历史路径映射。
9. **恢复使用：** 发布新后台登记并解除业务冻结，Desktop 重启以重建全部持有旧路径的对象。确认已有业务草稿从新根恢复后，再标记导入完成；旧根、旧工作区和旧导出默认保留。

### 5.4 回退边界

- `committed` 前失败：关闭验证实例，恢复 Git 登记与系统启动项；若发生同根交换，按记录恢复原根。定位记录恢复旧选择，旧数据从未被原地改写。
- 定位记录提交后、普通写入尚未释放：允许按同一记录恢复；同时清理本次新登记，避免客户端连接到半切换的实例。
- `writersReleased` 后不能自动切回旧副本，否则会丢失新写入。此时保留目标并报告修复/反向迁移入口，不拿旧数据冒充最新状态。
- 恢复某一步失败标为 `rollback_failed`，阻止普通启动，返回准确的路径与失败动作；不进入“默认空目录”分支，不删除任一副本。
- 支持在复制、改写、两次同根 rename、Git repair、系统启动项修改、验证和定位提交前后逐点中断，再用同一记录恢复。恢复重复执行不能制造第二套会话或再次导入旧草稿。

## 6. 文件组织与职责

以下为实施文件的职责分工；按任务创建和修改，测试都放所属分类的 `__test__/`。

| 分类 | 新增或修改文件 | 职责 |
| --- | --- | --- |
| 根选择与路径 | 修改 `packages/host-config/src/storage/paths.ts`；新增 `data-root-selection.ts`、`managed-path-relocation.ts` 及同层测试；修改包 exports 和 README | 根选择、定位文件、纯路径计算、受管路径映射 |
| 旧来源清单 | 新增 `packages/server/src/daemon-host/data-root-sources.ts` 及测试 | 解析已知旧来源、去重、冲突与业务导出检查 |
| 迁移协调 | 新增 `packages/server/src/daemon-host/data-root-migration.ts`、`data-root-migration-journal.ts` 及测试 | 停写、暂存、安装、恢复、结果和稳定锁 |
| 数据库引用 | 新增 `packages/services/src/database/data-root-relocation.ts`、`__test__/data-root-relocation.test.ts` | 现有 schema 中的路径事务和验证；不负责复制整个用户根 |
| 插件引用 | 在 `packages/plugins/src/installation/` 增加 `relocation.ts` 及测试 | 只重定位受管安装记录，保留授权与外链 |
| 桌面业务恢复 | 新增 `apps/desktop/src/main/features/business-data/{business-data-service.ts,ipc.ts,README.md,__test__/business-data-service.test.ts}` | 受限种类的读写、串行保存和一次性旧数据导入 |
| 桌面接口 | 新增 `apps/desktop/src/shared/business-data-types.ts`；修改 `src/preload/desktop-api.ts`、现有主进程 IPC 注册入口 | 不把任意磁盘路径暴露给 renderer |
| 桌面恢复消费者 | 修改 `composer-recovery.ts`、`prompt-submission.ts`、`store.ts`、`note-recovery.ts`、`use-image-annotations.ts` 和所属测试 | 异步读取、身份先保存再发送、过滤临时聊天、窗口关闭前刷新 |
| 受管工作区 | 修改 Desktop `outside-project-workspace.ts`、`session-operations.ts`、`session-service.ts`、`workspace-service.ts`；修改渠道与定时任务组装 | 新位置、分类、访问范围和 cwd 一致 |
| worktree 与自启动 | 修改 `git-settings-storage.ts`、`git-settings-service.ts`、`packages/server/src/daemon-host/system-service.ts` 及测试 | 业务登记、Git repair、服务参数和失败恢复 |
| 本机操作入口 | 新增 `apps/cli/src/commands/data-root.ts` 及同层 `__test__/` 测试；修改 CLI 注册和桌面维护设置入口 | inspect/migrate/recover，整根语义替换旧的只切库操作 |
| 贯通测试 | 新增 `tests/desktop-integration/__test__/data-root-migration.test.ts`、`tests/server-client/__test__/data-root-discovery.test.ts` | 跨进程启动、停写、迁移与发现；沿共同测试配置运行 |

每个新分类提供 README，介绍入口、关键步骤、状态存放与新增代码位置。对现有 `auth`、`personalization`、`skills`、`output-styles`、SDK、CLI 等零散根计算的修改，随下一节对应任务一起完成，不另外制造公共配置层。

## 7. 实施任务与依赖

顺序为 T1 → T2 → T3 → T4 → T5 → T6 → T7 → T8 → T9 → T10 → T11 → T12。每项先补有意义的失败测试，再实现，再运行指定检查；一个任务通过后再进入依赖它的任务。

三个关口：T1–T5 完成路径与业务内容接线；T6–T10 完成可恢复迁移与外部登记；T11–T12 才开放完整本机迁移入口并验收。不能在迁移支持尚未完成时把新默认目录发布给已有数据用户，否则会出现“数据消失”的假象。

### T1：建立规范的用户路径定义

**修改：** `packages/host-config/src/storage/paths.ts`、`src/index.ts`、`package.json`、storage 与包 README。**新增测试：** `packages/host-config/src/storage/__test__/user-data-paths.test.ts`；扩展已有 `paths.test.ts`。

- [x] 写路径测试：所有用户默认路径处于指定 `dataRoot` 内；项目目录仍按传入项目计算；中文、空格、Windows 盘符和不同 cwd 不改变用户根。
- [x] 运行 `pnpm --filter @vykor/host-config exec vitest run src/storage/__test__/paths.test.ts src/storage/__test__/user-data-paths.test.ts`，确认缺失新字段/接口的测试失败。
- [x] 实现第 3.3 节接口与轻量 exports；用户根计算不创建目录，不把项目 memoryDir 混入与 cwd 无关的用户路径缓存。相同根的多次求值一致，显式不同根不会命中旧缓存。
- [x] 将 `cache`、`channels`、`workspaces`、`worktrees`、`desktopDataDir` 和扫描遗漏的文件路径补入同一模块。已有 named getter 委托同一份路径规则。
- [x] 重跑本任务测试及 `pnpm --filter @vykor/host-config check-types`。提交范围只含本任务文件，提交说明建议 `feat(config): 统一用户数据根路径定义`。

代表性测试，下面的接口由本任务新增：

```ts
import { resolve, join } from "node:path";
import { expect, it } from "vitest";
import { resolveUserDataPaths } from "../paths.js";

it("derives managed workspaces and runtime data from the same user root", () => {
  const root = resolve("fixtures", "用户 数据");
  const paths = resolveUserDataPaths(root);
  expect(paths.dataRoot).toBe(root);
  expect(paths.dataDir).toBe(join(root, "data"));
  expect(paths.workspacesDir).toBe(join(root, "workspaces"));
  expect(paths.channelsDir).toBe(join(root, "channels"));
  expect(paths.worktreesDir).toBe(join(root, "worktrees"));
  expect(paths.desktopDataDir).toBe(join(root, "data", "desktop"));
});
```

### T2：统一启动选择与 Node SDK 服务发现

**新增：** `packages/host-config/src/storage/data-root-selection.ts`、`__test__/data-root-selection.test.ts`。**修改：** CLI 入口 `apps/cli/src/index.ts` 与 `src/commands/daemon.ts`；Desktop `apps/desktop/src/main/index.ts`、`features/daemon-autostart/daemon-entry.ts`；`packages/client/src/service/registry.ts`、`service.ts`、`package.json` 和已有 service 测试。

- [x] 先写选择优先级、损坏定位记录、进行中迁移、已迁出源根、两个启动者争用稳定锁的测试。覆盖“找不到旧库时不能创建空库”的失败分支。
- [x] 实现定位文件原子读写与排他锁；仅为本程序新建文件和新建专用目录收敛权限，保留既有 home 的 POSIX 模式与 Windows ACL。定位记录和锁文件仅当前用户及必要系统主体可访问；Windows 需实际设置或校验文件 ACL，不能将 mode=0600 当作已收敛。无法满足时明确失败，不修改既有 home 权限。空字符串和相对根路径在产品参数边界报错，显示参数来源。
- [x] 所有产品入口先初始化选择，再导入或创建会持有路径的 store。Node 子进程、系统服务 invocation 与后续重启传递同一个明确根。
- [x] Node SDK 通过轻量路径入口读取相同选择；沿用 `registryFile(env)` 的可测试调用方式，为显式传入 env 的调用者也使用同一优先级，不读取另一套全局 env。
- [x] SDK 只增加构建时工作区引用，由现有 esbuild 打包内联；不能把 `@vykor/host-config` 变成用户必须另装的发布依赖，不能让浏览器入口引入 Node 代码。
- [x] 运行 host-config 根选择测试、`pnpm --filter @rzx/client test`、`pnpm --filter @rzx/client verify:pack`、`pnpm test:client-browser`。检查 CLI 与 Desktop 类型；提交说明建议 `feat(startup): 统一用户根定位与服务发现`。

```ts
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { selectDataRoot } from "../data-root-selection.js";

it("uses the same explicit environment before a saved default selection", () => {
  const pinned = resolve("fixtures", "pinned");
  const saved = resolve("fixtures", "saved");
  expect(selectDataRoot({
    env: { VYKOR_CONFIG_DIR: pinned },
    homeDir: resolve("fixtures", "home"),
    selector: { version: 1, dataRoot: saved },
  })).toEqual({ dataRoot: pinned, source: "environment" });
});
```

### T3：收拢用户级读写与隐式覆盖

**修改：** `packages/auth/src/credentials/credential-storage.ts`、`packages/personalization/src/index.ts`、`packages/skills/src/index.ts`、`packages/output-styles/src/index.ts`、`apps/frontend/src/services/frecency.ts`、`packages/api/src/providers/recordings/capture-probe.ts`、`apps/cli/src/commands/main.ts`；核对 prompts、runtime secrets、agents 和 memory 的已有路径调用。**测试：** 各被测模块同分类的 `__test__/`，扩展现有测试，不新建一个跨全仓目录工具包。

- [x] 先写根切到临时目录后的实际读写测试：输出样式、凭据、frecency、规则、USER/SOUL、待审批更新、环境密钥、用户 Agent、技能、模型缓存均读到目标；真实 home 不产生新文件。
- [x] 把自行拼 `homedir()/.vykor` 和自行读取根变量的生产调用改为规范入口。区分外部 Codex 凭据、共享技能等有意保留的 home 路径，不能全仓替换 homedir。
- [x] 让旧独立覆盖进入来源检查，不在模块中继续各自覆盖目标。保留测试和嵌入 API 显式传路径的能力；产品启动发现根外覆盖时返回来源明细。
- [x] 关闭/重建凭据和 OAuth store、渠道 store、frecency 内存数据及延迟保存定时器后才允许切换，不保留指向旧根的 debounce 写入。
- [x] 运行受影响包测试与类型检查；用精确搜索确认产品根解析仅留在规范入口和明确标注的迁移来源读取中。提交说明建议 `refactor(storage): 收拢用户业务数据读写路径`。

本任务测试至少包含以下实际动作，不能只断言路径字符串：

```text
设置临时 dataRoot → 在旧 home 和目标 output_styles 放同名不同内容
调用真实样式加载器 → 只读目标内容
写一条规则、一个 USER 待审批更新和一条凭据
关闭所有 store → 重新打开 → 从目标读回
检查旧 home 的文件摘要和目录项不变
```

### T4：接入 workspaces、channels 与默认 worktrees

**修改：** Desktop `features/session/outside-project-workspace.ts`、`session-operations.ts`、`session-service.ts`、`features/workspace/workspace-service.ts`、`workspace-path.ts`；`packages/server/src/application/channel/channel-runtime-assembly.ts`、`schedule/scheduled-task-executor.ts`；`packages/agent-runtime/src/node/children/child-environment.ts`；Desktop `git-settings-service.ts`。

**测试：** 扩展 `outside-project-workspace.test.ts`、`session-operations-modes.test.ts`、`session-operations-worktree.test.ts`；新增纯路径和并发分配测试到相应 `__test__/`，扩展渠道与定时任务既有测试。

- [x] 先测无项目创建的 cwd 位于 `root/workspaces/日期/xN`，并发请求不会共用目录；日期继续按用户本地时区，失败只清理本次新建的空目录。
- [x] 将分配器参数改为“工作区根”，禁止再默认拼 Documents 或重复附加 Vykor。渠道直接用 channelsDir，定时任务用同一个 workspacesDir。
- [x] 默认任务 worktree 使用 worktreesDir；调用 manager 的参数语义要核对，避免得到 `worktrees/worktrees`。真实项目内工具创建的项目级 worktree 保持原语义。
- [x] 项目外会话隐藏、渠道项目隐藏、文件分类、工作区额外访问范围和 bootstrap 返回的根一起更新；旧路径识别只从迁移映射读取，不再把所有 Documents/Vykor 永久当新默认。
- [x] 运行 Desktop 对应会话与 Git 测试、server 渠道/定时任务测试，以及受影响包类型检查。提交说明建议 `feat(workspaces): 将受管工作区纳入用户数据根`。

验收脚本：使用同一临时根创建两个无项目聊天、一个渠道聊天、一个无项目定时任务、一个项目任务 worktree；断言五者位置正确、界面项目分类正确、真实项目 cwd 未搬。暂存与最终迁移目录不能出现在项目列表中。

### T5：迁移桌面业务恢复存储，保留提交顺序

**新增：** 第 6 节的 `business-data` 分类、shared 类型和 IPC。**修改：** `composer-recovery.ts`、`store.ts`、`prompt-submission.ts`、`note-recovery.ts`、`use-image-annotations.ts`、笔记恢复调用方、`git-settings-storage.ts`、preload 和 IPC 注册。

接口限制在已知业务种类，不能提供 renderer 任意文件读写。图片批注键使用受限摘要字符集：

```ts
type BusinessDataKey =
  | { kind: "composer" | "notes" | "quick-notes" }
  | { kind: "image-annotations"; imageKey: string };

interface BusinessDataRecord {
  version: 1;
  revision: number;
  value: unknown; // 每个 kind 用已有业务 schema 校验。
}

interface BusinessDataApi {
  read(key: BusinessDataKey): Promise<BusinessDataRecord | null>;
  write(key: BusinessDataKey, value: unknown, expectedRevision: number | null): Promise<BusinessDataRecord>;
  flush(): Promise<void>;
}
```

- [x] 先测 IPC 无法传路径逃逸；同一记录并发写串行；旧 revision 被拒绝，不能静默覆盖另一窗口的新草稿；写盘失败时返回失败而非成功回执。
- [x] 以原子文件替换保存各业务种类。保留现有恢复格式的 ID、顺序和内容；不要把 localStorage 的所有键导入。应用窗口选择状态、滚动位置与浏览器偏好不迁。
- [x] 将现有同步恢复改成初始化时 await 读取；加载完成前不以空草稿覆盖已有记录。`saveComposerRecovery()` 的调用方全部等待持久化成功，特别是 `prompt-submission.ts` 中保存原 inputId 后才能发 IPC 的约束。
- [x] 保留临时会话和 linked-chat 草稿过滤；不能把目标临时会话正文藏进普通 source 会话草稿导出。普通新会话草稿继续恢复。
- [x] 使用已有 schema 读取旧 composer、main/quick 笔记、图片批注键，写入新根并核对摘要后标记导入。重启或重复导入不能用旧 localStorage 覆盖更新的目标记录；保留旧数据供恢复，不调用 localStorage.clear。
- [x] 批注继续按图片字节的 SHA-256 标识，沿用 `image-annotations.ts` 的算法；导入时只剥离已知 localStorage 键前缀作为受限 imageKey。不能改成按绝对图片路径命名，否则文件搬迁后会找不到原批注。
- [x] 窗口关闭与迁移前等待 flush；保存失败时保留编辑内容，停止发送/迁移并显示现有错误反馈。不能在 beforeunload 中启动一个无人等待的异步写入。
- [x] `git-settings.json` 的业务记录改存 desktopDataDir；可以整体保留现有 Git 偏好和 worktrees 结构，不为窗口偏好增加迁移。旧文件导入遵循相同确认规则。
- [x] 扩展 composer-recovery、temporary-chat-state、笔记恢复、批注和主进程业务服务测试；检查 preload/shared/renderer 类型。提交说明建议 `feat(desktop): 将用户业务恢复数据保存到数据根`。

必须保留的失败测试顺序：

```text
创建原 inputId 和附件顺序 → 让业务文件 write Promise 保持未完成
触发发送 → 断言 sessions.prompt 尚未调用
让保存失败 → 断言正文留在编辑器、未发送、可重试且 inputId 不变
让保存成功 → 才允许发送，重启后可校对原请求是否已接纳
换成 memory 会话 → 写入请求和旧键导出都不含临时正文
```

### T6：实现迁移来源预检和路径边界

**新增：** `packages/server/src/daemon-host/data-root-sources.ts`、`__test__/data-root-sources.test.ts`；`packages/host-config/src/storage/managed-path-relocation.ts`、`__test__/managed-path-relocation.test.ts`。**修改：** `data-location.ts` 的旧位置读取及 desktop 旧导出接线；本阶段不改变正在运行的库。

- [x] 使用临时目录建出旧根、分离的运行数据、Documents 工作区、userData 和已导出的业务内容。先测返回完整来源清单；重复目录只出现一次，渠道与普通工作区不重复复制。
- [x] 逐项实现第 4.1 节来源。无来源文件属于正常缺项；损坏的设置、指针或 SQLite 文件返回具体错误，不能用默认空内容替代。
  预检仅用只读文件头、大小与摘要识别可判定的格式错误，不建立会自建 SHM 的 SQLite 连接；记录/schema、完整性、外键及库内登记路径列为强制的停写后副本校验。宿主列表缺失不能视为空库，协调器须从独立副本补全并重新预检后才安装。
- [x] 拒绝磁盘根、用户 home 本身和真实项目祖先作为要整体交换的受管根；校验规范化后的源/目标都处于明确用户指定的迁移范围。未确认归属的非空目标不写入。
- [x] 两个不同会话库、同名不同内容、大小写冲突、空间不足、不可写目标和不安全 junction 均成为 blocker。源与目标相同只进入同根升级分支，不被误判为普通目标冲突。
  Windows 有效 ACL 不能仅由只读 W_OK 检查可靠证明时，预检明确列为迁移准备强制项；协调器须在业务复制和交换前用自有相邻暂存验证实际写入及必要权限，失败阻止继续，不能声称预检已验证可写。
- [x] 实现第 4.2 节边界正确的映射；不跟随符号链接复制根外内容。外部链接保留链接，指向被搬受管资源的链接按映射修复并记录。
- [x] CLI 检测到未导出的桌面业务数据返回 `needs_desktop_export`，给出打开桌面应用完成导入的动作；不能直接打开 LevelDB 解析正文。
- [x] 运行新来源和映射测试及 server/host-config 类型检查。提交说明建议 `feat(migration): 清点旧数据来源并验证迁移边界`。

```ts
import { resolve, join } from "node:path";
import { expect, it } from "vitest";
import { relocateManagedPath } from "../managed-path-relocation.js";

it("does not relocate a sibling with a similar name", () => {
  const from = resolve("fixtures", ".vykor");
  const to = resolve("fixtures", "new-root");
  const moves = [{ kind: "user-root" as const, from, to }];
  expect(relocateManagedPath(join(from, "skills", "a"), moves))
    .toBe(join(to, "skills", "a"));
  const sibling = resolve("fixtures", ".vykor-other", "keep.txt");
  expect(relocateManagedPath(sibling, moves)).toBe(sibling);
});
```

### T7：重定位数据库、插件与项目键

**新增：** `packages/services/src/database/data-root-relocation.ts`、`__test__/data-root-relocation.test.ts`；`packages/plugins/src/installation/relocation.ts`、`__test__/relocation.test.ts`。**修改：** 现有数据库、工作流、记忆和个性化的公开入口；需要一起更新的分类 README。

本任务提供以下有界操作，协调器只在副本上调用：

```ts
interface PathRelocationReport {
  changed: number;
  unchangedExternal: number;
  unsupported: Array<{ table: string; id: string; version?: number }>;
}

function relocateDatabasePaths(databasePath: string, moves: readonly ManagedPathMove[]): PathRelocationReport;
async function relocateInstalledPluginStore(storePath: string, moves: readonly ManagedPathMove[]): Promise<PathRelocationReport>;
```

- [x] 建立包含正式/临时来源附件、笔记、受管与外部项目、session task、schedule、workflow、插件外链和授权的真实 SQLite/文件 fixture；记录所有 ID 与关键内容摘要。
- [x] 先写失败测试：受管字段全部更新，外部路径不变；消息正文、Markdown、command 与 prompt 即使包含旧根字符串也保持原文；插件授权与行为摘要完全相同。
- [x] 用 Drizzle 和现有 schema 在目标数据库内事务更新第 4.2 节字段。不能为修改几列加载整套 Agent Runtime 或启动后台维护；事务失败回滚目标副本的本轮变更。
- [x] 更新 project location 的规范路径与索引键，核对唯一约束和 `cwdRelative`；保持项目/会话 ID、引用和排序，不删库重建项目。
- [x] 为已定义的可恢复工作流快照和宿主 metadata 写显式字段处理器。遇到不能安全恢复的版本报告 unsupported 并阻止提交；终态原始事件不做全文替换。
- [x] 迁移受管 cwd 对应的 local_rules、memory、session-memory 哈希目录，复用已有规范化和摘要算法。若新键已存在且内容不同，回到冲突预检，不覆盖。
- [x] 改写插件安装记录中的受管 cachePath；外链路径、授权、版本和摘要保留。对改写后路径运行既有插件校验；不要改插件快照内容来绕过摘要失败。
- [x] 运行新迁移测试、已有 workflow、notes、attachments、plugin installation 测试和 services/plugins 类型检查。提交说明建议 `feat(migration): 重定位受管数据引用并保留历史内容`。

测试必须实际重新打开目标库，执行外键和完整性检查，读取一份附件与一条笔记、验证一个插件。不能只检查 JSON 中出现了新字符串。

### T8：实现独立副本、迁移记录和同根交换

**新增：** `packages/server/src/daemon-host/data-root-migration.ts`、`data-root-migration-journal.ts`、`__test__/data-root-migration.test.ts`、`__test__/data-root-migration-recovery.test.ts`。**复用：** `packages/host-config/src/storage/atomic-json-write.ts`、现有备份校验和附件完整性检查。

- [x] 先用临时 home、sourceRoot、targetRoot 测试复制、验证与失败恢复；所有测试调用都明确传入 `homeDir`，不能读真实定位文件。
- [x] 实现 prepared → staged → installed → verified → committed 的持久记录。每一阶段保存前先完成上阶段校验；源摘要与改写后摘要分开；记录不包含正文和凭据。
- [x] 先复制后改写，确保目标副本没有与源共享内容的硬链接；复制时检查来源是否被并发改动，发现变化立即中止。对文件数量、字节数、摘要、模式与必要时间戳做对照。
- [x] 识别并重建登记、活动租约和运行副本；保留未知文件、未知锁文件以及记忆整理时间。损坏密钥文件不能用空 JSON 修复。
- [x] 不同根采用相邻暂存安装；同根采用“原根 → 相邻保留副本、暂存 → 原路径”的两步交换。执行前与恢复时都验证绝对路径仍在预检范围，Windows 全程使用同一套文件系统 API。
- [x] 将前一任务的结构化重定位应用于副本，核对 SQLite、blob、笔记和插件一致性后才安装。不能把现有应用备份误称为完整用户根备份；它不含的根级凭据、技能、草稿和工作区由本任务清单补齐。
- [x] 实现 recover：先读记录，再核对 source/staging/backup/target 的实际身份；恢复操作可重复执行。来源不存在、摘要不匹配或两个副本身份不明时保留现场并阻止启动。
- [x] 覆盖中断测试：复制一半、改写失败、第一次同根 rename 完成、安装完成但未验证、定位提交前后、恢复再中断。用受控 Promise 或文件操作故障注入，不靠固定 sleep 赌时序。
- [x] 运行本任务测试和 server 类型检查。提交说明建议 `feat(migration): 增加可恢复的数据根复制与交换`。

代表性故障验收，使用真实目录与真实目标库：

```text
记录 source 中数据库、凭据、未知用户文件的摘要
复制成功后让目标校验抛错
断言旧 source 的目录、文件和摘要完全不变，选择记录仍指向旧根
重新运行同一个恢复入口
断言没有第二份会话、没有重复的草稿导入、失败阶段清楚可见

同根升级在第一次 rename 后模拟中断
启动普通后台 → 明确拒绝，不创建空 source
运行恢复 → 原根或已校验新根恢复到确定状态，两份内容均未被误删
```

### T9：修复 Git worktree 与历史文件引用

**修改：** Desktop `features/settings/git-settings-service.ts`、`git-settings-storage.ts`；`packages/agent-runtime/src/node/children/child-environment.ts`；Desktop `features/workspace/workspace-service.ts` 和文件打开/图片预览入口。**新增或扩展测试：** 以上分类的 `__test__/`，以及 `packages/host-config/src/storage/__test__/managed-path-relocation.test.ts`。

- [x] 使用真实临时 Git 仓库创建受管 worktree，包含暂存修改、未暂存修改和未跟踪文件。记录分支、HEAD、git status 和文件摘要，不能通过 mock 掩盖登记问题。
- [x] 文件副本安装到最终目标后，用主仓库执行 `git worktree repair <目标目录>`，验证目标的 top-level、common-dir 和分支。跨盘用复制加 repair，不假定 `git worktree move` 能处理所有工作树。
- [x] 如果主仓库本身位于被搬的受管工作区，先定位新的主仓库，再修复它的 worktree；不能继续拿保留副本中的旧主仓库当唯一主仓库。真实外部主仓库位置保持不变。
- [x] 将 Git repair 和恢复旧登记作为迁移记录中的一组动作。目标验证失败时，对旧位置执行对应 repair 并校验；不使用 reset、clean、强制 checkout 或直接全文改写 `.git`。
- [x] 被锁 worktree、主仓库不可用或不支持安全修复的情况在预检成为 blocker；错误包含具体 worktree，保留全部副本。
- [x] 保存受管历史路径映射。文件打开、工具图片预览和结构化附件卡片在权限检查前解析映射，再按目标真实路径执行原访问限制；普通用户文字和 Shell 命令不改。
- [x] 使用前缀相似的外部路径、越界路径、WSL/Native 转换和真实文件链接测试，确认映射不扩大权限。Native 受管路径先重定位，再复用现有环境路径转换。
- [x] 运行 Git/workspace/预览测试和 Desktop/agent-runtime/host-config 类型检查。提交说明建议 `feat(migration): 修复工作树登记与受管历史文件引用`。

### T10：接入停写、验证实例和系统自启动

**修改：** `packages/server/src/daemon-host/registered-daemon.ts`、`data-location.ts`、`registry-lease.ts`、`system-service.ts`、公开入口；`packages/server/src/application/control/daemon-operation-gate.ts`、维护与备份协调入口；Desktop `daemon-connection-service.ts`、`daemon-autostart/daemon-entry.ts`。**测试：** daemon-host 的 `__test__/`，扩展已有 system-service/lifecycle 与 Desktop connection 测试。

- [x] 先测源/目标后台仍存活、控制锁竞争、上传未完、定时任务/渠道仍会触发、终端未退出时都不能搬目录；测试确定触发并等待排空，不扩大为强杀未知进程。
- [x] 复用维护屏障和现有停止流程，暂停所有自动写入者与自启动监督者，等待 SQLite、受管终端、插件后台和文件句柄关闭。释放会跟随目录改名失效的旧根租约前，固定启动锁和 pendingMigration 已生效。
- [x] 验证实例使用迁移协调器持有的明确路径与现有 `deferBackgroundActivation` 能力，不增加一个可绕开启动保护的公开参数。定时任务、渠道和恢复执行保持关闭直到提交。
- [x] 根迁移不再修改旧进程的环境并原地换库。旧 `data-location.json` 和 userData/runtime-data-location.json 只用于来源导入；目标运行数据与库位置按统一布局保存。
- [x] 生成新 token、PID/地址登记。旧 registry 与 lease 不是可恢复业务数据。SDK 和 Desktop 只能在定位提交后发现新正式登记。
- [x] 系统服务用目标根重建 launcher、参数和日志路径；Windows 计划任务引用新启动器，macOS/Linux 服务文件仍位于系统目录。修改期间不能触发普通写入，启动入口看到 pending 状态必须退出或等待。
- [x] 服务变更先保存原定义；注入安装失败、验证实例打不开目标库、启动超时等故障，核对旧 Git/服务/选择恢复。恢复失败时状态必须是 rollback_failed。
- [x] 定位提交后才发布登记和激活写入；激活时持久记下 writersReleased。该标记写入失败时不得先放行普通写入。
- [x] 运行新恢复测试、daemon-host/maintenance/connection 的受影响测试与类型检查。提交说明建议 `feat(daemon): 协调数据根迁移与后台重启`。

### T11：接通本机 inspect、migrate、recover 操作

**新增：** `apps/cli/src/commands/data-root.ts`、`__test__/data-root.test.ts`。**修改：** CLI 注册；Desktop `features/settings/maintenance-settings-service.ts`、`maintenance-settings-ipc.ts`、`shared/maintenance-settings-types.ts`、preload、现有存储设置页；`session-service.ts` 的现有数据切换调用。

本机命令语义固定为：

```text
vk data-root inspect --from <完整旧根> --to <完整目标根>
vk data-root migrate --from <完整旧根> --to <完整目标根>
vk data-root recover --journal <完整迁移记录路径>
```

- [x] 先测 inspect 只读，不创建定位文件、锁、暂存、数据库或目录；输出根来源、迁移清单、冲突、预计空间和重启影响，不打印凭据或草稿。
- [x] migrate/recover 调用同一个宿主实现；Desktop 先 flush 与导出业务键，再进入相同流程。请求中的 homeDir、源 profile 等由本机宿主确定，不能从 renderer 任意传入。
- [x] Desktop 提供明确的“用户数据根”含义与当前实际路径，选择的是整根目录。不能把旧的 `switchData(directory)` 中 `join(directory, "sessions.db")` 继续套在新参数上。
- [x] 旧只切库入口不再作为产品设置行为。已有旧数据库位置作为迁移来源导入；旧接口调用应返回明确的迁移提示，不静默按新语义解释旧参数。
- [x] 复用已有维护进度和错误展示。失败说明停在哪一步、当前可使用的根和恢复记录位置；用户内容不放进诊断错误或日志。远程连接不开放本机任意根迁移 HTTP 接口。
- [x] 切换时清理旧业务数据读缓存、订阅和客户端，Desktop 重启并从新根重新 hydration。只有确认目标草稿恢复成功才标记旧业务导入完成。
- [x] 保留现有键盘操作和减少动态效果。优先复用现有组件；确需新组件时按 beUI 及 `apps/desktop/DESIGN.md` 选型。样式交给用户查看，不主动建预览或截图。
- [x] 运行 CLI 命令、维护 IPC、设置服务和相关 store 测试，检查 CLI/Desktop 类型。提交说明建议 `feat(storage): 接通本机数据根迁移与恢复操作`。

### T12：贯通验收、发布关口与文档收口

**新增：** `tests/desktop-integration/__test__/data-root-migration.test.ts`、`tests/server-client/__test__/data-root-discovery.test.ts` 和必要的同分类测试 fixture。**修改文档：** 下节列出的当前手册、目录 README、源码引用登记。

- [x] 在临时 home 和脚本化 Provider 下，从旧布局建立正式聊天、临时聊天、附件、笔记、规则、技能、插件、业务草稿、受管工作区、worktree 和自启动定义；不访问真实用户数据或付费模型。
- [x] 运行一次新根迁移和一次同根归拢，按第 8 节逐条验收。目标启动后实际读取资源、打开旧消息链接、继续正式会话；验证临时正文不能从 SQLite 或迁移文件恢复。
- [x] 逐阶段故障注入和重复恢复后，再核对 source/target、定位记录、Git、系统服务与业务导入的一致性。只要回退仍有疑点，就不能开放迁移 UI 或发布自动目录切换。
- [ ] 明确验证 source 保留、Windows 跨盘复制、macOS/Linux 路径、大小写边界、中文路径、权限失败与非空目标冲突。跨盘测试在可提供两个卷的环境执行；单卷测试只能证明复制逻辑，不能宣称跨卷平台验收完成。
- [x] 检查所有新增测试归属、公开导出和 README；更新当前手册而非批量改写历史方案。迁移源码文件或修改旧引用时，同步精确引用登记的路径、行号和原文。
- [x] 执行第 9 节最终命令，记录命令、退出码和受限环境。通过后逐项勾选验收，不用前一轮的 78 项测试代替本轮验证。
- [x] 检查 `git diff`，只提交本计划实施范围；不覆盖用户已有改动。提交说明建议 `test(storage): 验收统一数据根与迁移恢复`。

## 8. 验收清单

| 编号 | 场景与明确结果 | 责任任务 |
| --- | --- | --- |
| A01 | 默认根与自定义根下，全部清单路径由同一个 dataRoot 派生；不在真实 home 新建业务文件 | T1、T3 |
| A02 | 显式参数、环境变量、定位记录、默认值按约定选择；坏记录和未完成迁移不创建空库 | T2 |
| A03 | Desktop、CLI、系统后台和独立安装的 Node SDK 找到同一个根及正式后台登记 | T2、T10、T12 |
| A04 | 无项目聊天、渠道、无项目定时任务和默认任务 worktree 位于新根，分配并发不重名 | T4 |
| A05 | 真实外部项目、共享技能、外部插件来源和外部工具凭据保持原位置 | T3、T6、T7 |
| A06 | 旧分离运行数据连带数据库旁的 blob、笔记、策略和用量设置一起归并 | T6–T8 |
| A07 | SOUL、USER 待审批、agents、运行环境密钥、记忆备份、导出、审计均保留 | T3、T8 |
| A08 | 未识别用户文件和未识别锁保留；.consolidate-lock 的整理时间语义不丢失 | T6、T8 |
| A09 | 临时消息、普通 Run、目标和事件重启后不存在于 SQLite、备份、迁移记录或业务草稿 | T5、T7、T12 |
| A10 | 临时来源附件与工作流保留来源标记；自动记忆仍跳过，显式记住仍能保存 | T7、T12 |
| A11 | 普通草稿与笔记/批注从旧键导入；不复制浏览器缓存，不覆盖窗口偏好，不清空整个 localStorage | T5 |
| A12 | 保存原 inputId 失败时不发送；重试身份、附件顺序不变；加载完成前不空写草稿 | T5 |
| A13 | 未导出桌面业务内容或窗口 flush 失败时阻止迁移，CLI 不直接解析 LevelDB | T5、T6、T11 |
| A14 | 只改受管结构化路径；正文、Markdown、command 原文、授权、外部路径不变 | T7 |
| A15 | 受管项目 cwd 改变后规则/记忆哈希目录仍可读取，ID 和来源不变 | T7 |
| A16 | 插件新 cachePath 验证通过，外链来源与 approvedPermissions、行为摘要完全不变 | T7 |
| A17 | worktree 的分支、HEAD、索引、脏文件与未跟踪文件不丢，repair 与回退均能实际打开 | T9 |
| A18 | 历史受管文件链接可打开，前缀相似路径与越界路径不能借映射扩大访问 | T9 |
| A19 | 源/目标互相包含、非空异库目标、大小写碰撞、坏指针、不可写、空间不足被预检阻止 | T6 |
| A20 | inspect 没有文件系统写入；迁移记录和日志不含密钥、正文、完整业务草稿 | T6、T8、T11 |
| A21 | 活跃后台、Run、终端、上传、插件或渠道写入未结束时不搬目录；自启动不会抢先重开 | T10 |
| A22 | 同根交换第一次 rename 后中断，普通启动被阻止，恢复后不会出现空根或第二套会话 | T8、T12 |
| A23 | 跨盘使用独立复制，内容与必要权限校验正确，不依赖跨卷 rename 或源目标硬链接 | T8、T12 |
| A24 | 复制、改写、Git、服务、验证或定位提交失败时恢复到明确根；恢复失败阻止普通启动 | T8–T10 |
| A25 | 定位提交但未放行写入时可恢复；新写入放行后不会自动切回旧副本 | T8、T10 |
| A26 | 恢复同一迁移两次不重复导入；目标较新的草稿不被旧键覆盖；原始副本默认保留 | T5、T8、T11 |
| A27 | 浏览器 SDK 不含 Node 路径模块，Node SDK 独立安装不依赖未发布工作区包 | T2、T12 |
| A28 | 旧只切库参数不被误当整根；数据迁移后没有后台继续向旧默认位置写入 | T3、T10、T11 |

## 9. 验证命令与记录要求

任务内先运行自己的定向测试和类型检查；失败按实际原因处理，不通过跳过断言证明迁移成功。源码搜索要区分产品入口、迁移来源识别、真实项目路径和外部工具路径，不能以“homedir 全部消失”作为完成条件。

建议最终依次执行，不反复重跑已通过且未再受改动的全量检查：

```powershell
pnpm check-types
pnpm test
pnpm --filter @rzx/client verify:pack
pnpm test:client-browser
pnpm check-docs
pnpm check:retired-ui
```

本计划采用原有 test 配置覆盖新增的 `__test__/` 文件；实现前先核对 include 范围。`pnpm test` 包含既有执行、Agent、Desktop 和服务端/客户端贯通测试，不另重复运行同一整套。

2026-11-12 扫描阶段的基线是 services 37 项、server 18 项、Desktop 23 项通过。Desktop 在 Node 26 自带 localStorage 与 jsdom 冲突后，临时关闭 Node 的实验 Web Storage 重跑通过。这是现有行为基线，不是新迁移功能验收。

如实施环境仍有同一冲突，只在测试命令进程范围内追加参数，并恢复原环境；不要为跑测试修改业务源码、全局 Node 配置或真实 localStorage：

```powershell
$dataRootPlanNodeOptions = $env:NODE_OPTIONS
try {
  $env:NODE_OPTIONS = "$dataRootPlanNodeOptions --no-experimental-webstorage".Trim()
  pnpm test
} finally {
  if ($null -eq $dataRootPlanNodeOptions) {
    Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue
  } else {
    $env:NODE_OPTIONS = $dataRootPlanNodeOptions
  }
}
```

记录每个关口的命令、退出码、测试数量、平台和未完成的真实跨卷验收。最终报告不能把单元测试的模拟 EXDEV 当作 Windows 跨盘实测，也不能把 JS 存储测试当成真实桌面 profile 导出验收。

## 10. 实施时同步维护的文档

- [运维与恢复](../../operations-and-recovery.md)：根选择、定位记录例外、停写、保留副本、恢复命令和不能自动回退的边界。
- [daemon 系统服务](../../daemon-system-service.md)：同一用户根、启动器与服务参数更新。
- [客户端 SDK](../../client-sdk.md)：Node 服务发现与显式根；浏览器入口保持无文件系统依赖。
- [上下文与记忆索引](../../context-memory-map.md)、[记忆系统](../../memory-system.md)：USER/SOUL、规则、项目键与临时聊天边界。
- [渠道流程](../../channels-flow.md)、[定时任务](../../scheduled-tasks-flow.md)：受管工作区位置与分类。
- [插件体系](../../plugin-system.md)：cachePath 重定位、授权与外链保留。
- [开发数据重置](../../development-data-reset.md)：新根和启动定位记录的区别；不能把完整根视为可随意删除的缓存。
- [契约与测试索引](../../contract-test-index.md)：A01–A28 对应的最终测试入口。
- 各受影响包、分类、公共 exports、根目录导航和当前精确引用登记。历史方案保留原语境，开头需要时链接新的当前手册，不批量篡改历史记录。

本计划只定义执行顺序与验收。实施时每完成一项更新复选框和实际验证证据；未做的迁移、未跑的测试和未完成的平台验证继续保持未完成状态。
