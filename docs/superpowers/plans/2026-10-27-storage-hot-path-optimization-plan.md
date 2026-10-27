# 存储热路径优化与正文读取边界评估

> **For agentic workers:** 按本计划 Q1、Q2 逐批执行；采用 `subagent-driven-development` 或 `executing-plans` 技能，在每批实现后独立审查。复选项表示实施步骤，不表示当前已完成。

> 状态：Q1 已提交为 13d9f7cc；Q2 两轮性能未通过，已撤回生产改动，验证和独立审查完成，归档随本提交保存。分支保留待用户检查后集成。实施起点：最新 origin/main = c0bdb5dbfbda8a6e02be5fbfdc6e0c9ccd4191cc；归档数据基线：2ae6a425d72b70bc6229ac77c96ff350e7f91c3e；日期：2026-10-27。

**Goal:** 减少工具调用期间没有业务价值的正文复制、数组构造和全量投影，保留现有存储及安全语义。

**Architecture:** 完整记录继续由 `SessionState` 持有，Repository 从这份状态读取。先复用已有摘要接口，再在既有查询中先筛选、后生成返回对象；不增加缓存、派生索引、SQL 查询后端或正文存储层。

**Tech Stack:** TypeScript、Node、better-sqlite3 `^13.0.2`、Drizzle ORM `^0.45.2`、Vitest；不增加依赖。

**Spec:** 本文件的取舍、约束及验收条件；现行行为以[存储手册](../../session-runtime-storage-architecture.md)、[工具操作安全验收记录](../reviews/2026-10-26-s1-tool-operation-safety.md)及[旧 N4 证据复查](../reviews/2026-10-27-n4-evidence-audit.md)为准。

## 取舍：值得继续，但先做两批减法

最小选择是保留当前存储方式，只改“检查状态却复制整个结果”的调用。它不解决容量问题，但没有新增状态维护负担，建议先实施。

| 问题 | 判断 | 下一步 |
| --- | --- | --- |
| 全历史加载 | 成本真实；但再次分批读取仍会加载全部正文 | 本轮保留，不能删除 owner 接管重读；不重做旧 N4 |
| 正文常驻 | 是主要容量成本之一；解决它需要改变读取、写入和事件边界 | 暂不实施懒加载，单独列出启动条件与完整范围 |
| 每次工具调用的全量扫描和复制 | 有明确调用点，能在较小范围内减少无用工作 | 推荐 Q1、Q2；每批独立可交付，可单独退出 |

Q1 预计 1–2 个工程日；Q2 预计 2–4 个工程日，含回归和性能比较。完整正文按需读取预计涉及至少 12 类职责、20–35 个含测试文件，约 2–4 个工程周；这是规模估计，不是实施承诺。

本计划假设暂时接受完整历史常驻，目标是减少每次工具调用附带的工作。如果产品要求“不论历史多少都限制常驻内存”，这个前提不成立，Q1/Q2 不能替代独立的存储改造。

## 当前流程与新证据

```text
构造 SessionStore → SQLite 全表读取及 JSON 解码 → SessionState 完整记录
取得 owner       → 写锁内重新读取、合并临时会话 → 完整替换 SessionState
工具完成         → Operation / Attempt 结果 → Part → 含完整 Part 的持久事件
工具检查与读取   → Repository 从 SessionState 查找 → 摘要或授权后的正文
修改失败         → SQLite 回滚 + Journal 恢复被改记录和事件状态
```

### 本轮当前版本基准

使用现行 `storage-growth.bench.mjs`，Windows / Node `v24.18.1`，四组各三个新进程，顺序运行共 12/12 成功。本轮暂停了其他代理的重测试和构建，但没有控制整机调度、其他应用和磁盘缓存。

| 历史 Run / 每份正文 | 构造 ms | owner 重读 ms | 重读 GC 后 heap 增量 MiB | 当前会话候选查询 ms | 安全全投影 ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| 100 / 4 KiB | 30.95 | 20.34 | 2.25 | 0.0308 | 0.0172 |
| 1,000 / 4 KiB | 391.02 | 222.89 | 18.14 | 0.4185 | 0.3828 |
| 10,000 / 4 KiB | 3,124.26 | 2,654.04 | 176.94 | 10.6262 | 10.9057 |
| 10,000 / 0 | 1,725.98 | 1,495.04 | 59.02 | 7.9641 | 7.5929 |

