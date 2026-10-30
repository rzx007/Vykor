# 文件工具与基础操作

组织读写工具、文件基础操作、路径和内容处理。

## 主要文件

| 文件 | 主要导出 |
| --- | --- |
| [index.ts](./index.ts) | 统一导出本分类的类型与函数 |
| [operations.ts](./operations.ts) | `FileEntry`、`FileStat`、`GrepOptions` |
| [directory-scan.ts](./directory-scan.ts) | 本机增量目录读取、WSL 有界扫描脚本和结果解析 |
| [open-host-reader.ts](./open-host-reader.ts) | 本机已打开文件的对象识别、单次有界读取和关闭 |
| [open-wsl-reader.ts](./open-wsl-reader.ts) | WSL 保持文件描述符，先返回元数据、待授权后读取并等待退出 |
| [path.ts](./path.ts) | `resolveToolPath`、`normalizeToolPath` |
| [preview.ts](./preview.ts) | `FileChangePreview`、`computeFileChange` |
| [read.ts](./read.ts) | `DEFAULT_READ_LIMIT`、`MAX_READ_BYTES`、`MAX_READ_BYTES_LABEL` |
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
