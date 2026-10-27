# 剩余复杂度评估与下一阶段计划

> 状态：N1–N3 已实施并分别通过验证和审查，最终整体审查发现的草稿保护缺口也已修复并通过定向复审；N4 已完成基准与候选实验，因耗时倒退回滚加载优化，仅保留基准和证据。历史审查基线：`59cce87b`；实际实施起点：`0a9bfb31`，包含计划提交 `6828af79`。日期：2026-10-27。实现验收后，用户另行授权拉取最新 main、复审、合并并推送；集成提交以 Git 历史为准。

## 取舍与结论

| 对象 | 判断 | 下一阶段接受的范围 | 暂不接受的范围 |
| --- | --- | --- | --- |
| 工具面板 | 值得优先处理，有两个实际关闭问题 | 收拢一次关闭请求，修复批量应用关闭和显式保留应用的选择状态 | 重建整个面板、通用标签插件框架、重新设计样式 |
| 大构造函数 | 保留唯一组装根，做小范围生命周期修补 | 同步构造失败时的 Store 回收；实时用量绑定由创建者释放 | 按行数拆工厂、引入依赖注入框架或万能 Context |
| 全历史加载 | 已有增长成本，值得有界优化 | 固化合成基准；分批读取大 JSON 表，减少临时原始行堆积 | 默认改成正文按需读取、删掉 owner 接管重读、同时建设多套索引 |

推荐按 N1 至 N4 独立交付。最小可行选择是只完成 N1、N2、N3，保留当前存储实现；这也能解决明确的操作问题和资源归属缺口。N4 是有独立性能验收的优化，不是前三批的前置条件。

本轮不是继续追求更小的文件。新增代码必须替代现有重复协调，或解决已证明的失败边界；不能仅把原代码搬到另一组需要一起理解的类中。四批合计会超过 8 个文件，必须分别验收和回滚。

前五批的完成结论继续有效，见[原计划及实施记录](./2026-10-26-architecture-complexity-review-plan.md)。以下面板问题位于前五批未改动的区域，是这次新增审查范围中的既有问题。

## 证据一：面板关闭有可复现的职责缺口

`apps/desktop/src/renderer/src/components/desktop/layout/main-layout/utility-panel/utility-panel.tsx` 同时保存普通标签、关闭确认、保存状态和多个异步操作。关键问题不是文件长度，而是一次关闭请求在不同处理阶段丢失了目标和选择信息。

1. `closeOtherTabs` / `closeTabsToRight` 在 816、826 行传入多个目标；`finishCloseTabs` 在 465 行只用 `find` 取出第一个应用，933 行也只关闭该应用。批量包含两个应用时，确认第一个之后，第二个仍打开，但后续确认目标已丢失。
2. 可见标签在 214–217 行由普通标签和外部应用组合而成。关闭其他普通标签并显式保留一个应用时，519–523 行只检查普通标签，清空当前标签 ID；227 行不会自动选择外部应用，于是原本应保留激活的应用内容被隐藏。

本轮使用真实 `UtilityPanel`、`PluginAppsProvider` 和已有 AppBridge 夹具执行了两个临时组件探针，两项均以预期的断言失败复现：保留应用的 frame 实际为 hidden；两个待关闭应用只发生一次关闭且确认框消失。退出码为 1，这是问题复现证据，不是测试通过。临时测试已删除，未修改产品代码。

现有测试已覆盖脏文件取消、丢弃、保存冲突，侧聊销毁、失败重试、切换会话和迟到结果；这些保护必须复用。`utility-panel-plugin-apps.test.tsx` 还明确要求：普通标签关闭后，不能自动激活后台应用。修复显式保留应用不能放宽这一规则。

## 证据二：构造函数应修资源交接，不应全面拆分

`packages/server/src/application/daemon-application.ts` 是当前约定的唯一组装根，已复用附件、运行、渠道等具名组装函数。里面的大量参数连接着真实的权限、工具来源、投影和关闭责任，继续按段落搬运未必减少理解成本。

值得处理的边界有两处：

- `packages/server/src/application/default-node-application.ts:23` 创建 Store 后直接构造 Application。同步构造抛错时，没有成功返回可关闭的 Application，也没有工厂的 Store 回收保护。`packages/server/src/http/server.ts:509` 的构造发生在启动 try 之前，不能靠其后续 `server.close()` 兜底。附件资源目录的同步 I/O 是一个实际可失败入口。这里已核实覆盖缺口，尚未执行故障注入，不能声称本轮实测到数据库连接泄漏。
- `daemon-application.ts:743` 绑定模块级实时用量组装函数，1122 行关闭时无条件清空；`context-usage-live-binder.ts:12` 没有记录绑定归属。绑定后的同步构造失败不会撤销它，旧实例释放也无法判断当前绑定是否仍属于自己。