数值是三个进程中位数。查询在每进程预热 10 次、测量 100 次，再聚合进程中位数。候选查询始终只返回当前会话 10 条，安全全投影则返回全部 N 条，二者不能共用“固定结果数量”的验收标准。

所有样本的构造和接管阶段，四表均一次 `.all()`，原始行数组为 N / N / N / 2N。10,000 Run 正文组的重读后 GC heap 比零正文组多 117.91 MiB；重读后未 GC 的 514.75 MiB 是单点采样，不能称为峰值。构造和接管两列各取中位数，其相加约 5.78 秒也不是完整 daemon 启动时间的实测中位数。

这批种子只含简短 `session.model.attempt.started` 事件。真实 `session.message.part.updated` 会保留完整 Part，包括正文，因此本基准不是生产常驻内存的上界；也没有测正文按需读取的延迟。worker 在同一进程先建库、写入再计时，文件缓存是热的，不包含模块导入、建库或桌面响应时间。

1,000 Run 构造的三个原始值为 432.17 / 391.02 / 163.55 ms，波动明显。不得把本轮与旧 Node `v24.10.0` 的 N4 表格相减评价收益，也不得据单轮 20% 差异作稳定性能承诺。

### 已随本计划保存的原件

- [聚合及 12 个完整原始样本](../reviews/2026-10-27-storage-optimization-baseline.json)，不是只有中位数；已逐项核对与 12 份独立 worker JSON 相同，故不重复保存同一数据。
- [执行身份和方法限制](../reviews/2026-10-27-storage-optimization-baseline-context.json)，包含源码提交、脚本 Git blob、Node、命令及时间。
- 聚合文件 SHA256：`463f36cf5fffc3d4ba303e3a94e06f551f397c66d68db2032d31ed9aefebfc6d`；上下文文件：`6e5961ced820d3d6baa0a882f2cd0a180d3535bb527ed886a8d77d7a5d853450`。
- `.gitattributes` 仅对这两份归档 JSON 禁用文本换行转换，保留原始文件字节；Git 内容和跨平台检出内容都应与上述 SHA256 一致，不手工格式化原件。
- 实际执行脚本 CRLF 字节 SHA256 为 `f43f16f969f7c6366081e7a54406b15ed8a2939d8db2d9a1168605431ab43c0f`，Git blob 为 `5370f3e0c6339994763a26256a3a5dd465e03764`。LF Git 内容 SHA 与换行关系见旧 N4 证据复查；本轮不改该脚本。

这些是 `2ae6a425` 当前加载器的新基线，不能补成已撤回的旧 N4 候选证据。

## 代码中可直接减少的成本

- `packages/server/src/application/session/execution/tool-operation-service.ts:77/:127` 只读取 `state`，却调用 `get()`；`store-state.ts:63` 的 clone 是 `JSON.parse(JSON.stringify(...))`，因此每次成功结算也会完整序列化、解析输入和结果。已有 `getSummary()` 足够。
- `packages/server/src/application/maintenance/cleanup-settings.ts:97` 对每个会话调用完整 `list()`，只是检查四种未结算状态。可以一次取得有限元数据，再判断目标会话 ID。
- `tool-operation-repository.ts:216` 先生成全部历史的安全投影；正常新危险调用最多在 Core 两个策略检查、Server authorize/dispatch 中检查四次。跨异步授权和派发窗口的复查有实际作用，不能删除。
- 同文件 `:100/:156/:223` 的逻辑调用查找、同会话派发保护和结果候选读取，以及 `execution-records/execution-repository.ts:16` 的 ensure，均可避免先构造完整中间数组再查找。
- `readResultText`、`getResultCandidate` 已按 ID 直接定位；`ToolResultReader` 已在授权与分页后读取正文。这些入口不需要新索引。

