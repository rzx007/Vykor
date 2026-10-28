# 终端应用适配

将终端宿主能力接到会话、项目和服务端错误处理。

## 入口与流程

`DaemonTerminalService` 校验请求范围并调用终端宿主，提供创建、列表、输入、输出和关闭等操作，返回统一结果或应用错误。

## 状态归属

终端进程与输出由终端宿主管理，服务持有宿主引用和必要的业务范围信息。

## 主要文件

| 文件 | 主要接口或用途 |
| --- | --- |
| [daemon-terminal-service.ts](./daemon-terminal-service.ts) | `ListDaemonTerminalsOptions`、`DaemonTerminalSessionScopeQueries`、`DaemonTerminalServiceOptions`、`DaemonTerminalService` 等 |
| [index.ts](./index.ts) | 汇总本分类的公开接口 |

## 测试与维护

终端应用接口与项目关联放在这里；底层终端实现由 terminal 相关包提供。

测试放在本分类同层的 `__test__/`；覆盖多个子分类的测试放在共同上层的 `__test__/`。迁移文件时同步导入、公开入口、文档链接与旧引用清单。


## 共用执行核心（阶段 A）

DaemonTerminalService 按实际 root / child 会话提供带环境核对的 TerminalProvider，交给共同 agent-terminal-host bundle 生成 Jobs；不另写 Jobs 状态或 wait/cancel。get 直接查询底层 provider；bundle 用同一判断核对所属会话和 agent 来源，读取、等待、输入、取消不依赖 list。
