# 运行资源组装

| 文件 | 用途 |
| --- | --- |
| `default-runtime.ts` | `createVykorRuntime()`，应用配置和能力限制，组装查询引擎与工具 |
| `node-runtime-builder.ts` | `NodeRuntimeBuilder`，记录组装结果和资源归属 |
| `node-runtime-resources.ts` | `NodeRuntimeResources`，保存引擎、注册表、连接、运行能力和关闭入口 |
| `runtime-integrations.ts` | 接入 MCP、插件、技能等能力，处理连接来源与执行环境 |
| `cleanup-stack.ts` | 登记清理动作，在初始化失败或关闭时按顺序释放资源 |
| `__test__/` | 默认运行资源、接入、所有权、清理和运行事件适配测试 |

agent 组装层调用 `createVykorRuntime()`，构造器收集各项能力，返回带有查询引擎的资源对象。每次运行从这些资源中准备自己的能力范围，关闭时只释放当前对象拥有的资源。

组装工具权限时，`default-runtime.ts` 将执行环境的 `shellDescriptor.family` 交给 `PermissionChecker`，与前台和后台 Shell 实际使用的解释器保持一致。没有执行环境的旧调用路径复用默认 Shell 执行器所用的 `resolveHostShellLauncher()` 进程缓存。模型输入中的方言字段不参与判断；环境存在但缺少实际解释器描述时保持未知，不能回退猜测成宿主 Shell。`__test__/shell-permission-context.test.ts` 覆盖这些接线和后段拒绝规则。

状态集中保存在 `NodeRuntimeResources` 和清理栈中。新增资源组装与释放规则放在这里；agent 操作、子管理、模型配置、工具和记忆分别放在相邻分类。测试辅助的运行适配器留在同层 `__test__/`。

每轮读取实际请求配置后，default-runtime 调用宿主可选 validateModelSelection，复查当前模型目录与权限，再准备客户端与派发。目录容量元数据可保持创建快照，授权校验使用现有 settings/catalog reader 读取当前值，不把旧 root 配置当永久许可。

同一请求快照中的 `replyStyle`、`workStyle` 和自定义指令一起进入提示词构建。切换后下一次请求替换风格段，已有消息历史保持原样；不叠加旧风格。完整 `systemPrompt` 优先并原样交给模型，不暗中附加回复风格。`__test__/reply-style.test.ts` 使用真实组装与模拟模型接收端覆盖这条路径。

宿主提供 `resolveModelImageSupport` 时，每轮按实际选择的供应商、模型和 API 格式读取图片能力，随请求快照交给查询引擎。切换模型后的下一次请求因此会重新处理历史图片；未提供该查询的自定义客户端保留原有行为。