## 全局约束

- 保持同步 Repository、现有 HTTP/IPC 返回格式、完整审计、SQL 格式和外部 SDK 入口；产品命令、配置、环境变量、服务及依赖均增加 0 项。
- 保持 owner 接管重读、写入保护、失败不安装半份状态、memory 会话不落盘、事务内写后读及 Journal 回滚。
- 保留四个安全复查入口及 Repository 同会话保护；只读操作的结算失败仍可能阻塞后续危险操作。
- 结果候选先授权、再按授权后的集合分页、最后读取当前页正文；保留候选次序、越界错误和旧结果补读权限。
- 不共享可变正文对象，不把 Journal 改为浅复制，不删除历史或审计，不通过删字段假装记录没有正文。
- 不搬迁生产文件；测试在所属 `__test__/`，同步本域 README。Q2 预计涉及 12–14 个生产、测试、基准和说明文件，超过 8 个，按下面限定清单执行，不扩展到其他 Repository。

## Q1：复用已有摘要，移除检查状态时的正文复制

**交付：** 状态检查不再读取完整 Operation 或复制整个会话的工具结果。单独完成 Q1 后系统即可继续使用，Q2 可以不做。

**文件：**

- 修改 `packages/server/src/application/session/execution/tool-operation-service.ts`。
- 修改 `packages/server/src/application/maintenance/cleanup-settings.ts`。
- 修改各自 `__test__/tool-operation-service.test.ts`、`__test__/cleanup-settings.test.ts`。
- 同步各自目录的 `README.md`。

**接口：** 消费现有 `getSummary(operationId)` 和无参数 `listSafetyStates()`；不新增 Repository 接口。

- [x] 在真实 Service 测试夹具中加入成功结算、提交失败、迟到结算及人工核对场景；只读状态期间把完整 `get()` 设置为抛错，验证状态处理仍正确且不调用它。大正文取 1 MiB，保留正常完整结果读取测试。
- [x] 将异常处理和 `clearResolvedFailure` 的状态读取改为 `getSummary()`，保留每个 operation 独立解除失败保护的规则，不能因一次结算失败清空其他失败记录。
- [x] 为清理增加“禁止完整 list()”用例，覆盖根、子、孙会话，以及 `prepared/authorized/dispatching/unknown` 四种状态；preview 后新增未决操作时，execute 必须再次阻止删除。
- [x] 清理保护改为一次 `listSafetyStates()`，配合目标会话 ID Set 判断；不能用只包含 unknown/dispatching 的人工审查候选代替四状态检查。
- [x] 先运行新增用例确认旧实现失败，再做最小实现，运行本批回归与 Server 类型检查，更新 README，独立审查后单独提交。

实施证据见[Q1–Q2 记录](../reviews/2026-10-27-storage-hot-path/README.md)和[Q1 独立审查](../reviews/2026-10-27-storage-hot-path/q1-review.md)。Q1 的 RED 为 16 项预期失败；GREEN 为 Server 四文件 48 项，Server 类型、架构、退役 UI、文档和空白门禁均通过。

**验收：** 完整 get/list 的调用数为 0；所有原有保护和错误不变。该批消除不必要的正文复制，不承诺减少启动耗时、常驻内存或所有历史扫描。

## Q2：先筛选再投影，减少热路径临时分配

**选择：** 无缓存、无新索引。继续访问同一份 `SessionState`；仍需遍历 N 个历史键，复杂度仍为 O(N)，本批不宣称消除无关历史扫描。

**文件：**

- 修改 Services 的 `tool-operations/tool-operation-repository.ts`、`execution-records/execution-repository.ts`，同步两个 README。
- 修改 `tool-operations/__test__/tool-operation-repository.test.ts`；在 `execution-records/__test__/execution-repository.test.ts` 新增 ensure 的针对性回归。
- 修改 Server 的 `application/session/execution/tool-operation-service.ts`、`application/maintenance/cleanup-settings.ts` 及各自上述测试和 README。
- 新增 `packages/server/src/application/session/execution/__test__/tool-operation-hot-path.bench.mjs`；说明测量入口，不新增产品脚本命令。

