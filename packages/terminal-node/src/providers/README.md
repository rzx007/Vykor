# 终端进程实现

解析终端目标并通过 node-pty 创建、读写、调整和关闭交互进程。

## 主要文件

- [local-terminal-provider.ts](local-terminal-provider.ts)：终端会话管理、事件、等待、取消与资源释放。
- [environment-terminal-target.ts](environment-terminal-target.ts)：生成本机执行目标。
- [shell.ts](shell.ts)：默认 Shell、命令参数与终端环境变量。

## 调用与状态

包根公开 `LocalTerminalProvider`、`createHostTerminalTarget` 和 Shell 辅助函数。创建 provider 必须提供 resolveCwd；environment 运行方式还需注入 resolveTarget。

create 校验 command/shellArgs、解析 cwd 和归属、准备目标并检查目录，然后启动 PTY。PTY 输出交给 output 分类，退出时更新快照并关闭目标。kill 设置停止状态并请求释放；dispose 拒绝新创建，等待创建中任务和所有会话资源释放。

provider 实例拥有 sessions Map、事件总线、创建中任务和关闭 Promise。每个会话拥有 PTY、目标、输出容器及取消标记；已完成或取消的快照保留至 provider 释放。

## 新增代码与测试

同一职责的新代码放在本目录。测试放同层 [__test__/](__test__/)，跨分类场景放它们共同上层的 `__test__/`。
