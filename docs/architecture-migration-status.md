# 架构重组状态

> 状态：当前。Stage 8 clean-slate 已完成代码收口；真实本机数据重置仍是独立、需逐项授权的操作。

## 当前入口

- Client 只通过 `client.protocol` 与各领域 Resource 调用 daemon。`OpenHarnessClient` 不提供顶层业务转发方法，也不暴露底层 transport 实例。
- Server 的 HTTP route 依赖 Query、Command、Interaction、Run Control 等窄服务。会话的串行、ready、owner lease 与事件 checkpoint/publish 由 `SessionOperationRunner` 保证。
- Services 的业务状态由 Repository 和 Transaction 持有。`SessionStore` 只负责数据库生命周期、owner lease、当前事件 waiter/listener、启动恢复和维护入口。
- Desktop Renderer 不读取数据库；持久状态来自 Client 的 snapshot 与 SSE。Desktop Main 只拥有 Electron、窗口、文件系统与 IPC 等平台能力。

## 当前协议与数据

- HTTP 协议固定为版本 4，请求头是 `x-openharness-protocol-version`。
- `/health` 和 `/capabilities` 是握手例外。Client 在第一个业务请求前完成精确版本握手，Server 在业务 handler 前拒绝缺失或不等于 4 的版本。
- 数据库只有 `packages/services/src/session-runtime/migrations/0000_current_schema.sql` 一份基线，journal 只有一条记录。
- 数据库启动只定义空目录建库和当前 schema 的幂等二次打开；不读取或转换旧数据库。

## 当前扩展

- 项目 Skill 目录只有 `.agents/skills` 与 `.openharness-ts/skills`；用户 Skill 默认位于 `~/.openharness-ts/skills`。
- Native Plugin 只接受严格 v1 manifest，安装 scope 只有 `user` 与 `managed`。外部插件格式先由 `@openharness/plugin-converters` 显式转换为当前 Native Plugin。
- OpenAI-compatible Provider、外部插件导入、平台 shell 选择、重试、取消、事务回滚和崩溃恢复都是当前产品能力，不是历史兼容层。

## Stage 8 结论

Stage 8A–8E 已按 [clean-slate 总计划](./superpowers/plans/2026-09-16-clean-slate-compatibility-removal.md) 完成：

1. 删除 Client 顶层旧入口与旧发行治理，保留 forbidden-surface 负向事实源。
2. 删除 Application/Store 纯转发，保留 Runner/Interaction 的真实编排与可靠性语义。
3. 清理 CLI、Desktop、Frontend 和底层包中的旧字段、scope、目录与 shell 回退。
4. 原子提升协议到版本 4，并把历史 migrations 压成单一当前基线。
5. 加入隔离空环境 smoke、安全清理测试和统一 `check:clean-slate` verifier。

旧 Stage 8A–8F 的兼容发行、双发行证据、删除授权和等待下一发行策略已经取消。旧计划正文仅作为决策历史保留，当前依据是 [clean-slate 设计](./superpowers/specs/2026-09-16-clean-slate-compatibility-removal-design.md) 与上述总计划。

## 持续门禁

- `pnpm check:architecture`：当前 Client contract、forbidden surface、包/模块依赖和 clean-slate 聚合检查。
- `pnpm check:clean-slate`：一次聚合 forbidden、Client contract、单 migration/journal、协议版本/header、发布 workflow 顺序和 bundle inventory；打印全部问题。
- `pnpm test:clean-slate`：smoke 安全边界、固定流程、失败清理与 verifier 失败 fixture。
- `pnpm check-docs`：当前文档路径和链接。

代码完成不代表本机数据已经删除。需要切换真实开发数据时，只能单独执行 [开发数据重置手册](./development-data-reset.md) 的预检、停进程、二次验证和逐项授权流程。
