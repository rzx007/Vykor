# @vykor/environment

定义执行环境的通用接口：调用方如何执行程序、准备终端、访问文件和转换路径。它让上层可以使用同一套方法接入本机或 WSL。

## 目录导航

- [src/](src/README.md)：公开接口、工作区校验和 Shell 参数辅助函数。
- [src/__test__/](src/__test__/)：工作区绑定和 Shell 行为测试。

包入口为 [src/index.ts](src/index.ts)。`createWorkspaceBinding` 校验宿主路径和执行路径；`shellArgv` 按 ShellDescriptor 组装命令参数；`shellResultMetadata` 为结果补充实际 Shell 信息。其余主要导出是接口类型，如 `ExecutionEnvironmentHandle`、`EnvironmentProcessExecutor` 和 `EnvironmentTerminalFactory`。

宿主实现并提供 `ExecutionEnvironmentHandle`；使用方经 process 执行命令、经 terminal 准备目标、经 files 访问文件、经 paths 转换路径，结果通过方法返回值和进程输出监听返回。具体环境工厂在 sandbox，PTY 在 terminal-node，文件实现由实际接入的宿主提供。

本包不拥有进程或文件句柄，只校验输入、返回新对象并描述契约；真实状态与 release 的行为归各实现。新增跨环境共同接口和 Shell 辅助函数放 src，测试放 `src/__test__/`。如果未来需要按职责增加子分类，应同时补分类说明和本导航。

```bash
pnpm --filter @vykor/environment test
pnpm --filter @vykor/environment check-types
```
