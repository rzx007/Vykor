# Daemon Slimming

> 状态：已完成。目标是在不削弱 durable/multi-client 能力的前提下，删除 daemon transport、application composition 与 Agent lifecycle 之间的职责交叉。

## 边界

```text
agent framework = execution + live state + events/callbacks/handles
daemon app      = durable session/task/run/transcript + policy + projection
HTTP transport  = auth + CORS + routes + listener + SSE connections
surface         = interaction and rendering
```

## 本轮

- [x] 新增 `daemon-agent.ts`，集中 durable session -> initialized Agent 翻译。
- [x] `AgentPool` 删除 settings、permission、event sink、history restore 与 Agent 创建配置职责。
- [x] 新增 `DaemonApplication`，集中 durable recovery、permission、projection、run、task 与四类 session services 装配。
- [x] `VykorHttpServer` 收缩为 transport，并把 resource services 合并为单个 `services` 对象。
- [x] 默认 resource services 由 `createDefaultApplicationServices()` 一次性安装，启动入口不再手工列举工厂。
- [x] 删除旧 server option 的散装 service 字段，不保留兼容入口。
- [x] 新增 daemon Agent loader 单测。
- [x] 完成全仓 typecheck/test 与最终复杂度复盘。

## 验证

- 30/30 packages TypeScript checks passed.
- server 159/159 tests、frontend 92/92 tests、services 119/119 tests passed in isolated package runs.
- 默认 `startVykorDaemon()` 已完成随机端口启动/关闭烟测。
- frontend real-daemon fixture 已从旧 `events.subscribe/effects.requestPermission` 迁移到 `onEvent/requestPermission/subscribe()`，真实 prompt -> permission -> SSE 流程通过。
- 全仓并行测试的本轮相关包通过；`packages/tools` 隔离后仍有 3 个既有 Windows/ripgrep 失败：`.gitignore` 匹配 1 个、临时目录 `EBUSY` 清理 2 个。本轮未修改 tools。

## 结果

- `VykorHttpServer`：只保留 transport、routes 与 SSE connection lifecycle。
- `DaemonApplication`：唯一 durable application composition root。
- `createDaemonAgentLoader()`：唯一 durable session -> initialized Agent 翻译点。
- `AgentPool`：只接受 `sessionId`，负责实例缓存、创建去重、代际关闭和 active-work 查询。

## 不做

- 不把 durable store、projection 或 multi-client policy 下沉到 framework。
- 不用新 adapter 包装 `VykorAgent`。
- 不为旧 `VykorServerOptions` service 字段保留兼容层。
- 不因文件行数拆分 projector；只有职责能独立闭环时才继续拆。

## 稳定性基线

- [x] 固化 framework / daemon / transport 生命周期契约与失败语义。
- [x] 增加 agent、daemon control、HTTP close 的多阶段故障矩阵。
- [x] 增加多 session、多轮 run、daemon 重启恢复 soak 回归。
- [x] 运行核心测试、全仓类型检查并复盘是否需要生产代码调整。

稳定性基线验证：

- agent-runtime：39/39 tests passed。
- server：162/162 tests passed（含 4 session、48 run、2 次重启 soak）。
- services：119/119 tests passed。
- 全仓：30/30 TypeScript checks passed。
- 全仓并行测试仍只有 `packages/tools` 的 3 个既有 Windows/ripgrep 失败：`.gitignore` 匹配 1 个、临时目录 `EBUSY` 清理 2 个；隔离复跑为 102/105。
