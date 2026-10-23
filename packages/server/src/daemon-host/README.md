# 守护进程宿主管理

为桌面端和命令行提供系统服务、自启动与进程生命周期管理。

## 入口与流程

调用方通过 `@vykor/server/daemon-host` 访问系统服务与自启动控制器，后者读取偏好、检查现有进程，并安装、启停或等待进程退出。

## 状态归属

自启动偏好与系统服务配置保存在各自配置位置，进程状态来自操作系统和守护进程登记信息。

## 主要文件

| 文件 | 主要接口或用途 |
| --- | --- |
| [auto-start-controller.ts](./auto-start-controller.ts) | `DaemonAutoStartSnapshot`、`DaemonAutoStartAction`、`DaemonAutoStartController`、`DaemonAutoStartControllerOptions` 等 |
| [index.ts](./index.ts) | 汇总本分类的公开接口 |
| [lifecycle.ts](./lifecycle.ts) | `daemonPidAlive`、`terminateDaemonProcess`、`forceKillDaemonProcess`、`waitForProcessExit` 等 |
| [system-service.ts](./system-service.ts) | `DaemonSystemServiceState`、`DaemonSystemServiceStatus`、`SystemCommandResult`、`DaemonServiceInvocation` 等 |

## 测试与维护

系统服务和进程控制放在这里；守护进程内部业务组装放在 daemon，保持本目录的公开入口。

测试放在本分类同层的 `__test__/`；覆盖多个子分类的测试放在共同上层的 `__test__/`。迁移文件时同步导入、公开入口、文档链接与旧引用清单。
