# Q2 基准驱动与归档脚本独立审查

结论：**需修复**。发现 2 项会影响归档完整性或验收可信度的问题。热路径驱动的主要业务路径和统计门槛可接受；正式测量前应先修复下面两项。本报告仅基于静态阅读，没有运行基准、测试、构建或全仓扫描，不构成 Q2 性能达标结论。

审查日期：2026-10-27。审查工作区：`C:/Users/ruanz/.codex/worktrees/storage-hot-path-q1-q2/OpenHarness-ts`。读取时 HEAD 为 `c0bdb5dbfbda8a6e02be5fbfdc6e0c9ccd4191cc`，Q1 改动仍在暂存区；没有修改源码、测试、索引、HEAD 或分支。审查深度：standard。未派子代理。

## 必须修复

### 1. [P2] 重跑会覆盖已经保存的失败与成功样本

位置：`run-experiments.py:58`、`:67`、`:79`、`:80`、`:84`。

所有调用都向脚本所在目录写入相同的 `candidate.patch`、`manifest.json` 和 `r{round}-{label}-{kind}...` 文件名，使用的写入方式会直接截断已有文件，也没有运行前的防覆盖检查。假如第一次在某个 worker 失败，脚本按预期保存其 stdout/stderr 后退出；再次执行同一命令时，会覆盖该失败样本及先前已完成样本，manifest 也从空的 processes 数组重建。之后即使全通过，也无法复核首次失败及首次测量。这与计划“失败样本保留、不挑样本”和用户要求完整归档不符。

最小修复：在启动任何 worker 或写候选补丁前，检测目标 manifest、补丁和样本文件是否已经存在，存在则拒绝覆盖；或者为每次实验分配新的归档子目录，并让汇总脚本明确选择该目录。重试应保留旧实验目录和失败原件。

### 2. [P2] 未完成的实验可能被汇总为可保留 Q2

位置：`run-experiments.py:81–91`、`:96–97`；`summarize.py:19–27`、`:61`。

runner 先把 worker 的进程退出码及输出写入 manifest，然后才检查输出的 Node、驱动 SHA 和工作区身份。汇总只检查每版本每轮的条数和 worker `exitCode == 0`，不检查 runner 是否走到最后的完成位置。如果第二轮最后一个 growth worker 成功退出，但随后 Node 或 SHA 校验失败，manifest 已经包含全部 60 条 `exitCode == 0` 的进程记录，runner 却失败退出；此时 `summarize.py` 仍可根据这些文件生成 `retainQ2: true`。身份校验拒绝的实验不能成为性能通过证据。

最小修复：汇总必须要求 runner 仅在所有事后校验成功后才写入的完成标志。现有顶层 `endedAt` 只在正常跑完后设置，强制检查它存在即可封住当前路径；更明确的做法是增加 `status: completed`。发生异常时保留原件，并把实验标记为 failed，禁止生成可保留的结论。

## 逐项核对

以下结论均指代码当前写法，不表示已实际执行。

| 范围 | 静态核对结果 |
| --- | --- |
| 同一驱动及各版本源码 | runner 在开始前要求两目录 hot/growth 驱动 SHA 分别相同；逐个检查 `packages/*/node_modules/@vykor` 的实际目标位于本工作区内。hot 驱动记录 Server、Services 入口、Operation/Execution Repository 路径与 SHA，并检查路径不越出所属检出目录。当前 Services package exports 指向自身 `src/index.ts`，SessionStore 通过本目录导入两个 Repository。 |
| 固定候选与追加派发 | candidates、dispatch、blocked 各调用一次 `withStore`，依次创建、关闭独立 SQLite。每库先种 10 条当前结果及 10,000 条无关完成历史；候选库断言初始数量、10 个返回 ID 次序和最终数量。派发库明确追加 warmup 10 次与正式 100 次共 110 条，并核对最终 Operation、Attempt、Execution 和候选数量。 |
| 实际派发与安全入口 | 使用真实 SessionStore lease 和 ToolOperationService 的 prepare → policy authorization check → authorize → policy dispatch check → dispatch → settle。两次 policy check 加 authorize/dispatch 中的 Server 重查均成立，驱动要求 440 次安全查询。没有执行真实工具或模型。 |
| 安全查询包装 | 两处包装均以普通 function 保留 this，使用 `original.apply(this, args)` 原样传参并返回原数组；统计之外没有替换或筛选业务结果，均在 finally 还原原方法。驱动没有直接调用 Q2 新筛选参数。 |
| 未决和额外失败 ID | 使用 history 根的 unknown、已结束 Run 遗留 dispatching；current 根的 read_only 结算提交失败后直接修复成 confirmed，但 Service 内失败标记尚在。断言三个 ID 均进入安全结果，失败 ID 阻塞危险操作，迟到回执解除该失败标记后允许继续。 |
| 进程与采样 | 每版本每轮 hot 3 个新进程；四组 growth 各 3 个新进程。第一轮 baseline → candidate，第二轮 candidate → baseline，全部同步顺序启动。hot 原始 100 次样本、440 次安全子查询和 blocked 子查询保存在结果 JSON，worker stdout/stderr 与退出码保存在文件及 manifest；上述防覆盖问题仍需修复。 |
| 收益门槛 | 每轮单独取 3 个进程中位数，候选要求 percentDelta ≤ -30；派发要求 percentDelta ≤ -10 或 candidate-baseline ≤ -2 ms；两轮都必须满足。没有把两轮混成一个中位数。 |
| 稳定倒退 | candidates/dispatch 进程内 p95 的三进程中位数若两轮同项均增加 >20%，退出。四组 growth 分别检查构造/接管同时 >20% 且 >10 ms，重读 GC 后 heap 增量同时 >10% 且 >5 MiB；两轮同组同项均触发才判稳定倒退。算法与计划一致。 |

