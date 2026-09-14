# 架构重组迁移状态

> 状态：当前。阶段 0–1 已完成；阶段 2 尚未开始。

## 当前阶段

阶段 0–1 已完成：依赖护栏和 Session SQLite 数据库内核已经落地。

## 指标

- `scripts/architecture-baseline.json` 是旧入口调用的只减不增基线。
- `pnpm check:architecture` 检查禁止的 package 依赖方向，并比较当前生产代码调用数。
- 基线只能在调用数实际下降时通过 `node scripts/architecture-boundaries.mjs --write-baseline` 更新；禁止为了通过检查提高数字。

## 当前所有权

`SessionStore` 暂时仍拥有全部业务方法和公开兼容接口。SQLite 生命周期、read model、mutation buffer、event sequence 和 delta checkpoint 已迁入 `packages/services/src/database`，并由一个 `StorageContext` 持有。业务域 repository 尚未创建。

## 下一步

阶段 2 从低耦合的 project、schedule、workflow、channel、goal、attachment 和 permission 存储域开始。每个域单独制定计划并迁移测试、repository、调用方和兼容转发。
