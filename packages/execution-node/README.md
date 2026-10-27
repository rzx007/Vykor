# @vykor/execution-node

提供 Node 端后台非 PTY 进程、磁盘输出日志、Agent 框架子 Agent 的执行观察，以及当前的代码符号和 ripgrep 查询。交互 PTY 由 terminal-node 提供；子 Agent 的真实创建、取消和关闭由 Agent 框架负责。

## 目录导航

- [src/](src/README.md)：包公开导出和能力导航。
- [src/executions/](src/executions/README.md)：资源所有者、后台进程、子 Agent 观察及输出日志。
- [src/lsp/](src/lsp/README.md)：当前代码符号、引用查询实现与能力限制。

## 入口、流程与资源归属

包入口为 [src/index.ts](src/index.ts)。宿主创建 `ExecutionRuntimeOwner`，将同一实例传给需要共享资源的组装入口。相同 cwd/session 重复获取返回相同的 supervisor 或 registry；不同 owner 的句柄和输出文件相互隔离。

```ts
import { ExecutionRuntimeOwner } from "@vykor/execution-node";

const owner = new ExecutionRuntimeOwner();
try {
  const processes = owner.getDetachedProcessSupervisor({ cwd, sessionId });
  // 将 processes 交给后台 Shell/Jobs，将 owner.withLspClient 交给代码查询入口。
} finally {
  await owner.close();
}
```

`close` 立即拒绝新获取，等待创建中的进程、进程树停止、输出排空及活动代码查询；重复关闭返回同一个 Promise。`closeScope` 显式释放一个会话或工作目录，之后重新创建的资源使用新日志目录并保留旧日志。

独立 Node 根 Agent 创建和关闭私有 owner，子 Agent 复用它。daemon 创建共享 owner 并注入后台 Shell、Jobs、Dream、内存管理检查和默认 Node Agent；warm Agent 回收只释放 Agent 自身能力，daemon 关闭时关闭共享 owner。创建失败走同一清理路径。owner 负责资源集合，supervisor 负责真实进程，registry 负责框架执行的观察记录。

包只依赖 agent-contracts、host-config、environment 和 sandbox，不引用 services、core 或 agent-runtime；没有模块级默认 supervisor 或 registry。

## 新增代码与检查

后台执行和日志放 executions，代码查询放 lsp，保留这两个分类。单模块测试放所属目录的 `__test__/`，跨包执行行为使用仓库现有集成测试入口。

```bash
pnpm --filter @vykor/execution-node test
pnpm test:execution-integration
```

Workflow 的默认框架 worker 由 Agent Runtime 的 ChildManager 执行，不再把 child 等待结果包装为本包的进程 AwaitExecutionResult，也不在查询失败时改用进程后端。Shell 与显式进程仍由本包 supervisor 唯一持有。
