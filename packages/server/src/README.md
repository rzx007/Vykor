# 服务端入口

提供应用服务、HTTP 服务和守护进程的公开导出。

## 入口与流程

调用方从 `@vykor/server` 选择嵌入应用或启动 HTTP 服务；系统服务管理从 `@vykor/server/daemon-host` 接入。`index.ts` 汇总各分类的公开接口。

## 状态归属

入口文件只转发接口；会话和运行记录由 services 管理，运行中的资源由 application、runtime 和 daemon 持有。

## 主要文件

| 文件 | 主要接口或用途 |
| --- | --- |
| [index.ts](./index.ts) | 汇总本分类的公开接口 |

## 子目录

| 目录 | 用途 |
| --- | --- |
| [application/](./application/README.md) | 把会话、配置、项目、渠道和维护能力接到同一个应用对象。 |
| [commands/](./commands/README.md) | 定义内置斜杠命令，并与插件及技能提供的命令合并。 |
| [daemon/](./daemon/README.md) | 组装常驻服务，管理 Agent 加载、渠道连接、定时调度和服务登记。 |
| [daemon-host/](./daemon-host/README.md) | 为桌面端和命令行提供系统服务、自启动与进程生命周期管理。 |
| [http/](./http/README.md) | 把 HTTP 请求转换为应用调用，提供中间件、事件流与响应。 |
| [jobs/](./jobs/README.md) | 把终端、子 Agent 和工作流任务转换为统一后台任务视图。 |
| [permissions/](./permissions/README.md) | 处理权限请求等待、回复、作用范围，以及权限和隔离配置检查。 |
| [runtime/](./runtime/README.md) | 管理会话运行的活动资源，并提供运行环境和密钥配置接口。 |
| [session/](./session/README.md) | 提供会话文本筛选、导出和记录回退的通用函数。 |
| [shared/](./shared/README.md) | 提供应用错误、结构化日志、运行指标和用量估算。 |
| [terminal/](./terminal/README.md) | 将终端宿主能力接到会话、项目和服务端错误处理。 |

## 测试与维护

新增业务实现放入下列职责目录，确需跨包公开的接口再加入 `index.ts`。

测试放在本分类同层的 `__test__/`；覆盖多个子分类的测试放在共同上层的 `__test__/`。迁移文件时同步导入、公开入口、文档链接与旧引用清单。
