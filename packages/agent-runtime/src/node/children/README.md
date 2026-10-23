# 子 agent 本机管理

| 文件 | 用途 |
| --- | --- |
| `node-child-manager.ts` | `NodeChildManager`，把执行核心的子管理接到本机创建流程 |
| `child-agent-options.ts` | 从父配置推导子配置、回合上限和允许能力范围 |
| `child-environment.ts` | 申请和释放子工作目录，管理 Git 独立检出目录 |
| `child-task-adapter.ts` | 把等待子任务的结果转换为执行接口需要的格式 |
| `__test__/` | 配置继承、子生命周期、目录清理和树隔离测试 |

收到创建请求后，本层基于父配置收紧子配置，申请工作目录，再交给 agent 工厂创建子实例。等待结果或关闭子实例时，执行核心调用约定的释放入口，本层按目录归属和清理策略处理实际目录。

子登记和额度保存在执行核心中，本层持有配置、目录管理器和创建回调。新增本机目录或继承规则放在这里，通用子状态放在 [kernel/children](../../kernel/children/README.md)。测试放在同层 `__test__/`。
