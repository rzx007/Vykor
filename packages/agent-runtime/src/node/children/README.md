# 子 agent 本机管理

| 文件 | 用途 |
| --- | --- |
| `node-child-manager.ts` | `NodeChildManager`，把执行核心的子管理接到本机创建流程 |
| `child-agent-options.ts` | 从父配置推导子配置、回合上限和允许能力范围 |
| `child-environment.ts` | 申请和释放子工作目录，管理 Git 独立检出目录 |
| `__test__/` | 配置继承、子生命周期、目录清理和树隔离测试 |

收到创建请求后，本层先把 inherit 解析为父运行实际使用的 model/provider/effort，调用宿主现有模型校验，再申请工作目录并交给 agent 工厂。显式模型原样校验，错误不会触发默认模型替换。等待结果或关闭子实例时，执行核心调用约定的释放入口，本层按目录归属和清理策略处理实际目录。

普通子 Agent 不继承父 Agent 的输出合同。系统子 Agent 可由宿主单独传入本次 `outputContract`；本层只把它接到该子实例配置，仍关闭普通工具与集成。合同所需的内部 `SubmitResult` 由执行核心加入最终工具集合，核验函数不会进入可序列化的创建输入或事件。

子登记和额度保存在执行核心中，本层持有配置、目录管理器和创建回调。新增本机目录或继承规则放在这里，通用子状态放在 [kernel/children](../../kernel/children/README.md)。测试放在同层 `__test__/`。


## 共用执行核心（阶段 A）

NodeChildManager 保留当前调用轮的工具授权，并在 startChain 真正接纳前再次核对 expectedRunId。定点任务视图直接使用真实 handle 的 requests，不比较 result Promise 身份。

每轮模型准备会复查当前宿主目录与授权；冷恢复也重新校验。daemon 沿现有模型元数据接线注入 validateModelSelection，SDK 无目录并提供自有 client 时保留自定义模型能力。配置在 Node 解析，身份、许可与安全卸载仍由 Kernel 原管理器负责。
