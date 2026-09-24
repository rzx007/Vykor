# 归档：Vykor 后续计划（LegacyJSON / BackendHost 时代）

> ⚠️ **本文档已归档，禁止作为当前任务执行。**
>
> 正文描述的是三进程 TUI（CLI → frontend → `BackendHost` / LegacyJSON）时期的 P0–P5 backlog。该路径已从主线删除；`vk --tui` 现为 daemon attach：
> `frontend → @vykor/client → vk serve`。
>
> **当前权威计划以 [PLAN-REMAINING.md](PLAN-REMAINING.md) 为准。**
> 当前 TUI / 会话同步见 [docs/tui-flow.md](docs/tui-flow.md)、[docs/client-sync-flow.md](docs/client-sync-flow.md)、[docs/daemon-application-architecture.md](docs/daemon-application-architecture.md)。

## 历史状态（仅供追溯）

- TS Phase 1–14 骨架曾在 BackendHost 模型下跑通；其后 TUI 主路径迁到 daemon/client。
- 原 P0–P5（BackendHost 冒烟、LegacyJSON E2E、`swarm_status`、host 侧 AppState 等）不再适用。
- 仍有价值的体验项（Markdown、主题、AskUser modal、MCP OAuth、窄终端适配等）应按 daemon/client 语义重新立项，写入 PLAN-REMAINING 的 Phase E，而不是复活本文。
