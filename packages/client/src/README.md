# Agent 生命周期客户端源码

通过 HTTP 连接已有 daemon，维护会话记录的本地视图。根入口为 [index.ts](./index.ts)，只导出生命周期 API、只读能力、核心类型及同步函数；本机服务管理从独立 `/service` 入口使用。

## 分类目录

| 目录 | 用途 |
| --- | --- |
| [configuration/](./configuration/README.md) | 会话运行配置整理与模式检查 |
| [protocol/](./protocol/README.md) | 健康、能力与协议检查 |
| [resources/](./resources/README.md) | 会话、权限、附件、任务、事件、工作区文件与只读运行能力 |
| [service/](./service/README.md) | Node 专用本机后台管理 |
| [state/](./state/README.md) | 快照、事件合并、断线恢复与等待 Run 结果 |
| [transport/](./transport/README.md) | HTTP/SSE 传输与协议握手 |
| [types/](./types/README.md) | 生命周期请求、响应和同步类型 |

## 调用与状态

`VykorClient` 只组装资源，第一次请求才握手；会话写入和执行都交给 daemon。`syncEvents` 先读快照再订阅事件，reducer 更新本地视图，选择函数返回可展示记录。`waitForRun` 复用该同步流程等待指定运行终态。

持久状态归 daemon；客户端保存同步视图、连接及取消信号，界面保存草稿和选择。产品命令、业务资源及业务类型位于 [私有应用客户端](../../application-client/README.md)，不进入公开根导出。

新增实现放对应分类，跨分类测试放本层 [`__test__/`](./__test__)，单分类测试放该分类的 `__test__/`。

公开边界测试对照 [API 清单](../../../scripts/client-public-api-contract.json) 检查根导出、资源入口及每个资源的公开成员。资源增加方法或公开属性必须显式更新清单；TypeScript 的 private、protected 和 `#private` 内部成员不属于公开清单。