**接口与明确算法：**

- 给既有 `listSafetyStates` 增加可选筛选对象，字段仅为 `states`（ToolOperationRecord 的状态数组）和 `includeOperationIds`（只读 ID Set）。无参数或空对象仍返回全部有限元数据；只提供一个字段则按它筛选，两个字段并存则按“状态匹配 **或** 额外 ID 匹配”保留。显式空状态数组与空 Set 均没有匹配，二者同时为空时返回空集合。
- 单次遍历自有键，先判断再生成投影。Server 危险操作检查传 `unknown/dispatching` 和 `unsettledFailures`，随后保留原有 kind、Run 状态、同根会话判断；额外失败 ID 即使是 read_only 或其他状态也必须进入后续判断。
- Q1 的清理保护改为传四种未结算状态；目标树过滤继续在原调用方处理，避免把树规则搬进 Services。
- `prepare` 的现有逻辑身份查找、`dispatch` 的同会话保护、`ExecutionRepository.ensure` 改为找到首个匹配即停止。原先的校验顺序、冲突错误、ticket 内容和返回记录复制不变。
- `listResultCandidates`、`listReviewCandidates` 使用单次遍历，先筛选再生成返回对象，不创建每个无关条目的空数组。仍保留原自有键枚举次序；采用 `for…in` 时显式 `Object.hasOwn`，不能混入继承键，也不按 UUID、时间或状态重新排序。

- [x] 增加先失败用例：大量 confirmed 历史不生成安全候选；unknown/dispatching 与额外失败 ID 按“或”合并、不重复、无遗漏；默认全局读取不变，空筛选语义明确。
- [x] 保留并运行安全集成回归：同根子/兄弟会话阻塞，无关根不误阻塞，Run 结束后的孤立派发，仍活动 Run 的结算提交失败，只读失败记录，逐个迟到回执解除保护，切换 owner 的迟到结果。
- [x] 覆盖同逻辑调用去重、generation 区分、首个 execution 身份冲突、memory 会话、同一 atomic 内新建后读取、事务失败回滚、树删除及 owner 重载。纯读取不引入需维护的新状态。
- [x] 结果候选用插入次序与 ID 次序不同的数据验证返回顺序；保留授权后分页、部分来源被拒绝、越界、跨会话引用、旧 Attempt 引用及只加载当前页正文的用例。
- [x] 新增真实 `ToolOperationService` 接口组成的本机模拟派发基准：基于现有测试夹具建立临时 SQLite、取得真实 lease，种入合法固定的完成历史；计时之外准备数据。不执行真实工具、模型或用户文件操作。
- [x] 基准分别记录候选查询、筛选后的安全查询，以及 prepare → authorization check → authorize → dispatch check → dispatch → settle 的本机模拟耗时。两个 policy check 加 authorize/dispatch 的 Server 重查均保留；禁止以旧的无参数全局投影耗时代替实际路径。
- [x] 候选查询使用独立临时数据库，固定当前会话 10 条完成结果；关闭该夹具后再建立模拟派发的临时数据库。不得让派发预热及正式循环追加的结果污染固定 10 条候选的查询，两个版本分别核对各场景初始与最终记录数量。
- [x] 基准包含无阻塞的完成历史，以及少量 unknown/dispatching、额外结算失败 ID 的场景；固定输入和输出断言，记录 warmup 10 次与正式 100 次产生的额外操作数量，不能把追加后的数量继续声称为初始历史数。
- [x] 同一个基准驱动分别在 Q1 基线和 Q2 候选运行，只依赖两版本共有的 Service 与 Repository 接口。候选查询直接调用既有 `listResultCandidates`；实际安全子查询在测试侧透明包装既有 `listSafetyStates`，原样转发 this、参数和返回值，记录耗时与返回数量，并在 finally 还原。筛选参数由各版本 Service 自然选择，驱动不直接调用 Q2 新增的筛选形式。先增加、固定驱动，再作基线/候选比较；驱动自身 SHA 必须一致。
- [x] 按下节门槛验收；通过才独立审查并提交 Q2。失败就撤回 Q2 的生产改动，保留 Q1、基准和原始结果，停止本轮，不顺势增加索引。

