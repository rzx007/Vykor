# @vykor/server

把会话存储、Agent 执行、权限、项目、渠道和后台任务组装成应用服务，并通过 HTTP 或嵌入调用提供给桌面端与命令行。

## 目录导航

| 目录 | 职责 |
| --- | --- |
| [src/](./src/README.md) | 公开导出与完整分类导航 |
| [src/application/](./src/application/README.md) | 应用组装与各项业务服务 |
| [src/application/session/](./src/application/session/README.md) | 会话命令、输入、运行、插件、目标与记录处理 |
| [src/application/default-services/](./src/application/default-services/README.md) | 配置、模型、扩展、记忆与项目的默认服务 |
| [src/http/](./src/http/README.md) | HTTP 中间件、按资源划分的路由和返回数据转换 |
| [src/daemon/](./src/daemon/README.md) | 常驻服务启动、Agent 加载、渠道与定时任务 |
| [src/daemon-host/](./src/daemon-host/README.md) | 系统服务、自启动与进程管理 |
| [src/runtime/](./src/runtime/README.md) | 活跃运行协调、运行环境和密钥配置 |
| [src/permissions/](./src/permissions/README.md) | 权限请求、回复和配置检查 |
| [src/jobs/](./src/jobs/README.md) | 终端、子 Agent 与工作流的后台任务视图 |
| [src/terminal/](./src/terminal/README.md) | 终端应用接口与项目关联 |
| [src/commands/](./src/commands/README.md) | 内置、插件与技能的命令目录 |
| [src/session/](./src/session/README.md) | 会话记录导出、回退和文本处理 |
| [src/shared/](./src/shared/README.md) | 共用错误、日志、指标和费用估算 |
| [test-helpers/](./test-helpers/README.md) | 包内和跨包测试共用的 Agent 与宿主夹具 |

## 一次请求如何完成

1. 嵌入调用从应用服务进入；HTTP 请求先由协议解析器校验，再由路由调用对应应用服务。
2. 应用服务验证业务条件。会话变更通过 `SessionOperationRunner` 串行执行，并取得当前操作需要的使用许可。
3. 输入服务解析附件、技能与会话引用，运行服务检查准入和队列，再获取 Agent 执行。
4. 执行事件被转换为消息、部件和运行记录，写入 services 提供的存储。应用事件服务从已保存的事件向订阅者发布通知。
5. 普通调用直接返回结果；HTTP 路由通过 mappers 转换为协议响应，持续事件通过事件流返回。

会话、输入、权限、运行和消息事实由 services 管理；活跃 Agent、运行取消、操作队列和订阅由对应服务实例持有。关闭应用时按资源归属停止后台服务并释放实例。

## 公开入口

`@vykor/server` 通过 [src/index.ts](./src/index.ts) 提供应用工厂、HTTP 服务、守护进程和公开配置接口；`@vykor/server/daemon-host` 通过 [宿主管理入口](./src/daemon-host/index.ts) 提供系统服务和进程控制。包的公开路径保持稳定，跨包调用优先使用这两个入口。

## 测试与检查

测试位于所属分类同层的 `__test__/`；跨分类测试放在共同上层，跨包组合测试位于仓库的 `tests/`。共享夹具保留在 `test-helpers/`。

```bash
pnpm --filter @vykor/server test
pnpm --filter @vykor/server check-types
pnpm --filter @vykor/server exec vitest run src/application/session/execution/__test__
pnpm test:server-client
pnpm check-types:server-client
pnpm check:retired-ui
pnpm check-docs
```

新增模块按职责放入分类，更新对应 README；迁移文件时同步导入、公开入口、资源地址、文档和旧引用清单。

SDK 与 daemon 共用默认 Workflow child runner、按真实 run 的许可与停止屏障。daemon 通过既有模型目录校验端口在环境申请前及每轮实际配置准备时复查可用性；不新增 worker 生命周期表或自动重放。