异步 `ready()` 失败不同：调用者已经得到 Application，现有启动流程会关闭它，也已有恢复失败后关闭并重建的测试。本轮保留这条流程，不把它重新设计成另一套启动框架。

正常关闭顺序继续由 Application 明确控制：停止新 OAuth 操作 → 等启动恢复 → 停定时任务和渠道入站 → 排空执行 → 释放 OCR、终端、Workflow、执行宿主 → 清理附件及持久结算 → 关闭事件 → 停心跳、释放写入租约、按归属关闭 Store。单阶段失败仍要尝试后续阶段，不能机械按构造顺序倒序关闭。

## 证据三：历史规模成本已测量，但不能混称一种问题

基线 `59cce87b`，Windows / Node `v24.18.1`。每组使用三个全新 Node 进程，取中位数；查询在每个进程预热 10 次、测量 100 次。系统负载和磁盘缓存未严格控制，以下不是冷盘启动或用户体验承诺。

两个会话中，当前会话始终只有 10 个 Run，其余为无关历史。每 Run 固定 1 Input、2 Message、2 Part、1 模型 Attempt、1 Execution、1 已确认只读 Operation、1 DispatchAttempt、1 简短合法事件；工具正文分别存于 Part、Operation、DispatchAttempt。建库和批量写入不计入耗时，构造及 owner 接管重读分别计时，常驻内存在手动 GC 后采样。

| 历史 Run | 每份正文 | 数据库 MiB | 构造 ms | 接管重读 ms | GC 后 heap 增量 MiB | RSS 增量 MiB | 当前会话候选查询 ms | 安全状态全量投影 ms |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 100 | 4 KiB | 2.09 | 66.96 | 30.87 | 2.25 | 7.07 | 0.037 | 0.029 |
| 1,000 | 4 KiB | 15.95 | 149.63 | 113.46 | 17.79 | 61.65 | 0.233 | 0.176 |
| 10,000 | 4 KiB | 154.85 | 1,862.78 | 2,506.68 | 171.99 | 460.34 | 9.984 | 8.502 |
| 10,000 | 0 | 36.09 | 692.88 | 708.07 | 54.37 | 196.29 | 7.016 | 7.070 |

候选查询始终只返回当前会话 10 条。安全状态投影返回全部操作；它不是完整权限检查。正文组与零正文组的 heap 差约 117.61 MiB，说明正文驻留确有成本。重读后、手动 GC 前的 heap 增量采样约 538 MiB，不能称为严格峰值。

当前实现需要分开看：

- `packages/services/src/database/persistence/read-model.ts:30` 起使用整表 `.all()`，先构造原始 JSON 行集合，再解码进完整状态；加载中有临时数据堆积。
- 最终完整状态也持有正文。分批读取不会消除上述约 172 MiB 的常驻 heap。
- `packages/services/src/session-runtime/store.ts:221` 构造加载，404 行接管写入权后再次加载。后者防止遗漏旧 owner 在两次操作之间的新提交，必须保留。
- `tool-operation-repository.ts:216`、223 行仍扫描全部操作。元数据索引可以改善查询，但不会减少正文驻留，还要参与删除、回滚和 owner 重载。千次 Run 时查询约 0.2 ms，本轮不为此默认新增多套索引。
- 当前事务已使用 `TransactionJournal` 捕获实际修改记录，并非每次复制全部历史。现有 retention 也不删除消息正文或工具审计正文，不能作为解决驻留的开关。

本轮的合成脚本与原始样本保留在本机临时目录 `C:/Users/ruanz/AppData/Local/Temp/vykor-storage-scale-02d447df96204e17981a658cf9a74996/`，文件为 `storage-scale.mjs`、`results-4096.json`、`results-0.json`，共约 20 KiB。所有合成数据库已删除；未访问用户会话库或调用模型。该目录是本次取证附件，不是其他机器执行计划的前置依赖。

## N1：收拢面板关闭请求，修复两处行为

**收益优先，风险中等。** 复用现有确认框和业务能力，在面板目录新增 `use-utility-panel-close.ts`，集中保存一次关闭请求的目标 ID、显式保留目标、确认阶段、错误、忙碌和所属界面实例。单关、Ctrl+W、关闭其他、关闭右侧统一进入它，不新增后台关闭队列或自动重试。

