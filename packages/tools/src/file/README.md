# 文件工具与基础操作

组织读写工具、文件基础操作、路径和内容处理。

## 主要文件

| 文件 | 主要导出 |
| --- | --- |
| [index.ts](./index.ts) | 统一导出本分类的类型与函数 |
| [operations.ts](./operations.ts) | `FileEntry`、`FileStat`、`GrepOptions` |
| [mutation-lock.ts](./mutation-lock.ts) | 修改事务的统一入口，缺少后端能力时采用保守独占保护 |
| [directory-scan.ts](./directory-scan.ts) | 本机增量目录读取、WSL 有界扫描脚本和结果解析 |
| [open-host-reader.ts](./open-host-reader.ts) | 本机已打开文件的对象识别、单次有界读取和关闭 |
| [open-wsl-reader.ts](./open-wsl-reader.ts) | WSL 保持文件描述符，先返回元数据、待授权后读取并等待退出 |
| [path.ts](./path.ts) | `resolveToolPath`、`normalizeToolPath` |
| [preview.ts](./preview.ts) | `FileChangePreview`、`computeFileChange` |
| [read.ts](./read.ts) | `DEFAULT_READ_LIMIT`、`MAX_READ_BYTES`、`MAX_READ_BYTES_LABEL` |
| [instructions.ts](./instructions.ts) | 按当前目标发现嵌套目录项目规则，四种文件工具共用 |
| [text-content.ts](./text-content.ts) | `BINARY_SAMPLE_CHARS`、`BINARY_CONTROL_RATIO`、`isBinaryContent` |
| [write.ts](./write.ts) | `createFileWriteTool`、`fileWriteTool` |

## 分类目录

| 目录 | 用途 |
| --- | --- |
| [access/](./access/README.md) | 检查执行环境路径、宿主管理文件和文件修改权限。 |
| [editing/](./editing/README.md) | 处理替换定位、批量编辑、补丁计划、差异和编辑反馈。 |
| [search/](./search/README.md) | 提供文件匹配及宿主文本搜索的共用实现。 |

## 入口与处理步骤

主要入口或定义见 [index.ts](./index.ts)。

从文件工具工厂进入，先解析路径并执行访问检查，再读取或写入内容，按需要生成预览和返回结果。

`Read` 成功后，`targetProjectInstructions()` 先解析实际目标，再沿其真实目录到工作区真实根之间的祖先链检查 `AGENTS.md`、`CLAUDE.md` 和 `.claude/CLAUDE.md`，不扫描其它子树；创建新文件时，从最近存在的父目录解析真实位置。目录链接或 Windows junction 仅作为目标别名，不额外引入别名路径上的规则链：例如 `link → package/sub` 必须加载 `package/AGENTS.md`，显示的 scope 也是实际目录；规则仍按真实目录由浅到深、具体目录优先，同目录 `AGENTS.md` 优先。根规则继续由初始系统提示负责。使用当前环境的执行路径和文件接口，真实路径必须仍在同一工作区。每份规则分别检查普通 `Read` 权限与 sandbox，并绑定已打开的文件对象重新检查真实路径后才读取；无真实路径或对象识别能力时不降级到宿主文件读取。

规则单文件完整读取上限为 1 MiB，每次扫描最多 64 份、总计 4 MiB，另有一字节截断探针。超过单文件上限时不认可任何部分版本，并说明具体规则文件需要工作区负责人缩短或拆分；超过总扫描预算同样说明尚未完成的路径。完整规则在 helper 内按 3000 个 Unicode 字符切片，每片不超过 12 KB，标明第几片及总片数。每片版本键绑定整份文件内容与片号，不能用前缀代表未读的尾部；修改必须等本次版本的所有片段已经交付。每次新增输出最多 24 片、格式化正文最多 40 KB，已经可见的片段不占新增输出预算，多层祖先和大规则可以重复同一次操作逐步交付。规则和文件正文共同使用原有 50 KB Read 输出预算；规则片段保留完整正文，普通结果预览只缩短剩余文件输出。

读取或扫描硬上限会附带内部 `hostProjectInstructionHardLimit` 事实，区别于可以继续交付的分页或同批等待。受检执行仅接受可信内置文件工具的该事实；即使同批其它 Read 提供了新规则，达到硬上限的修改仍进入普通失败保护，不会被算作规则交付进展。

