# 架构重组迁移状态

> 状态：当前。阶段 0–1 和阶段 2A 已完成。

## 当前阶段

阶段 0–1 和阶段 2A 已完成：依赖护栏、Session SQLite 数据库内核和首个业务 Repository 已经落地。

## 指标

- `scripts/architecture-baseline.json` 是旧入口调用的只减不增基线。
- `pnpm check:architecture` 检查禁止的 package 依赖方向，并比较当前生产代码调用数。
- 基线只能在调用数实际下降时通过 `node scripts/architecture-boundaries.mjs --write-baseline` 更新；禁止为了通过检查提高数字。

## 当前所有权

`SessionStore` 暂时仍拥有多数业务方法和公开兼容接口。SQLite 生命周期、read model、mutation buffer、event sequence 和 delta checkpoint 已迁入 `packages/services/src/database`，并由一个 `StorageContext` 持有。

Project SQL、路径规则和写操作已迁入 `packages/services/src/projects`。`SessionStore` 保留八个兼容转发方法，Server 的 `ProjectApplicationService` 只依赖七个 Project 动作的窄 capability。`StorageContext.atomic()` 仍由 Store 的 transaction coordinator 临时提供，在 Store 退场前必须把该协调器迁入 database 内核。

## 下一步

阶段 2B 迁移 Schedule 存储域。后续依次处理 Workflow、Channel、Goal、Permission 和 Attachment；每个域单独制定计划并迁移测试、repository、调用方和兼容转发。