状态归属保持：

```text
单关 / 关闭其他 / 关闭右侧 / 快捷键
  → 关闭请求 hook：当前请求、确认阶段、界面实例标记
  → 原有文件保存 / 侧聊销毁 / 应用关闭 / 终端命令
  → 成功部分提交到现有 runtime reducer
  → 现有 repository 保存普通面板状态

应用页面：继续由 page manager 持有
编辑草稿：继续由 draft store 持有
关闭请求：只保存 ID 和临时操作状态，不复制标签和草稿正文
```

给现有 `utilityPanelRuntimeReducer` 增加一次普通标签关闭动作，统一计算 tabs、browserTabs、fileTabs、当前文件和当前标签。显式保留的外部应用必须仍可选中；没有显式选择时，默认回退仍不能激活后台应用。reducer 保持纯状态计算，不能在其中保存文件、删除草稿、发终端命令或写本地存储。

实际副作用继续交给 `saveCodePreviewDraft`、`destroySideChat`、`manager.remove(id, true)` 和现有终端命令队列，不改 page manager、draft store、外层面板 controller 或服务端协议。

固定批量语义：

1. 文件确认及必要保存 → 侧聊确认及销毁 → 普通标签关闭 → 按原可见顺序逐个确认应用。
2. 文件保存失败不提交该批普通关闭；已写盘文件不回滚，其余标签和草稿保留。保存期间继续编辑的保护保持。
3. 侧聊销毁失败停在原步骤并允许重试。普通关闭已提交、侧聊已销毁或某应用已成功关闭，不尝试撤销。
4. 应用失败保留当前及剩余 ID，允许用户重试；取消结束请求，未处理标签和草稿保留。复用现有逐个确认，不新增批量确认样式。
5. 切换会话、项目、离开再返回或卸载使旧请求失效。迟到结果不得写新界面或继续下一项；已经发出的外部操作仍可能完成。
6. 请求处理中不叠加另一批关闭；每项副作用只派发一次。

**文件边界：** `utility-panel.tsx`、新关闭 hook、`use-utility-panel-runtime.ts`，现有 state/review-access/plugin-apps 三组面板测试，以及本目录 README 和 `UTILITY_PANEL.md`，目标不超过 8 个文件。先把两条临时探针整理成正式失败用例，再实现；原有侧聊与草稿保护回归继续运行。

**完成与止步：** 两处问题消失，混合脏文件、侧聊、两个应用的请求在失败、取消和换会话后保持上述语义。若需要改服务端关闭协议、页面生命周期或持久格式，缩回范围，不引入通用处理器注册表。

## N2：补齐同步工厂失败时的 Store 交接

**改动小，收益明确。** 在 `application/default-node-application.ts` 增加构造失败回收，继续同步返回 Application，不新增异步工厂。

归属规则固定为：工厂自行创建的 Store 在成功返回前一直由工厂负责，即使成功后的 `ownsStore` 被指定为 false，构造失败仍要回收尚未交出的 Store。外部提供的 Store 默认借用，不关闭；只有明确 `ownsStore:true` 时由本次创建承担失败回收。成功返回后完全沿用现有 `ownsStore` 关闭规则。

先用现有附件组装工厂注入同步失败，验证真实 `createDefaultNodeApplication` 路径。保留构造错误；回收也失败时用现有 `AggregateError` 同时保留两个错误。不要把 Store 关闭写进每个业务服务，不改正常关闭顺序，也不把“调用方没有拿到 handle”误当成异步 ready 失败。

**文件边界：** 默认工厂、在 `application/__test__/` 新增 `default-node-application.test.ts`、Application README、daemon 运行手册。测试覆盖自建 Store、外借默认、显式接管、构造与关闭双失败、正常成功后关闭一次。

**完成与止步：** 同步创建失败的 Store 有明确负责人，原错误不丢失，外借 Store 不被误关。完成后停止，不扩展为通用资源栈，不全面拆构造函数。

## N3：实时用量绑定由自身释放

**改动小，与 N2 可分别合并。** 在已有 `context-usage-live-binder.ts` 让绑定返回自身释放函数；Application 保存它，在正常 close 和绑定后的同步构造失败中调用。释放函数只在当前绑定仍属于自己时清除，重复释放无副作用。

绑定只使用一个模块内身份和一个释放闭包，不增加 Manager、注册表或第二份缓存。缓存和用量计算算法保持；这也不宣称新增支持多个完整 Application 并行运行。

