# 可用能力与运行目录

| 文件 | 用途 |
| --- | --- |
| `capability-resolution.ts` | 表达能力可用、关闭或不可用，应用覆盖值并生成可展示的快照 |
| `default-agent-capabilities.ts` | 解析默认能力与执行环境，连接调用方提供的覆盖值 |
| `node-run-catalogue.ts` | `NodeRunCatalogue`，登记每次运行固定的工具、技能、定义和插件选择范围 |

agent 组装时确定有哪些能力以及对应的释放责任，提交时将本次允许范围登记到运行目录。创建子 agent 或执行已捕获的工具时，按原运行记录核对归属与范围。

能力对象由调用方或组装层持有，运行快照保存在 `NodeRunCatalogue` 实例中。新增能力解析和归属记录放在这里，具体能力实现在各自分类或提供方包。测试放在同层 `__test__/`。


## 共用执行核心（阶段 A）

默认能力解析调用 createNodeJobBindings 一次绑定 child/process/terminal/workflow 来源。Terminal / Shell 覆盖只接收按实际 `{ sessionId, cwd }` 返回 provider / admission 端口的工厂；每个会话组装时调用一次，child 继承工厂而不继承父会话已绑定的端口。低层覆盖不会替换执行规则；SDK 和 daemon 使用相同来源实现。
