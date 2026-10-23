# 共享客户端源码导航

通过 HTTP 与事件流访问 daemon，并维护客户端展示所需的会话状态。

## 主要文件

| 文件 | 主要导出 |
| --- | --- |
| [index.ts](./index.ts) | 统一导出本分类的类型与函数 |

## 分类目录

| 目录 | 用途 |
| --- | --- |
| [commands/](./commands/README.md) | 将会话、设置、诊断等界面操作组织成可复用命令。 |
| [configuration/](./configuration/README.md) | 处理客户端提交运行配置时使用的公共规则。 |
| [protocol/](./protocol/README.md) | 在传输层之上统一处理协议请求和公共数据格式。 |
| [resources/](./resources/README.md) | 按业务职责组织访问 daemon 的资源接口。 |
| [state/](./state/README.md) | 把服务端快照与持续事件合并成可展示、可查询的会话状态。 |
| [transport/](./transport/README.md) | 实现 HTTP 请求、协议握手和 SSE 事件连接。 |
| [types/](./types/README.md) | 集中定义附件、扩展能力和状态同步使用的客户端类型。 |

## 入口与处理步骤

主要入口或定义见 [index.ts](./index.ts)。

创建传输层和协议客户端，再构造资源接口；命令调用这些接口，状态模块结合快照和事件更新本地视图。

## 状态放在哪里

远端业务数据由 daemon 保存；连接、订阅和展示状态保存在客户端对象中。

## 新代码与测试

根目录保留包入口和分类导航；具体实现放入对应分类。

测试位于 [`__test__/`](./__test__)；只覆盖下级分类的测试放在对应分类的 `__test__/`。