**文件边界：** 现有 binder、`daemon-application.ts`、在 context-usage 的 `__test__/` 新增 `context-usage-live-binder.test.ts`，必要的 Application 故障回归，以及本域 README。

**验收：** A 绑定 → B 绑定 → A 释放，B 仍有效；当前绑定释放后不可再取得；同一回调再次绑定也有独立归属；绑定后的构造失败不留下失败实例；原来的 ready 失败及正常关闭测试继续通过。

## N4：有界加载，减少临时数据堆积

**收益有边界，风险中等。** 固化本次合成数据与独立进程测量方法，基准放在现有 `database/persistence/__test__/`，文件名为 `storage-growth.bench.mjs`。它使用临时数据库、原有 Node/tsx 和当前迁移，不新增产品命令、依赖或用户配置。默认依次执行 100、1,000、10,000 Run 的 4 KiB 正文组，以及 10,000 Run 的零正文控制组，各用三个新进程。

只改变 executions、toolOperations、toolDispatchAttempts、sessionMessageParts 四张大 JSON 表的加载方式：用 Drizzle 的 select/where/orderBy/limit 读取固定内部批次，逐批解码到同一份局部完整状态。内部批次大小使用固定常量，不暴露用户配置。

保留当前候选分页次序是硬要求，不能直接按随机 UUID 排序。当前 SQLite 普通表都有 rowid，项目已有通过 Drizzle 静态 rowid 表达式排序的用法；本批对这四表使用内部 rowid 键集游标保持表扫描顺序，不使用 OFFSET、不把 rowid 作为业务身份或写入记录。首批没有游标时不加下界，之后才读取严格大于上一批最后 rowid 的记录，不假定 rowid 从正数开始。输入附件原有 `(inputId, seq)` 次序和事件 `seq` 次序保持现有实现，不顺带重排其他表。

分页需要一致读取：首次构造没有 owner 写锁，必须复用现有同步 SQLite 读事务，在一个一致快照中完成整个加载；owner 接管已有事务时复用，不建立独立提交。所有数据解码和旧事件校验成功后才交回并安装状态；失败保留当前状态或按既有构造失败路径关闭数据库。

保持同步 `load()`、构造加载、接管重读、临时会话合并和写入保护。已安装的完整状态仍为唯一负责人；不能为了减峰值把数据先后安装进共享状态。

**文件边界：** `read-model.ts`、必要的 `sqlite-chat-persistence.ts` 事务边界、read-model 与 owner/结果分页回归、本域 README 和存储手册，加合成基准；以一个独立批次交付。当前 Drizzle 的 BetterSQLite 接口没有 `iterate()`，不采用不存在的直接替换。

**验收：** 跨批次、稀疏 ID、非正 rowid、插入顺序与 ID 顺序不同、owner 接管期间旧进程提交、解析失败、memory 会话、结果补读及分页均正确。同一合成方法比较构造/接管耗时、GC 后 heap 和重读后未 GC 采样，不只比较一个数字。

现有加载后采样不足以证明加载中临时堆积下降。必须在测试或基准侧包装实际查询，记录每次原始结果集合的最大行数，证明四表的单次原始集合受批次大小约束；可补加载中 heap 采样与基线对比，不向生产接口添加观测 hook。不能把最大批次数或采样高点改称整个进程的严格内存峰值。只有直接证据成立且耗时无明显倒退时保留加载优化，否则独立回滚该实现，只保留基准证据。

**明确限制：** 这不是正文懒加载，不会消除约 172 MiB 的最终驻留，也不能把一个未 GC 采样点当严格峰值。owner 重读期间为失败恢复保留旧状态的要求不变。若目标是显著降低常驻正文，需另立存储项目，覆盖 Part、Operation、Attempt、未提交读、回滚、owner 失效、memory 会话和旧记录读取；不能靠删审计或放宽结果授权达成。

## 验证与实施约束

N1 的代码检查和回归从仓库根执行：

```powershell
pnpm --filter @vykor/desktop exec vitest run src/renderer/src/components/desktop/layout/main-layout/utility-panel/__test__ src/renderer/src/components/desktop/tools/side-chat/__test__/side-chat-panel.test.tsx
pnpm --filter @vykor/desktop typecheck:web
```

草稿保存的已有测试按受影响模块选择，不搭预览或截图。N2、N3 运行新故障用例与现有生命周期回归：