规则内容、路径和版本组成去重键，运行时根据当前可见历史区分首次发现、同批等待交付和已经交付。首次规则加入 Read 结果；`Write`、`Edit`、`ApplyPatch` 在原有锁和权限检查内发现首次或同批待交付规则时，先返回 `not_started`，文件不变，模型看到规则后可重试。规则中明确标出目录作用域、同层 `AGENTS.md` 优先和用户指令优先；它们不能授权访问，也不影响无关路径。压缩移除正文后，再访问此路径会重新提供规则。对应回归见 [scoped-instructions.test.ts](./__test__/scoped-instructions.test.ts)。

`Write`、`Edit` 和 `ApplyPatch` 解析目标路径后，通过 `withFileMutationLock` 在首次目标读取前加锁，锁覆盖权限复核、内容读取、修改规划、快照或哈希复核以及实际写入或删除。`HostFileOperations.withMutationLock` 使用 `execution-node` 的进程内共享协调器，按目标真实路径排序并去重后取锁，身份不含会话、工作目录或 runtime owner；无环境注入时新建的 Host 实例同样使用此协调器。本机不同目标仍可并行。

WSL 挂载路径及缺少此能力的自定义后端无法可靠归一到本机文件，因此使用同一协调器的独占保护：等待正在执行的本机修改结束，并阻止后续本机修改进入。它们的文件修改保守串行，不根据 `/mnt` 字符串猜测目标身份。取消只停止排队或尚未开始的写入；已开始的 I/O 必须结束后才释放锁。锁队列空闲时清理，不随单个会话关闭而重建。

此保护覆盖同一 Node JavaScript 宿主中协作的文件工具调用，不协调外部编辑器、Shell 或另一进程。原有 `expected_sha256`、快照复核、独占创建和原子替换仍保留，跨文件补丁也不承诺失败回滚。特殊 Windows 设备路径、备用数据流、尾点或尾空格，以及无法稳定识别的悬空链接会在写入前拒绝。

本机锁标识保守合并大小写及 Unicode 组合形式；在能区分这些名称的磁盘上，两个不同文件可能额外串行。实际读写路径不变，普通不同目标仍可并行。这也覆盖非 Windows 上常见的大小写不敏感磁盘，不能仅用操作系统名称推断磁盘规则。

`HostFileOperations` 和 `WslFileOperations` 的 `stat` 返回目标大小 `sizeBytes` 与毫秒时间戳 `modifiedAt`。`readBytes(path, { maxBytes, signal })` 可限制实际读取的字节数并响应取消；未传 `maxBytes` 时保持整文件读取。调用方需要判断是否截断时，可多请求一个字节。读取不会修改文件，路径权限检查仍由调用方完成。

`stat(path, signal)` 与 `listDir(path, signal)` 也接受取消信号。本机调用在系统查询前后检查取消；WSL 将取消信号交给执行进程。

`openRead(path, signal)` 将实际对象识别和读取绑定。调用方先授权返回的 `canonicalPath`，再调用一次 `readBytes({maxBytes,signal})`，最后在 `finally` 等待幂等的 `close()`；打开对象后不再按原路径读取。Linux 使用 `/proc/self/fd`；Windows 仅支持本地 NTFS、同卷且只有一个硬链接的普通文件，通过非交互 PowerShell 查询卷格式、`fsutil file queryFileNameById` 查询已打开对象的 ID，并核对对象身份。Windows 卷格式成功检测只保存在本次 `HostFileOperations` 实例，文件身份和路径每次重新检查，不缓存授权。UNC、其它卷、macOS 或缺少必要能力时返回 `ENOTSUP`，不降级到普通路径读取，也不请求提升系统权限。

WSL 固定脚本先打开文件并经 `/proc` 返回该对象的真实路径和元数据，收到调用方的字节上限后才读取同一描述符。调用方拒绝授权时 `close()` 关闭标准输入并等待进程退出；取消同样等待清理。读取或启动错误由 `openRead/readBytes` 报告，关闭操作保留原来的错误。对应回归见 [open-host-reader.test.ts](./__test__/open-host-reader.test.ts) 和 [open-wsl-reader.test.ts](./__test__/open-wsl-reader.test.ts)。

