# Agent 运行环境调用链

> 状态：当前实现，最后核对：2026-10-01。

## 启动

```text
读取全局 settings.agentEnvironment
  ├─ native → LocalExecutionEnvironment
  └─ wsl    → 预检 wsl.exe 和默认发行版
               → Windows cwd 转 /mnt/<drive>/...
               → WslExecutionEnvironment

ExecutionEnvironmentHandle
  ├─ process  → Bash、command hook、MCP stdio、后台 Shell
  ├─ files    → Read/Write/Edit/Glob/Grep/LSP
  ├─ terminal → 用户终端、Agent Terminal
  └─ paths    → workspace、Skill file/root 路径转换
```

Native/WSL 是轻量适配器，没有共享容器、lease、引用计数、配置 hash 或 daemon 启动回收。

## Native

命令直接在宿主系统启动。用户集成终端使用设置中的宿主 Shell；Agent Shell 使用系统探测结果。SRT 启用时，宿主进程由 `srt` 包装，缺少运行依赖时按 `failIfUnavailable` 失败或降级。

## WSL

```text
Bash / argv
  → environment.paths.resolve()
  → wsl.exe --cd <POSIX cwd> --exec <argv>
  → 输出与退出码返回调用方
```

环境变量通过 `/usr/bin/env KEY=VALUE ...` 传递。文件工具通过同一个 WSL process executor 调用 Linux 基础命令，不能把 `/home/...` 交给 Windows `fs`。

用户终端和 Agent Terminal 都得到：

```text
command = wsl.exe
args    = --cd <execution cwd>
```

node-pty 负责输入、resize、Ctrl-C、EOF 和 terminate。WSL 终端忽略 PowerShell 等宿主 Shell 偏好，使用默认 Linux Shell。

自动转后台的命令把当前环境 process executor 交给 `DetachedProcessSupervisor`，不会在转后台后回到宿主执行。

## 项目外会话、Skill 与附件

项目外会话已有受管 cwd，Native 直接使用，WSL 转为 `/mnt/<drive>/...`。fork 和子 Agent 使用各自 session cwd，但读取同一份全局环境设置。

Skill 的发现和 Markdown 加载在宿主控制面完成；file/root 呈现使用环境 path resolver。附件保持 `attachment://<assetId>`，不向 Agent 暴露任意宿主路径。

## 失败规则

文件工具通过 [isFileNotFoundError](../packages/tools/src/file/operations.ts) 同时识别本地错误类与 `ENOENT` 错误码。打包后的模块可能持有不同的错误类副本，不能只靠 `instanceof` 判断。Write 对不存在的文件正常创建；Read 和补丁操作仍按各自规则报告缺失。权限错误不能当作文件不存在。

Shell 在启动前检查已知的 Shell 类型混用、嵌套 PowerShell `-Command` 双引号变量展开及 here-string 起始行错误，前台、自动转后台和直接后台入口共用检查。失败返回 `invalid_input/not_started`，不会启动进程。这是针对常见误用的检查，不是完整的 PowerShell 语法解析器。PowerShell 命令通常直接交给 Shell；here-string 的起始标记后必须换行，不需要再套一层 `powershell -Command`。

- 非 Windows 不能选择 WSL；
- WSL、默认发行版或盘符映射不可用时明确失败，不回退 Native；
- WSL Linux 文件系统 UNC 项目当前明确拒绝；
- WSL 与 SRT 同时启用当前明确拒绝；
- Permission 拒绝不因运行环境变化而绕过。
