# 文件工具与基础操作

组织读写工具、文件基础操作、路径和内容处理。

## 主要文件

| 文件 | 主要导出 |
| --- | --- |
| [index.ts](./index.ts) | 统一导出本分类的类型与函数 |
| [operations.ts](./operations.ts) | `FileEntry`、`FileStat`、`GrepOptions` |
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

## 状态放在哪里

单次调用保存输入、取消信号和执行结果；文件、进程及任务状态由注入的宿主接口或目标系统保存。

## 新代码与测试

与本目录职责一起修改的代码放在这里；跨分类的公共入口由上层目录组织。

测试位于 [`__test__/`](./__test__)；只覆盖下级分类的测试放在对应分类的 `__test__/`。

固定 WSL 文件脚本的本地测试通过[跨包测试帮助代码](../../../../tests/helpers/README.md)查找实际可用的 POSIX Shell，不依赖 Git 安装在固定盘符。

`Read` 完成实际查询后，文件不存在、读取出错或不支持当前内容都返回 `isError: true` 与 `executionState: completed`，表示读取已经发生且结果明确，不表示读取成功。参数不合法、路径策略拒绝或执行前取消保留 `not_started`；这条规则不改变写入工具的未知结果处理。
