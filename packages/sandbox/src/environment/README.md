# 本机与 WSL 环境

建立 Native/WSL 的执行入口与路径绑定，探测系统和 SRT 是否可用。

## 主要文件

- [execution-environment.ts](execution-environment.ts)：环境工厂、进程适配、终端目标和路径接口。
- [wsl-environment.ts](wsl-environment.ts)：WSL 预检、Windows/WSL 路径转换和进程启动。
- [availability.ts](availability.ts)：检查运行器及平台依赖。
- [platform.ts](platform.ts)：识别主机平台及可支持的运行器。
- [types.ts](types.ts)：沙箱设置、策略、错误结果和事件类型。
- [errors.ts](errors.ts)：运行器不可用错误。

## 调用与状态

包根公开 `createExecutionEnvironment`、`preflightWsl`、WSL 路径函数、`getSandboxAvailability` / `getSrtAvailability` 及类型。宿主传入已解析配置、工作区绑定和环境变量。

工厂依次报告 preflight、probe、ready，WSL 分支先验证发行版并读取 home/shell，再建立进程和路径接口；local 分支解析实际 Shell 并连接 process 分类的创建函数。终端接口只准备目标，node-pty 由 terminal-node 创建。当前 files 接口会报未配置，需宿主接入文件实现。

环境句柄保存本次设置、路径绑定和系统事实；每个适配进程保存输出监听与退出 Promise。密钥只作为宿主传入的 env 合并到执行参数，不写入可展示的 info。

## 新增代码与测试

同一职责的新代码放在本目录。测试放同层 [__test__/](__test__/)，跨分类场景放它们共同上层的 `__test__/`。

固定 WSL 脚本的本地边界测试通过[跨包测试帮助代码](../../../../tests/helpers/README.md)查找实际可用的 POSIX Shell，Windows 上支持从 Git 的实际安装目录发现 Shell。

真实 WSL 取消测试使用 `/bin/bash` 的 `exec -a` 为长任务设置可检查的进程标记；测试先监听退出，触发取消前确认任务仍在运行。

带取消信号的 WSL 进程通过后台监督脚本启动。脚本先保存标准输入，再显式交给子进程，并关闭多余的文件描述符，保证交互式读取和文件写入仍能收到输入；取消继续终止整个进程组并清理标记文件。测试同时执行真实 POSIX Shell 脚本，并在 Ubuntu 可用时直接检查有、无监督脚本的 WSL 标准输入。