实施结论：Q2 候选功能回归通过（Server 49、Services 195），但正式 60 个进程的两轮收益不一致。第二轮候选查询增加 20.46%、模拟派发增加 57.99%；1,000 Run 正文组接管两轮分别增加 41.39% / 47.003 ms、98.49% / 132.180 ms，稳定超过退出门槛。已撤回四个生产文件和候选专属测试，保留 Q1、相同驱动、完整补丁与确切源码字节。回滚后 Server 48、Services 操作及补读 35、两个包类型和全部门禁通过；归档独立审查无实质发现。见[两轮完整对比](../reviews/2026-10-27-storage-hot-path/q2-performance.md)及[退出与归档审查](../reviews/2026-10-27-storage-hot-path/q2-review.md)。本轮至此停止，不增加索引或继续叠加优化。

**明确不选：** 会话 ID 派生索引需要创建、直接树删除、回滚和 owner 替换时维护，单个索引还不能同时解决同根安全与按 Run 查找。SQL 索引查询则天然缺少尚未 flush 和 memory 记录；再补合并层会形成另一套读取规则。本轮先减少没有业务价值的分配，不用这两类方案补偿收益不足。

## 测量和保留条件

以下是下一阶段提前拟定的工程退出条件，不是已达到的性能结果。

- Q1 以不复制正文的直接证据及行为一致为准，不为几个状态读取引入计时断言。
- Q2 在固定当前会话 10 条、10,000 条无关完成历史时，候选查询中位数目标至少下降 30%；本机模拟危险派发的中位数至少下降 10% 或 2 ms。两项均须满足，且相同最终候选与派发结果不变。记录进程内 p95，不允许中位数改善伴随 p95 超过 20% 的稳定倒退。
- 原全局安全查询输出 N 条，保留为诊断；它不承担常数时间目标。筛选后的返回对象数受实际未决状态和额外失败 ID 数量影响，遍历键数量仍为 N；不能把对象数量减少写成消除全量扫描。
- 基线/候选使用同 Node、同基准驱动、同种子、同重复次数。每组各三个新进程，先 baseline 后 candidate；第二轮反转顺序，每个阶段的两轮都保留并分别比较，不挑选样本，也不合并成更好看的中位数。两轮结论不一致即收益未确定，本轮不保留 Q2。
- 两个检出目录分别使用自身的工作区依赖，确认没有 workspace 链接指向另一版本的源文件；记录实际导入的 Server/Services 路径和源码身份，避免名义上换了提交、实际仍运行同一份实现。
- 用现行四组存储基准补查启动、接管与 GC 后驻留；其脚本不变。构造或接管同时增加超过 20% 和 10 ms，或 GC 后 heap 同时增加超过 10% 和 5 MiB，视为倒退；两轮相邻比较复核，稳定触发则退出。
- 新的模拟派发基准与现行存储基准工作量不同，分别记录。数据生成、模块导入和建库排除在计时外；临时数据库仅清理由自身创建且校验位于临时根下的目录。
- 保存确切脚本或可恢复的源码提交、候选补丁、Node/命令、两轮各进程 JSON、失败样本及验证日志。聚合包含完整原始样本时无需重复保存每个 worker；不能仅留在忽略目录。不得将新基准误称为旧 N4 的复验。

## 验证命令

Q1 从仓库根执行：

```powershell
pnpm --filter @vykor/server exec vitest run src/application/session/execution/__test__/tool-operation-service.test.ts src/application/session/execution/__test__/tool-operation-invocation.test.ts src/application/session/execution/__test__/tool-operation-review.test.ts src/application/maintenance/__test__/cleanup-settings.test.ts
pnpm --filter @vykor/server check-types
```

Q2 在上述范围外增加 Services 回归：

