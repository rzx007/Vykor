# 数据库迁移链

保存当前数据库基线、后续增量 SQL 和 Drizzle 生成的迁移元数据。

## 入口与流程

数据库打开时按 meta/_journal.json 中的顺序应用 SQL；Drizzle 使用上层 schema.ts 生成后续迁移，CLI 和 Desktop 打包时复制整个迁移目录。

## 状态归属

迁移源文件保存在仓库，已应用的迁移记录保存在目标数据库；meta 保存工具生成的结构快照。

结构定义位于 [schema.ts](../schema.ts)，应用入口位于 [数据库迁移模块](../../database/migrations.ts)。生成的 meta 目录与 SQL 一起维护。

## 测试与维护

追加迁移时同时更新 SQL 与生成元数据，并运行 db:check、数据库测试和打包基线检查。README 仅解释资源，不修改已有 SQL 或快照。
