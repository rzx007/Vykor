# @vykor/agent-contracts

执行双方共用的基础数据：消息、用量、模型失败与尝试身份、子 Agent 预算、Hook 事件/结果、权限判定和通用工具名规范。

不读取配置、不调用 Node，也不引用 core 或宿主实现。工具执行上下文及生命周期接口将在 P4 单独收敛。

```powershell
pnpm --filter @vykor/agent-contracts test
```
