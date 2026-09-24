# Native / WSL 智能体运行环境设计

> 状态：当前实现，最后核对：2026-09-08。

## 目标与边界

Vykor Desktop 不再使用 Docker 承载 Agent 工作负载。Agent、文件工具、后台 Shell 和集成终端统一运行在当前配置选择的环境中：默认使用宿主系统；Windows 用户可以改选 WSL。

运行环境与权限控制分开：

- `ExecutionEnvironment` 决定命令、文件和终端在哪里处理；
- permission / approval 决定哪些操作允许执行；
- SRT 是独立的本机隔离能力，本期保留；
- WSL 本身不称为安全沙箱。

本期只清理 Docker runtime，不删除 SRT，不为了改名拆分 `@vykor/sandbox`。

## 配置和生效时机

设置保存为：

```ts
agentEnvironment: {
  kind: "native" | "wsl"
}
```

不兼容旧 Docker 配置，不添加格式版本字段。内部执行环境继续使用 `local | wsl`，减少无收益的 `local` 改名；设置边界把 `native` 映射为 `local`。

这是设备级全局设置，不增加 session 表或项目字段。修改后重启 daemon 生效；同一 daemon 生命周期中的 root、fork、子 Agent 和终端使用同一份有效配置。

| 宿主系统 | 设置页选项 |
| --- | --- |
| Windows | Windows 原生、WSL |
| macOS | macOS 原生 |
| Linux | Linux 原生 |

macOS/Linux 不展示也不接受 WSL。Windows 保存 WSL 前执行预检；不可用时明确失败，不回退 Native。首期使用系统默认发行版，不管理发行版列表。

## 统一运行契约

Agent 核心只接收一个 `ExecutionEnvironmentHandle`，其中包含 execution cwd、路径风格、Shell/argv 进程、文件读写与搜索、终端 PTY 目标，以及 home/temp/Skill 的执行侧路径。

```text
ExecutionEnvironmentFactory
├── LocalExecutionEnvironment
└── WslExecutionEnvironment
```

Native/WSL 都是轻量适配器，不拥有容器实例。因此删除 Docker 引入的 environment manager、lease、identity、owner alias、引用计数和 config hash。每个消费者可以从同一配置和 cwd 创建等价句柄；`release()` 是轻量清理或空操作。

## WSL 路径范围

首期只支持宿主 Windows 盘符下的项目：

```text
D:\code\vk <-> /mnt/d/code/vk
C:\Users\name\.vykor\skills <-> /mnt/c/Users/name/.vykor/skills
```

转换统一由 WSL path resolver 负责。首期明确拒绝 `\\wsl.localhost\...` 和 `\\wsl$\...` 项目根目录，避免宿主 Git/worktree 对 Linux 文件系统的行为未定义。以后若支持 WSL Linux 文件系统项目，必须同时把 Git/worktree 操作迁入 WSL。

WSL 内部绝对路径（例如 `/home`、`/tmp`）不是 Docker 的“未挂载路径”。文件是否允许访问由 permission checker 判断，不能再用 `mountPurpose === "unmounted"` 拒绝。WSL 文件操作通过 WSL 进程执行，不能交给 Windows `fs` 直接解析 POSIX 路径。

## 进程、文件和后台任务

WSL 后端使用 `wsl.exe --exec` 启动 argv，使用发行版默认 POSIX shell执行命令。短命 Shell、MCP stdio、command hook、LSP 和自动转后台的命令必须使用同一个环境进程执行器。

`DetachedProcessSupervisor` 接收环境进程执行能力，不能在任务转后台后重新调用宿主 `createShellProcess()`。

WSL 文件系统实现 `stat/list/read/write/glob/grep`。实现可以调用 WSL 中的基础命令；`rg` 不存在时继续使用现有遍历与读取回退。二进制读写使用 base64 传输，路径和内容不得拼成未转义的 shell 文本。

SRT 本期只保持现有 Native 行为。若用户同时选择 WSL 和启用 SRT，启动环境时明确报“不支持该组合”，不静默绕过隔离设置。让 SRT 在 WSL 内运行属于后续独立工作。

## Shell 与终端

集成终端跟随当前有效运行环境：Native 使用用户选择的宿主 Shell；WSL 忽略宿主 Shell 偏好，在 WSL 中使用发行版默认 Shell。

Desktop 主进程不能在 WSL 请求中注入 PowerShell。协议中的 Docker 时代 `runtime: local | sandbox` 和 `explicitHost` 一并收敛为环境跟随语义。Agent Terminal 与用户终端都取得同一种 PTY target，但不共享容器或租约。

Native Agent 的系统 Shell fallback 使用操作系统默认 Shell；用户手动终端仍优先使用“集成终端 Shell”设置。两者不维护可执行文件清单。

## 工具可见性

所有工具声明统一认识 `local | wsl`：

- environment：Bash、文件工具、后台 Shell、command hook、MCP stdio、LSP、Agent Terminal，在当前环境执行；
- control plane：附件、远程 MCP、图片服务等继续由宿主控制面执行；
- Native Plugin Tool：在没有环境化进程契约前，WSL 首期不注册。

## Skill 与附件

Skill 发现和 `SKILL.md` 读取继续由宿主控制面完成。呈现给 WSL Agent 的 Skill root/file 经统一 path resolver 转为 `/mnt/c/...` 等执行路径，相关文件操作在 WSL 中执行。

附件继续保持 `attachment://<assetId>`：解析、授权和读取都在宿主控制面完成。当前流程不把附件宿主路径传给 Agent，因此本期不新增附件复制协议；增加一条 WSL 会话仍可读取 attachment URI 的回归测试即可。

## Docker 清理边界

WSL 主路径跑通后删除 Docker 设置、预检、环境变量、backend、Dockerfile、镜像、挂载、容器生命周期、复用、label、config hash、孤儿回收、manager/lease/identity/owner alias、Docker PTY、Docker file operations、sandbox session、Docker CLI 命令以及专用测试和文档。

保留 `@vykor/environment` 通用契约；保留 `@vykor/sandbox` 中的 SRT、policy、path-validator、host process helper；保留 permission/approval；保留 Dockerfile 文件预览等与 Agent Runtime 无关的普通产品能力。

最终使用依赖审计区分同名概念，不能用一次全局替换删除所有 `docker` 或 `sandbox` 字样。

## 验收

Native 和 WSL 分别验证命令输出、环境变量、退出码、带空格 cwd、文件读写、glob/grep、后台 Shell、MCP stdio、Agent Terminal、用户终端、Ctrl-C 和 resize。

没有 WSL 时测试明确 skip 或预检失败，绝不回退 Native。macOS/Linux 的平台测试确认不暴露 WSL。WSL Linux 文件系统项目首期返回明确的不支持错误。