## 本次审查身份与边界

以下为读取到的文件字节 SHA256：

- `tool-operation-hot-path.bench.mjs`：`1c8c2ee5804b07fc331f58b1d00bc5682736b62083cbcfe8054f762b79e16cb3`。
- `run-experiments.py`：`8e4fe824de89a074960bdc0b08d1ba882c9e396a1fb244db6909337a6c73a69d`。
- `summarize.py`：`8ff8c9cc2e4d7c7b95b903bfe92a2953226b4539976f01144a21a9a97e8b5b00`。

只读命令为 `Get-Content`、`Get-FileHash`、`git status --short --branch -uall`、`git rev-parse HEAD`。额外阅读了计划的 Q2/测量条款、Service/Repository、Services 导出和 package exports、原 storage-growth 驱动及归档完整性脚本，以核对调用方、返回值和后续汇总路径。没有复用旧性能数值，也没有宣称两轮验收通过。

1. 已完成：三份指定驱动/脚本的静态审查及必要上下文核对。
2. 已完成：将审查结果写入本报告，未修复被审查文件。
3. 待处理：修复两项归档问题；正式两轮测量和 Q2 生产改动审查仍由主任务执行。

## 限定复审（2026-10-27）

最新结论：**可接受，前述两项 P2 均已处理（ADDRESSED），本次修复未发现新的实质问题。** 这项结论仅适用于归档脚本修复，不表示已经取得正式性能样本或达到 Q2 保留门槛。上文“需修复”是初审时的历史结论。

| 初审问题 | 状态 | 复审证据 |
| --- | --- | --- |
| 重跑覆盖旧证据 | **ADDRESSED** | `run-experiments.py:41–46` 在任何外部命令之前检查 manifest、候选补丁、占位文件及已有 worker JSON，发现既有证据立即抛错；随后用 `open("x")` 独占创建 `run-reservation.json`。两个协调进程即使同时通过存在性检查，也只有一个能取得占位；另一个会在启动命令前失败。占位保留在失败现场，后续普通重跑无法截断旧证据。 |
| 未完成实验被判定为可保留 | **ADDRESSED** | `run-experiments.py:118–120` 只在所有 worker 执行与事后身份校验通过后写入顶层 `endedAt` 和 `completed: true`；中途保存的 manifest 没有该标记。`summarize.py:19–21` 在读取样本、计算门槛或生成 comparison 之前，同时要求结束时间存在且 completed 严格为 true。最后一个 worker 的事后校验失败也无法进入汇总。 |

补充核对了本次新增的身份冻结逻辑：`run-experiments.py:47–55` 固定 Node 可执行文件路径并记录字节 SHA；`:67–72` 保存两检出目录的驱动与四份目标源码 SHA；`:85–88` 在每个 worker 启动前与已保存的 SHA 比对，`:107–113` 将 worker 的驱动身份以及 hot worker 实际 Server/Services/Repository 路径与源码 SHA 对照同一冻结值。该修复没有改变原先的两轮顺序、每组 3 个新进程、采样次数或收益/稳定倒退算法。

回归材料实际位于本归档目录下的 `__test__/experiment-archive.test.py`。已静态阅读两项用例：第一项确认已有 manifest 时不启动命令且保留原字节；第二项准备完整的 60 份合成记录，确认缺少完成标记被拒绝且不生成 comparison，随后设置 completed/endedAt，确认相同有效记录仍能得到 retainQ2 为 true。它测试的是归档判定，不是正式性能结果。

主任务保存的 `archive-red-1-rerun-2.txt` 显示两项针对旧行为的预期失败；`archive-green-1.txt` 显示 2 tests / OK，`validation.json` 分别记录退出码 1 / 0。这些是本次复审读取的主任务既有运行证据；我没有重新运行测试、基准、构建或扫描。

复审文件 SHA256：

- `run-experiments.py`：`75bedcc1114ee2eab12ea557003ed6da58fd4777d2cbd3979f6aaa40f20fc34b`。
- `summarize.py`：`769329f98ed1954cf24f3636a6d54d0491dc99ca4bdb05687cdae1df36f2c025`。
- `__test__/experiment-archive.test.py`：`520b78ef9df7258600034a5778c9a73f959b7f60e4492bbd4a1ece981bd89aa0`。

1. 已完成：限定复审与两项问题关闭；仅追加本报告。
2. 未发现：此次归档修复引入的新实质问题。
3. 待执行：主任务的正式两轮性能测量及后续 Q2 保留判断。
