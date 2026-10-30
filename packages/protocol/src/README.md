# 客户端与服务端的数据协议源码导航

把会话、审批、附件和扩展功能的数据定义分开，供两端共同引用。

## 主要文件

| 文件 | 主要导出 |
| --- | --- |
| [index.ts](./index.ts) | 统一导出本分类的类型与函数 |
| [workspace-changes.ts](./workspace-changes.ts) | 统一导出本分类的类型与函数 |

## 分类目录

| 目录 | 用途 |
| --- | --- |
| [attachments/](./attachments/README.md) | 定义附件引用以及办公文件交互数据。 |
| [channels/](./channels/README.md) | 定义渠道配置、投递与运行状态。 |
| [extensions/](./extensions/README.md) | 定义插件应用、市场、展示、历史记录和 MCP 授权数据。 |
| [files/](./files/README.md) | 转导出会话文件领域契约并检查 HTTP 响应。 |
| [knowledge/](./knowledge/README.md) | 定义跨端共享的笔记和记忆数据。 |
| [permissions/](./permissions/README.md) | 定义审批模式、审批结果及自动审查信息。 |
| [requests/](./requests/README.md) | 集中解析 HTTP 请求，并复用领域字段的检查规则。 |
| [runtime/](./runtime/README.md) | 定义能力握手、运行配置、任务、终端、调度和维护信息。 |
| [serialization/](./serialization/README.md) | 统一 JSON 数据检查、规范编码和协议序列化。 |
| [session/](./session/README.md) | 定义会话快照、输入、模型配置、目标及会话请求。 |

## 入口与处理步骤

主要入口或定义见 [index.ts](./index.ts)。

调用方通过包入口引用类型或校验函数，构造或检查请求、快照与事件，再交给实际的 HTTP 接入层和客户端状态处理。

## 状态放在哪里

这里只定义和校验传输数据；业务数据由 Services 保存，客户端展示状态由 Client 保存。

## 新代码与测试

根目录保留包入口和分类导航；具体实现放入对应分类。

测试位于 [`__test__/`](./__test__)；只覆盖下级分类的测试放在对应分类的 `__test__/`。
