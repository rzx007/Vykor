# 守护进程宿主管理

为桌面端和命令行提供系统服务、自启动与进程生命周期管理。

## 入口与流程

调用方通过 `@vykor/server/daemon-host` 访问系统服务与自启动控制器，后者读取偏好、检查现有进程，并安装、启停或等待进程退出。

Desktop 无窗口入口和 CLI 本机登记入口调用 `runRegisteredDaemon()`。进程先取得登记所有权，再打开会话库，最后发布地址和 token。进程退出前先关闭应用和监听器，再清理自己的登记。系统常驻进程遇到已有后台时等待所有权释放。CLI 显式停止前先通过带 token 的本机请求核对 PID。进程退出后，取得登记所有权才能清理原记录。

连接时，CLI 和 Desktop 用同一套规则决定是否启动系统服务。Windows 计划任务空闲且后台已退出时立即触发一次检查。Unix 服务已运行，或 Linux 的 systemd 正在启动服务时，客户端等待后台发布登记。需要改动启动项时，先取得控制锁，再核对设置和服务状态。

按需后台切换数据前用同一把控制锁挡住启停操作，并检查当前工作已经结束。后台记录切换 ID，关闭旧监听器，再在原进程内打开目标。目标就绪后提交选择、发布新地址并启动定时任务和渠道。恢复库必须在 SQLite 打开时存在。目标打开失败时用旧位置重新启动。

桌面宿主还可在启动服务前调用该入口导出的 `setHostResponseLocale()`，提供操作系统的首选显示语言。普通 Agent 和审批器共享这个进程级默认值；它不持久化为设置，也不改变用户明确指定的回复语言。

## 状态归属

自启动偏好与系统服务配置保存在各自配置位置，进程状态来自操作系统和守护进程登记信息。

基础数据目录下的 `daemon/registry.json` 存当前进程地址，`daemon/data-location.json` 存已提交的数据位置和最近一次切换结果。两份文件都用原子替换写入。启动过程读取已提交位置，切换中断后也从该位置打开数据。

## 主要文件

| 文件 | 主要接口或用途 |
| --- | --- |
| [auto-start-controller.ts](./auto-start-controller.ts) | `DaemonAutoStartSnapshot`、`DaemonAutoStartAction`、`DaemonAutoStartController`、`DaemonAutoStartControllerOptions` 等 |
| [index.ts](./index.ts) | 汇总本分类的公开接口 |
| [lifecycle.ts](./lifecycle.ts) | `daemonPidAlive`、`terminateDaemonProcess`、`forceKillDaemonProcess`、`waitForProcessExit` 和 `stopRegisteredDaemon` |
| [registered-daemon.ts](./registered-daemon.ts) | 本机登记入口、退出和进程内数据切换 |
| [registry-lease.ts](./registry-lease.ts) | 协调启动、启停和切换的控制锁，以及后台持有的登记所有权 |
| [data-location.ts](./data-location.ts) | 读写已提交的数据位置和最近的切换结果，校验恢复目标 |
| [system-service.ts](./system-service.ts) | `DaemonSystemServiceState`、`DaemonSystemServiceStatus`、`SystemCommandResult`、`DaemonServiceInvocation` 等 |

## 测试与维护

系统服务和进程控制放在这里；守护进程内部业务组装放在 daemon，保持本目录的公开入口。

测试放在本分类同层的 `__test__/`；覆盖多个子分类的测试放在共同上层的 `__test__/`。迁移文件时同步导入、公开入口、文档链接与旧引用清单。