```powershell
pnpm --filter @vykor/server exec vitest run src/application/__test__/default-node-application.test.ts src/application/context-usage/__test__/context-usage-live-binder.test.ts src/application/__test__/durable-agent-application.test.ts src/application/recovery/__test__/startup-recovery-service.test.ts src/application/control/__test__/daemon-control-service.test.ts src/http/__test__/application-channel-assembly.test.ts
pnpm --filter @vykor/server check-types
```

以上两个新增测试按所属批次创建，单独实施时只运行当批存在的文件，不要求等待另一个批次。N4 选择：

```powershell
pnpm --filter @vykor/services exec vitest run src/database/persistence/__test__/read-model.test.ts src/tool-operations/__test__/tool-operation-repository.test.ts src/tool-results/__test__/tool-result-reader.test.ts src/session-runtime/__test__/temporary-chat-storage.test.ts src/session-runtime/__test__/store.test.ts
pnpm --filter @vykor/services check-types
```

N4 创建上述基准后，从仓库根运行以下命令；pnpm 会将工作目录切到 Services，tsx 加载器复用现有 CLI 依赖：

```powershell
pnpm --filter @vykor/services exec node --expose-gc --import ../../apps/cli/node_modules/tsx/dist/loader.mjs src/database/persistence/__test__/storage-growth.bench.mjs
```

基准用同一 Node 版本、相同数据及重复次数单独执行，不与其他大测试并行。每批收尾运行 `node scripts/architecture-boundaries.mjs`、`pnpm check:retired-ui`、`pnpm check-docs`、`git diff --check`。涉及文件迁移时同步导入、公开入口、README、手册和精确历史引用；按风险选择增量验证，不在每批重复跑完整仓库测试。

本阶段保持 HTTP/IPC、数据库格式和外部 SDK 入口，无新服务、账号、凭据或依赖。N1 不迁移面板存储；N2/N3 不改变同步工厂或正常关闭顺序；N4 不做 SQL 迁移或自动删除历史。各批回滚只撤销代码，不回滚已经执行的用户文件保存、应用关闭或侧聊删除。

计划假设继续保留完整审计、临时会话与同步 Repository 接口；如果产品目标改为严格限制常驻内存，N4 不足以满足，必须另做正文读取边界设计。当前不把这个后续项目混入“小幅简化”。

## 实施记录（2026-10-27）

执行工作区为独立的 `codex/next-architecture-simplification` 分支，起点与执行开始时的 `origin/main` 一致，均为 `0a9bfb31`。原检出目录中其他任务的未跟踪 `plugins/` 保持原状。没有以历史审查基线回退代码，没有搭建桌面预览或截图。实现验收阶段未提交或推送，后续集成按用户的单独授权执行。

- **N1：保留。** 两项正式组件失败用例先复现批量应用只关闭首个、显式保留应用被隐藏的问题。关闭请求现由一个 hook 持有目标、阶段和界面身份，普通标签通过纯 reducer 动作一次计算状态，复用原有保存、侧聊销毁、应用关闭和终端命令。独立审查又发现多文件保存及等待侧聊期间重新编辑的窗口；补充四项失败用例后修复，该阶段面板与侧聊回归共 140 项通过。最终整体审查进一步发现初始干净文件在侧聊阶段才开始编辑或保存的路径，以及确认销毁前的复查缺口；再补六项真实组件失败用例，只让明确丢弃免复查，并在销毁前检查文件，最终 146 项通过。renderer 类型检查及最后定向复审通过，无遗留问题。
- **N2：保留。** 同步工厂负责尚未交出的自建 Store；外借默认不回收，明确接管才回收，双失败保留两个原错误。通过真实工厂和 SQLite 验证，工厂及既有生命周期回归共 39 项通过。新增合法的组装根 `Store.close()` 曾触发原平铺调用计数；门禁现仅识别两个精确组装根的生命周期关闭，其他业务调用仍计数。旧基线中同类关闭同步剔除，限额从 104 降为 103，未提高限额或增加业务调用余量；门禁行为测试 61 项通过。server 类型检查与独立审查通过。
- **N3：保留。** 每次绑定创建独立身份并返回自身释放闭包，Application 在原关闭位置及已有同步构造 catch 中调用。没有绑定栈、注册表或第二份缓存。同一回调重复绑定、旧绑定释放、构造失败、正常关闭和借用 Store 的真实路径均有回归，连同 N2 及既有生命周期共 47 项通过；server 类型检查及独立审查通过。历史引用清单仅同步了两个原条目的行号。
- **N4：回滚优化，保留基准。** 候选仅对指定四表使用 256 行 rowid 键集批次，并把完整加载置于同一同步 SQLite 快照中；功能失败用例、候选回归和类型检查通过后，单独运行完整对比。原始查询集合上界改善成立，但部分组的耗时明显增加，因此按本计划的退出条件恢复加载代码及测试到 N4 开始前的版本。候选补丁、RED/GREEN 日志及逐进程数据保留在本计划的忽略目录，最终产品仍使用原加载方式，没有宣称改善生产内存峰值。

