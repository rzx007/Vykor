# N4 历史实验的证据复查

> 状态：限定范围证据记录。确认生产加载优化已回滚；历史候选原件未恢复，尚不能完整复核性能比较。当前实现见[存储手册](../../session-runtime-storage-architecture.md#历史增长基准与有界加载评估2026-10-27)。
> 日期：2026-10-27。核对提交：`31072ee8f7595eeb96aada4254bf8f531b127910`；实施前基线：`0a9bfb31fb4d4097ce74aa5214a10fe71e0fd873`。

本记录修正[实施计划](../plans/2026-10-27-next-architecture-simplification-plan.md)中“N4 原始证据已保留”的交付表述。N1–N3 与生产加载代码未在本次处理内修改；没有重建或重新运行历史候选。

## 源码和脚本身份

以下文件在上述两个提交中的 Git blob（Git 对文件内容的标识）完全相同，确认加载器、owner 接管和原有加载测试已恢复：

| 文件 | 两个提交共有的 Git blob |
| --- | --- |
| `packages/services/src/database/persistence/read-model.ts` | `ef98e3f52ba23dbaa7311ff8e5eaf1c21c1956a5` |
| `packages/services/src/database/persistence/sqlite-chat-persistence.ts` | `6ca2c50a8442bb1b49bde7a5450a824fb23b5c13` |
| `packages/services/src/database/persistence/__test__/read-model.test.ts` | `c09bbec40350cf5c62f996b2dea793e2b6ca8358` |
| `packages/services/src/session-runtime/store.ts` | `9ac6de9725dbbaf195df988361b95d64710c314b` |

可在仓库根复核：

```powershell
git diff --exit-code 0a9bfb31 31072ee8 -- packages/services/src/database/persistence/read-model.ts packages/services/src/database/persistence/sqlite-chat-persistence.ts packages/services/src/database/persistence/__test__/read-model.test.ts packages/services/src/session-runtime/store.ts
```

基准为 `packages/services/src/database/persistence/__test__/storage-growth.bench.mjs`；它在可达历史中首次加入于 `31072ee8`。

| 来源 | 脚本 SHA256 | 本轮状态 |
| --- | --- | --- |
| 原实施报告 | `469ba2ee93ffd8d3b41319e4264833dcdadcfd0255a4ab669b0280162341757b` | 对应原脚本未恢复 |
| `31072ee8` 的 Git 文件内容，LF 换行 | `3d2db8ea4d11e382f48f0a0c942bd1055e078292b661ebaec08c6a0741e9f5d0` | 已重新计算 |
| 本轮 Windows 工作副本，CRLF 换行 | `f43f16f969f7c6366081e7a54406b15ed8a2939d8db2d9a1168605431ab43c0f` | 与本轮样本内 `sha256` 相同 |

Windows 工作副本仅把 CRLF 转成 LF 后，与 Git 文件内容完全相同。两种换行的哈希均不等于历史值；不能把差异解释为只有换行不同，也不能把历史 SHA 直接替换成当前 SHA 后称实验已获认证。具体版本差异未查明。

## 原件找回范围和结果

未恢复的材料包括：历史脚本、候选补丁及候选测试、baseline/candidate 聚合与逐进程原始 JSON、RED/GREEN 验证日志。原报告给出的 `.superpowers/sdd/2026-10-27-next-architecture-simplification-plan` 目录未随仓库交付，复查时也不在当前工作区。

本轮只检查了当前仓库、可达 Git refs 和近期 reflog，以及以下明确相关位置的指定证据目录和相近命名记录；未遍历其他项目、依赖目录或整个用户目录：

- Codex 工作树根下的 `agent-daily-continuity/OpenHarness-ts`、`external-file-preview/OpenHarness-ts`、未注册的 `client-sdk-npm-release/OpenHarness-ts`。
- 项目本地 `.worktrees/s1-tool-operation-safety`。
- 系统临时目录根层名称包含 `storage-growth`、`storage-scale`、`task-4` 或 `next-architecture-simplification` 的材料。

临时目录仅找到了较早 `59cce87b` 基线的 `storage-scale.mjs`、`results-4096.json` 和 `results-0.json`。它们不是本次 N4 的原件，不能用于补证候选。上述结果只表示在已列范围内未恢复，不表示其他机器或未检查位置不存在副本。

## 可以核实的历史算术及其限制

[存储手册中的表格](../../session-runtime-storage-architecture.md#历史报告转录的进程数值)保留 `31072ee8` 原实施报告的数值与精度，不将转录表格伪装为原始 JSON。四组构造与接管中位数均能由表内三个数值复算。

1,000 Run 正文组 `76.036 → 94.529 ms` 为增加 `18.493 ms / 24.3214%`，符合原报告记录的“同时超过 20% 和 10 ms”退出条件。因此维持回滚与现存记录相符。

缺少原件时，不能独立认证候选确切实现、256 行统计、24 个原始进程、两轮脚本一致性、门槛事先设定或样本选择过程。候选的内存与耗时收益属于历史报告结果，不能称为本轮已复验。未 GC 采样不是严格峰值，当前源码仍持有完整正文并进行全量扫描。

## 本轮保存的当前加载器原始样本

原始输出为[当前加载器样本 JSON](./2026-10-27-n4-current-loader-smoke.json)，使用核对提交的现行脚本，Node `v24.18.1`，Windows，单个新进程。从仓库根执行的等价命令为：

```powershell
pnpm --filter @vykor/services exec node --expose-gc --import ../../apps/cli/node_modules/tsx/dist/loader.mjs src/database/persistence/__test__/storage-growth.bench.mjs --worker 100 4096
```

脚本创建并清理自己的临时数据库，种子和外键断言通过，退出码为 0。样本固定 100 Run、每份正文 4 KiB、当前会话 10 Run；数据库为 2,240,512 字节。构造与接管两个阶段均观察到四表原始集合为 100 / 100 / 100 / 200 行，各调用一次。候选查询和安全状态全投影各保留 100 次测量及进程内存采样。

该单样本只证明当前脚本可以运行并观测现行加载器，不是完整性能矩阵，不与旧 Node `v24.10.0` 的表格比较，也不能验证已撤回候选的收益。

## 后续取得原件时

将原脚本、基线及候选源码身份、候选补丁、逐进程 JSON 和验证日志存入 Git 跟踪的记录或持久附件，核对脚本哈希、数据规模、逐样本计算及回退条件后再更新历史验收状态。只重跑当前加载器、只更新文档哈希，或从计划重新实现一个相似候选，都不能代替旧实验原件。
