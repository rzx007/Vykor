# @vykor/execution-node

本地执行能力：后台非 PTY 进程、输出日志、framework 子 Agent 的执行观察，以及当前 LSP / ripgrep 代码查询。PTY 仍由 terminal-node 提供，真实子 Agent 的创建、取消和关闭仍由 Agent 框架负责。

宿主创建一个 `ExecutionRuntimeOwner`，把同一个实例传给需要共享资源的组装入口。相同 cwd/session 的重复获取返回同一个 supervisor 或 registry；不同 owner 的句柄和输出文件相互隔离。

```ts
import { ExecutionRuntimeOwner } from "@vykor/execution-node";

const owner = new ExecutionRuntimeOwner();
try {
  const processes = owner.getDetachedProcessSupervisor({ cwd, sessionId });
  // 把 processes 交给 Jobs 或后台 Shell，把 owner.withLspClient 交给 LSP 工厂。
} finally {
  await owner.close();
}
```

`close()` 立即拒绝新获取，等待尚在创建的进程、进程树停止、输出排空及活动 LSP 操作。重复关闭返回同一个 Promise。`closeScope(scope)` 由宿主显式释放某个会话或工作目录；释放后重新创建的资源使用新的日志目录，保留先前日志。

独立 Node 根 Agent 创建并关闭私有 owner，子 Agent 复用它。daemon 创建共享 owner，注入后台 Shell、Jobs、Dream、内存管理检查和默认 Node Agent；warm Agent 回收只释放 Agent 自身能力，daemon 关闭时才关闭共享 owner。创建失败走同一清理路径。

```powershell
pnpm --filter @vykor/execution-node test
pnpm test:execution-integration
```

包只依赖 agent-contracts、host-config、environment 和 sandbox，不引用 services、core 或 agent-runtime。没有模块级默认 supervisor 或 registry。
