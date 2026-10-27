# 跨包测试帮助代码

这里放多个包共同使用、只在测试运行时调用的帮助代码。

## 入口与处理步骤

- [posix-shell.ts](./posix-shell.ts) 的 `findPosixShell()` 为本地执行固定 WSL 脚本的测试寻找真实 POSIX Shell，也就是理解 `/bin/sh` 命令语法的程序。Windows 依次探测 PATH 中的 `sh.exe`、`git --exec-path` 对应安装目录下的 `bin/sh.exe`，以及 Program Files 中的 Git Shell；其他平台探测 `/bin/sh`。每个候选都实际执行 `exit 0`，只返回能够运行的程序。

## 状态与新增代码

帮助代码不保存跨测试状态，不安装或复制 Shell，也不修改生产环境配置。调用方负责在没有可用程序时标记系统依赖缺失，并保留实际脚本和断言。

跨包的测试帮助代码放在这里；只服务一个包的代码放在该包自己的测试目录或 `test-helpers/`。
