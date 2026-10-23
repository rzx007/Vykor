# @vykor/protocol

Vykor 客户端和服务端共同使用的数据格式。

这个包只包含 Session、Run、Message、Permission、Schedule、Job、Terminal、事件和运行配置的数据定义与纯函数。它不读取文件，不连接数据库，也不依赖 Node.js，可以被浏览器、IDE webview、TUI、Desktop 和服务端共同使用。

HTTP 接入层在调用应用前，也使用这里的解析函数检查 Session、Prompt、Permission 和 Schedule 请求。字段类型不对时会得到带稳定 `code` 的错误，例如 `invalid_request`，上层产品不需要依赖某一句报错文字来判断错误类别。

客户端收到 Session Snapshot、Event、Job 或 Terminal 数据后也会做实际检查。服务端即使返回了合法 JSON，只要里面的字段不符合协议，客户端就会报告 `invalid_protocol_data` 和具体字段路径，不会让错误数据继续进入 reducer 或界面。

## HTTP 协议版本

当前协议版本是 `4`，请求头是 `x-vykor-protocol-version`。

- `/health` 与 `/capabilities` 不要求协议头，供启动探测和握手使用。
- Client 在第一个业务请求前调用 `/capabilities`，版本不是 4 时不发送该业务请求。
- 握手成功后，每个 HTTP/SSE 业务请求仍携带版本头。
- Server 在进入业务 handler 前拒绝缺失、旧版或未来版本，避免产生数据库或进程副作用。

这里是精确匹配，不协商旧版本，也不降级能力。

## 目录与维护

| 目录 | 用途 |
| --- | --- |
| [src/](./src/README.md) | 把会话、审批、附件和扩展功能的数据定义分开，供两端共同引用。 |
| [src/attachments/](./src/attachments/README.md) | 定义附件引用以及办公文件交互数据。 |
| [src/channels/](./src/channels/README.md) | 定义渠道配置、投递与运行状态。 |
| [src/extensions/](./src/extensions/README.md) | 定义插件应用、市场、展示、历史记录和 MCP 授权数据。 |
| [src/knowledge/](./src/knowledge/README.md) | 定义跨端共享的笔记和记忆数据。 |
| [src/permissions/](./src/permissions/README.md) | 定义审批模式、审批结果及自动审查信息。 |
| [src/requests/](./src/requests/README.md) | 集中解析 HTTP 请求，并复用领域字段的检查规则。 |
| [src/runtime/](./src/runtime/README.md) | 定义能力握手、运行配置、任务、终端、调度和维护信息。 |
| [src/serialization/](./src/serialization/README.md) | 统一 JSON 数据检查、规范编码和协议序列化。 |
| [src/session/](./src/session/README.md) | 定义会话快照、输入、模型配置、目标及会话请求。 |

入口与流程：调用方通过包入口引用类型或校验函数，构造或检查请求、快照与事件，再交给实际的 HTTP 接入层和客户端状态处理。

状态归属：这里只定义和校验传输数据；业务数据由 Services 保存，客户端展示状态由 Client 保存。

新增实现优先放入职责对应的分类；测试放在被测目录的 `__test__/`。迁移时同步公开导出目标、调用方导入、文档和旧引用清单。

```powershell
pnpm --filter @vykor/protocol test
pnpm --filter @vykor/protocol check-types
```
