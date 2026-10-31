# 执行环境公共契约

定义所有执行环境共用的能力入口，并提供工作区绑定和 Shell 命令组装的轻量实现。

## 主要文件

- [index.ts](index.ts)：包公开导出。
- [types.ts](types.ts)：进程、终端、文件、路径与环境句柄接口及工作区绑定校验。
- [shell-descriptor.ts](shell-descriptor.ts)：Shell 描述、命令参数和结果元数据。

## 调用与状态

从 `@vykor/environment` 导入类型，调用 `createWorkspaceBinding`、`shellArgv`、`shellResultMetadata`。具体环境由 sandbox 等实现方创建。

`createWorkspaceBinding` 要求两个根路径非空；本机根路径须一致，WSL 执行根须为绝对 POSIX 路径。`shellArgv` 根据实际 Shell 描述组装 argv，为 Windows PowerShell 补 UTF-8 初始化；结果元数据函数记录 Shell 与退出状态。

本层没有全局运行状态或持久文件；工作区绑定和元数据是返回的新对象，进程、终端和文件资源由接口实现持有并释放。

`files.withMutationLock(paths, work, signal)` 是可选的文件修改协调能力。调用方先收集全部执行路径，再在回调中完成读取、规划、复核和实际写入或删除。实现必须在不同会话与文件操作实例间共享状态；等待可以取消，已开始的回调要等实际 I/O 结束才释放。文件工具对未提供此能力的自定义后端使用进程内独占保护。本层只定义契约，锁队列归 `execution-node`。

文件状态可包含 `sizeBytes` 与毫秒时间戳 `modifiedAt`。`EnvironmentFileSystem.readBytes` 接受可选的 `maxBytes` 和取消信号；实现方最多读取该字节数，省略上限时保持整文件读取。需要判断截断的调用方可请求上限再加一个字节。

`stat(path, signal)`、`listDir(path, signal)` 与 `paths.canonicalize(path, signal)` 接受可选取消信号，供请求在目录遍历和真实路径检查期间停止。

需要把授权与实际读取绑定时使用可选的 `files.openRead(path, signal)`。它返回已打开对象的 `canonicalPath`、`stat`、单次 `readBytes({maxBytes, signal})` 和幂等的 `close()`。调用方先按实际对象路径检查权限，再从同一个对象读取，并在 `finally` 等待关闭；实现不能重新按路径打开文件。不具备可靠对象识别能力时返回 `ENOTSUP`，调用方不得回退到普通 `readBytes`。句柄与进程归实现方持有，调用方负责关闭。

`files.scanDirectory(path, { maxEntries, signal })` 是可选的受限目录扫描能力，返回 `{ entries, truncated }`：最多保留 `maxEntries` 个子项，另取一个子项判断是否截断。目录项按文件系统顺序返回，链接不当作真实子目录。调用方只对这批结果排序，截断时不能保证拿到全目录排序后的前几项。旧环境可以暂不提供此方法；要求固定扫描预算的调用方应返回不支持，不能回退到整目录 `listDir`。具体实现可使用固定大小的系统缓冲预读，不能先收集全部目录项再截断。

## 新增代码与测试

同一职责的新代码放在本目录。测试放同层 [__test__/](__test__/)，跨分类场景放它们共同上层的 `__test__/`。
