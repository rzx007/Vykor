# Q2 退出与最终归档独立审查

**规格符合性：通过。** 两轮分别验收、收益不一致即退出，以及稳定退化退出的处理符合已批准计划。Q2 生产改动和专属测试已撤回，保留 Q1、相同基准、候选补丁和全部实验材料，没有继续增加索引。

**质量：通过，可提交归档。** 本次未发现需要修复的实质问题（P0–P3 均无）。这表示退出决定和归档内容可接受，不表示 Q2 性能达标。报告完成后的最终字节清单、Git 索引及提交字节核对，仍由主执行流程完成。

审查日期：2026-10-27。工作区：`C:/Users/ruanz/.codex/worktrees/storage-hot-path-q1-q2/OpenHarness-ts`。读取时 HEAD 为 Q1 冻结提交 `13d9f7cca84a9acef5644d8a89367d07c94ef6e5`，实施起点为 `c0bdb5dbfbda8a6e02be5fbfdc6e0c9ccd4191cc`。本次只读源码、补丁、计划、原件和既有日志；只写本报告，没有改生产、测试、索引、HEAD 或分支，没有派子代理，没有重跑基准、测试、构建或全仓扫描。

## 验收与退出结论

依据[计划的测量和保留条件](../../plans/2026-10-27-storage-hot-path-optimization-plan.md)，逐份读取 `attempt-2/manifest.json` 列出的 60 个进程 JSON，以只读 Python 从完整样本独立核算进程内统计量、三个进程的中位数、百分比及门槛。没有运行会写 comparison 的汇总脚本。结果与 `attempt-2/comparison.json` 精确一致。

| 轮次 | 固定 10 条候选 median ms | 候选门槛 ≥30% 下降 | 完整模拟派发 median ms | 派发门槛 ≥10% 或 ≥2 ms 下降 |
| --- | --- | --- | --- | --- |
| 1 | 11.2108 → 6.6025（-41.11%） | 通过 | 81.5712 → 34.8132（-57.32%） | 通过 |
| 2 | 5.6026 → 6.7489（+20.46%） | 不通过 | 48.3066 → 76.3212（+57.99%） | 不通过 |

两项门槛分别判断，两轮分别保留。第二轮两项失败，不能合并轮次或剔除慢进程后保留 Q2。`summarize.py:53–67` 的实际判定与上述规则相符。

派发 p95 第二轮增加 22.19%，第一轮下降 47.37%，没有两轮同项超过 20% 的稳定退化。四组存储数据分别核算：1,000 Run / 4 KiB 的 owner 接管第一轮 `113.5670 → 160.5703 ms`（+41.39%，+47.0033 ms），第二轮 `134.2006 → 266.3811 ms`（+98.49%，+132.1805 ms），两轮都同时超过 20% 和 10 ms，单独构成稳定退化退出理由。第二轮同组构造越过门槛、第一轮未复现；没有稳定 heap 超阈。因此 `retainQ2=false` 正确。[性能报告](./q2-performance.md)没有把全局安全投影诊断当作完整派发收益，也没有声称消除全量扫描或正文常驻。

## 原始证据与运行身份

- 正式 manifest 有 `completed: true` 和结束时间，共 12 个 hot worker、48 个 growth worker，60 个退出码全部为 0。记录顺序严格为第一轮 baseline → candidate、第二轮 candidate → baseline，各组各 3 个新进程，60 个 PID 不重复；相邻记录没有重叠。全部 60 份 stdout 原字节 SHA256 与 manifest 一致，60 份 stderr 均存在。
- 对 12 份 hot 原件的候选、派发、阻塞诊断各 100 次样本及安全子查询 400 次样本，独立核对上中位数和最近秩 p95；对 48 份 growth 原件的两类查询各 100 次样本核对中位数，再从构造、接管和 GC 后 heap 原值复算全部四组比较。每轮所有样本均参与，没有合并两轮。
- 两版本均使用 Node `v24.18.1`，记录的 Node 可执行文件路径与 SHA 相同。每个 worker 的驱动 SHA 与所属检出冻结值一致；每个 hot worker 的实际 Server、Services 入口及两个 Repository 路径都在自身检出内，源码 SHA 与 manifest 对应。两份 manifest 记录的各 121 个内部工作区依赖链接均落在各自检出内。
- 当前保留热路径驱动的字节 SHA256 为 `1c8c2ee5804b07fc331f58b1d00bc5682736b62083cbcfe8054f762b79e16cb3`，与所有 hot worker 及 `driver-freeze.json` 一致。存储驱动保持原有身份 `f43f16f969f7c6366081e7a54406b15ed8a2939d8db2d9a1168605431ab43c0f`。

## 夹具与安全路径