`scanDirectory(path, { maxEntries, signal })` 在枚举时限制结果，最多返回指定数量，另取一个子项判断 `truncated`。本机通过单项缓冲的 `opendir` 逐个读取并在成功、失败或取消时关闭句柄。WSL 使用固定 Bash 脚本，让 GNU `ls -1 -A -U --zero` 直接输出给 `head -z`；保留隐藏项和文件名中的换行、制表符，目录用末尾 `/` 标识，链接不跟随。此路径需要支持 `ls --zero` 的 GNU coreutils；旧版命令缺少选项时返回 `ENOTSUP`，会话服务将其转为 `file_not_supported`，不回退到全量枚举。脚本接受正常截断导致的 SIGPIPE，并保留生产者和消费者的其它错误。WSL 的管道与程序有固定大小的预读缓冲，但不会把整个目录收集到内存后再截断。

会话文件列表和递归查找使用这项能力，整个请求共享 4000 项应用层预算，返回的候选子项和截断探针都占预算，即便候选随后因权限被拒绝或被目录规则跳过。WSL 固定缓冲中的预读不计入应用层候选数量。排序只作用于扫描返回的集合；结果截断时不保证是全目录排序后的前几项。

## 状态放在哪里

单次调用保存输入、取消信号和执行结果；文件、进程及任务状态由注入的宿主接口或目标系统保存。

## 新代码与测试

与本目录职责一起修改的代码放在这里；跨分类的公共入口由上层目录组织。

测试位于 [`__test__/`](./__test__)；只覆盖下级分类的测试放在对应分类的 `__test__/`。

固定 WSL 文件脚本的本地测试通过[跨包测试帮助代码](../../../../tests/helpers/README.md)查找实际可用的 POSIX Shell，不依赖 Git 安装在固定盘符。

目录扫描的受控输出测试在执行固定脚本的同一个 Bash 进程内显式加载夹具，并覆盖直接启动和经过 POSIX Shell 转发两条路径；不依赖 `BASH_ENV` 是否被启动环境读取。测试仍检查输出字节数、截断标记和生产者提前停止。

`Read` 完成实际查询后，文件不存在、读取出错或不支持当前内容都返回 `isError: true` 与 `executionState: completed`，表示读取已经发生且结果明确，不表示读取成功。参数不合法、路径策略拒绝或执行前取消保留 `not_started`；这条规则不改变写入工具的未知结果处理。

## Read 的实际输入预算

`Read` 的文本入口仍先解析路径、检查读取权限和查询文件状态，再调用已有的 `readBytes(path, { maxBytes, signal })`。文本只摄入文件开头最多 1 MiB，另取 1 字节判断截断；`limit=1` 不会使超大文件被整读。`offset` 表示行号，每次仍从文件开头扫描，不跳过输入预算；目标行不在已扫描范围时明确返回预算不足，不宣称已经超过文件末尾。扫描不完整时总行数为未知，尾部半行仍按 2000 字符截断并标明不完整，也不提供越过已扫描范围的续读行号。UTF-8 在截断边界上尚未完整的最多 3 字节不输出；已摄入范围内真正非法的编码仍拒绝。文件查询、字节读取和读取后的取消检查都使用本次调用的信号。

完整摄入的文本保留原有全文原始字节 SHA-256 和 `hostFileFacts`；部分前缀不生成这类全文凭据。`info_only` 需要全文哈希，只处理不超过 8 MiB 的文件：先查大小，再以 8 MiB 加 1 字节探针有界读取，防止文件在查询后增长。超过上限明确拒绝且不返回任何前缀哈希，原有写入工具的快照与哈希复核规则不变。

已知图片扩展名使用独立的 20 MiB 上限，与模型提供方的 `DEFAULT_MAX_VISION_SOURCE_BYTES` 保持一致：先查大小，再最多摄入 20 MiB 加 1 字节。按签名识别的无扩展名图片，先做文本大小的有界探测，确认为图片后才允许一次图片大小的有界读取；整个工具调用最多摄入 21 MiB 加 2 字节。图片仍返回文件来源；模型提供方后续读取也会先检查打开对象的大小，并使用 20 MiB 加 1 字节的有界读取，文件后续增长不会触发无界摄入。

单次文本读取的时间和内存由 1 MiB 输入预算约束，不随文件总大小或 `offset` 增长；格式化输出仍有独立的 50 KB 上限。此改动不增加读流接口，也不改用 `openRead`，保留既有后端与平台的兼容范围。实际输入字节数、超长单行、偏移越界、UTF-8、取消、文件增长和全文哈希回归见 [read-budget.test.ts](./__test__/read-budget.test.ts)。