```powershell
pnpm --filter @vykor/services exec vitest run src/tool-operations/__test__/tool-operation-repository.test.ts src/execution-records/__test__/execution-repository.test.ts src/tool-results/__test__/tool-result-reader.test.ts src/conversations/__test__/record-rollback.test.ts src/conversations/__test__/conversation-transactions.test.ts src/session-runtime/__test__/temporary-chat-storage.test.ts src/session-runtime/__test__/store.test.ts
pnpm --filter @vykor/services check-types
pnpm --filter @vykor/server check-types
pnpm --filter @vykor/server exec node --expose-gc --import ../../apps/cli/node_modules/tsx/dist/loader.mjs src/application/session/execution/__test__/tool-operation-hot-path.bench.mjs
pnpm --filter @vykor/services exec node --expose-gc --import ../../apps/cli/node_modules/tsx/dist/loader.mjs src/database/persistence/__test__/storage-growth.bench.mjs
```

新增 execution 测试和热路径基准随 Q2 创建；这两个命令不是本次规划已经运行的结果。性能测量不得与测试、类型检查或全仓扫描并行。各批收尾运行 `node scripts/architecture-boundaries.mjs`、`pnpm check:retired-ui`、`pnpm check-docs`、`git diff --check`；不重复运行完整仓库测试。每批先失败用例、后最小改动、再独立审查，检查通过后单独提交；合并或推送按届时用户授权执行。

## 暂缓的正文按需读取项目

只有真实目标是限制常驻内存、历史增长已频繁造成可复现的启动/内存问题，或用户明确给出当前全集模式不能满足的预算时，才启动独立项目。当前约 5.78 秒与 177 MiB 的合成成本足以说明容量问题真实，尚不能直接决定跨模块读取模型或代表用户工作负载。

完整项目至少要同时覆盖：

1. 明确区分“尚未加载”和“确实不存在”，不能直接少填 SessionState 字段。元数据常驻、正文按明确引用同步读取是优先研究方向，不使用对象属性中的隐式 SQL getter。
2. Operation/Attempt 的完整回执比较、重复结果、迟到结果与人工核对；Part 的快照、复制、回退、流式尾部和检查点。
3. 含完整 Part 的历史事件、重放顺序与旧事件校验失败语义；不只处理四张大 JSON 表。
4. 正式记录、memory 会话、未提交读、事务回滚、删除、owner 重载失效，以及加载失败时保留旧状态。
5. Server 快照与工具结果授权：摘要不能意外恢复全部正文，未授权结果不得被提前读取。

该项目的最低收益要求建议为同规模接管后 GC heap 至少降低 40%，同时测 4 KiB 与单条 1 MiB 结果的读取延迟、真实带正文事件及未决操作；是否新增正文表和是否改变历史格式需另行设计。这里不是待执行的 Q3，也不授权 SQL 迁移、删审计、通用 LRU 或新存储服务。

## 已核对的外部实现与适用边界

- [OpenCode SessionStore](https://github.com/anomalyco/opencode/blob/5f8ee0f5074f99a8b5d5cafb94126f879a274b50/packages/core/src/session/store.ts#L106)：消息按会话、seq 游标和 limit 查询。可借鉴明确的会话读取边界，不能直接搬进当前以内存事务状态为准的 Repository。
- [LangGraph SqliteSaver](https://github.com/langchain-ai/langgraph/blob/858891aaa164ebdacf33b8f5e7f88b38b9132211/libs/checkpoint-sqlite/langgraph/checkpoint/sqlite/__init__.py#L196)：按 thread/checkpoint 定位后再反序列化，历史列表支持 before/limit。可借鉴元数据定位与内容读取分开，不采用其 Python 栈或照搬其并发能力。
- [Drizzle 选择字段与过滤](https://orm.drizzle.team/docs/select)、[SQLite JSON](https://www.sqlite.org/json1.html)：现有 SQL 能表达窄查询，但不能自动覆盖本项目 memory 和未提交状态；改用 JSONB 也不自动消除线性访问。因此这轮不引入自制查询引擎或改 JSON 格式。

Q1/Q2 的验收不依赖这些外部仓库的可用性，也不需要账号、API key 或第三方服务。