`tool-operation-hot-path.bench.mjs:144–156` 的候选夹具与 `:157–185` 的派发夹具分别创建、关闭数据库；第三份阻塞夹具从 `:189` 独立建立。每份初始历史为 10 条当前会话完成结果加 10,000 条无关完成历史。全部原件确认候选夹具初末相同且固定返回 10 条；派发夹具明确从 10,010 条操作追加 110 条，最终 10,120 条操作/Attempt、10,011 个 Execution，当前结果 10 → 120。

`dispatchInput:133–140` 执行 prepare、两次 policy check、authorize、dispatch，之后真实 Service settle；没有运行真实工具或模型。每份原件恰有 440 次安全复查，包含两个 policy check 和 authorize/dispatch 的 Server 重查。包装在 `:163–168`、`:218–225` 原样转发 this、参数和返回值，并在 finally 还原；驱动没有主动调用 Q2 新筛选参数。基线每次普通派发输出 10,011–10,120 条安全元数据，候选输出 0 条，不改变仍需遍历历史键的事实。

`blocked:195–240` 保留无关根 unknown、终态 Run 的 dispatching，以及当前树真实回执提交失败后已持久修复为 confirmed 的 read_only ID。所有原件各有 110 次复查，三个 ID 始终包含在结果中；基线返回 10,014 条、候选返回 3 条，初末数量相同。断言要求失败 ID 阻塞危险操作，并在该失败标记通过迟到回执解除后才允许。候选补丁中的 Service 专项回归还逐一覆盖两个 policy check 和 authorize/dispatch 四个入口，未遗漏特殊 confirmed 只读失败 ID。

## 回滚与可恢复性

- 用 `git diff 13d9f7cc -- <限定文件>` 核对四个生产文件，以及既有 Service、清理和 Operation Repository 测试，差异为空；Q2 新增的 `execution-repository.test.ts` 已不在活跃树。限定 `packages` 的差异只有执行目录 README 和新基准。当前生产逻辑保留 Q1，没有 Q2 索引、缓存或读取规则残留。
- `attempt-2/candidate.patch` 完整保留四份 Q2 生产修改、专属测试、README 与基准，SHA256 为 `3ede9b8edec0c3e11d5c66f5c341b825bf2519adc4e66fdecce16ed2725b9705`；根目录候选补丁字节相同。核对 `candidate-source/manifest.json` 的五份源码原字节 SHA，全部相符；其中 Server、Services 入口及两个 Repository 的 SHA 与测量身份逐项一致。只在内存中把补丁应用于 Q1 对应文件，结果与五份快照文本一致；快照保留原始换行字节，`.ts.txt` 后缀不会成为活跃源码。
- 首次根目录 manifest 仅有一个退出码 1 的 worker，stdout 为空；stderr 明确为 Windows `--import` 绝对路径触发 `ERR_UNSUPPORTED_ESM_URL_SCHEME`，没有有效计时。`attempt-1-run-experiments.py` 的 SHA 为 `75bedcc1114ee2eab12ea557003ed6da58fd4777d2cbd3979f6aaa40f20fc34b`，与失败现场 `run-reservation.json` 一致。修正协调器 SHA 为 `30eaaa15b18d1efbc4d259998d7edd6bc35e4927625db1699ffce7e22ed3875c`，与 attempt-2 占位记录一致；在全新输出目录完整重跑，热路径计时驱动 SHA 未变。
- `run-experiments.py:45–50` 先拒绝既有材料并独占创建占位；`:122–124` 仅在完整身份校验后标记完成，`summarize.py:24–25` 拒绝未完成实验。已阅读[基准脚本初审及限定复审](./benchmark-review.md)，前述两项 P2 已关闭，既有 RED/GREEN 材料均保留。
- 仅在本证据目录内枚举并以 `git check-ignore --stdin` 核对，读取时 194 份材料全部可进入 Git；`.gitattributes` 对该目录禁用文本换行转换，原始 JSON、stderr、失败材料、补丁和源码字节可以原样归档。最终报告加入后的完整字节清单与索引/提交核对属于主流程的后续步骤，本报告不提前宣称它们已通过。

## 既有验证与审查边界

已核对 `validation.json` 与对应日志：候选先 RED 5 项，随后 Server 49 项、Services 195 项、两个包类型和门禁通过；回滚后 Server 48 项、Services 操作及补读 35 项、两个包类型、架构、退役 UI、文档与空白门禁通过。这里引用的是主流程保存的既有运行结果，没有重复执行。

本轮测量没有控制整机调度、其他应用、CPU 状态及磁盘缓存；已按预定门槛退出，没有用这些限制豁免失败，也没有把新实验当作旧 N4 的复验。没有需要附加精确行号的实质发现；可继续执行最终字节冻结、Git 核对并提交归档。
