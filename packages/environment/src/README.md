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

文件状态可包含 `sizeBytes` 与毫秒时间戳 `modifiedAt`。`EnvironmentFileSystem.readBytes` 接受可选的 `maxBytes` 和取消信号；实现方最多读取该字节数，省略上限时保持整文件读取。需要判断截断的调用方可请求上限再加一个字节。

`stat(path, signal)`、`listDir(path, signal)` 与 `paths.canonicalize(path, signal)` 接受可选取消信号，供请求在目录遍历和真实路径检查期间停止。

## 新增代码与测试

同一职责的新代码放在本目录。测试放同层 [__test__/](__test__/)，跨分类场景放它们共同上层的 `__test__/`。