### N4 实际性能验收

可复现脚本为 `packages/services/src/database/persistence/__test__/storage-growth.bench.mjs`，运行命令见上文。基线与候选均使用 Windows / Node `v24.10.0`、同一脚本 SHA-256 `469ba2ee93ffd8d3b41319e4264833dcdadcfd0255a4ab669b0280162341757b`、同一合成方法；每组各三个顺序执行的新进程，共 24 个进程，未与重测试并行。数值取中位数，建库不计时；内存增量先在每个进程减去自身加载前采样，再取中位数。完整指标及限制另见[存储手册](../../session-runtime-storage-architecture.md)。

| Run / 每份正文 | 构造 ms（基线 → 候选） | owner 接管重读 ms（基线 → 候选） |
| --- | ---: | ---: |
| 100 / 4 KiB | 16.838 → 17.723 | 10.545 → 11.375 |
| 1,000 / 4 KiB | 76.036 → 94.529 | 67.457 → 72.919 |
| 10,000 / 4 KiB | 745.167 → 695.088 | 638.305 → 640.013 |
| 10,000 / 0 | 428.881 → 488.631 | 370.750 → 442.956 |

在实际 SQLite `.all()` 返回处观测四表原始集合，10,000 Run 组从每次 10,000 / 10,000 / 10,000 / 20,000 行变为每次最多 256 行；构造和接管均如此。10,000 Run 正文组重读后未 GC 的 heap 增量从 538,962,192 降为 377,211,616 字节，但 GC 后从 185,505,792 到 185,146,024 字节，最终正文驻留基本不变。集合上界与未 GC 采样均不能称为整个进程的严格内存峰值。

候选执行前选定的保守判断线是单组构造或接管中位数同时增加超过 20% 和 10 ms。1,000 Run 正文组构造增加 24.32% / 18.493 ms，达到回滚条件；零正文组接管另增加约 72.206 ms。没有改门槛、追加挑选样本或以大组单项改善替代整体验收。结论为**不保留本次加载优化**；常驻正文和全量候选扫描仍是原有成本，后续若要解决，应另立范围明确的工作。

### 最终保留内容的验证

- 上文 N1 命令：最终面板与侧聊 146/146；`pnpm --filter @vykor/desktop typecheck:web` 通过。
- 上文 N2/N3 命令另加入 `src/application/__test__/daemon-application-context-usage.test.ts`：7 个文件、47/47，包含工厂、实时绑定、故障恢复及正常生命周期；`pnpm --filter @vykor/server check-types` 通过。
- 上文 N4 五文件命令：回滚后原有 117/117；`pnpm --filter @vykor/services check-types` 通过。候选通过数不混入最终保留版本的测试数。
- `node --test scripts/architecture-boundaries.test.mjs`：62/62。基准的独立进程测量要求触发过 `storage-hosts` 门禁；现只许可指定 `storage-growth.bench.mjs` 的唯一 `node:child_process#spawnSync` 命名导入。这是一项明确且狭窄的测试驱动能力许可，未泛化测试目录豁免；行为测试仍拦截生产代码、近似路径、其他子进程符号及该基准的其他禁用能力，原生产规则与业务调用限额不变。
- 各批的 `node scripts/architecture-boundaries.mjs`、`pnpm check:retired-ui`、`pnpm check-docs` 和 `git diff --check` 均通过。没有新增依赖、配置、服务、SQL 迁移或外部 SDK 入口，没有跳过原有测试或删减原断言。

整体审查与最终修复的范围均已记录：唯一 Important 为上述文件编辑与侧聊确认之间的窗口；六项正式 RED 后完成 GREEN，完整 N1 回归 146/146。修复仅涉及关闭 hook、原组件测试和 `UTILITY_PANEL.md`，其他 23 个当时待交付文件逐字节保持不变；主计划在定向复审通过后同步本段记录。最终复审判定该发现已解决，无新破坏、无搁置问题；N2–N4 无需重复改造或重跑基准。
