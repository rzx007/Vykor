# Q1–Q2 存储热路径实施证据

本目录保存本轮回归、独立审查和性能实验材料。起点为最新
`origin/main = c0bdb5dbfbda8a6e02be5fbfdc6e0c9ccd4191cc`。
原主工作区干净，实施使用独立的 `codex/storage-hot-path-q1-q2` 分支。
`2ae6a425` 只是此前归档基准的数据身份，本轮不从它实现。

## Q1

已完成并通过独立审查。先加入真实 SQLite Service 的 1 MiB 正文结算、提交失败、
迟到回执和逐项核对用例，禁止状态读取调用完整 `get()`。
清理用例覆盖根、子、孙会话与四种未决状态的 12 种组合，
禁止完整 `list()`，并核对一次元数据读取及执行前复查。

RED 为 16 项预期失败；GREEN 为 Server 四文件 48 项。
Server 类型、架构、退役 UI、文档和空白门禁全部通过。
独立审查无实质发现，见 [q1-review.md](./q1-review.md)。
确切命令、退出码和日志位置见 [validation.json](./validation.json)；
首次 Server 类型检查缺少本目录生成产物的失败和补建日志也保留。

Q1 冻结提交为 `13d9f7cca84a9acef5644d8a89367d07c94ef6e5`。
提交钩子的 72 个工作区任务及 server-client 类型检查也通过；
原始分任务日志保存为 `q1-hook-task-logs.zip`，执行情况见 `q1-hook-context.json`。
曾阻塞的 Turbo 只读 Git 状态子进程被终止后，实际检查正常执行；没有绕过钩子。

## Q2 结论：不保留生产改动

候选 RED 为 5 项预期失败；Server 49 项、Services 195 项及两个包类型、架构和其余门禁通过。
正式两轮共 60 个成功新进程，第一轮主要收益达标，第二轮不达标；
1,000 Run 正文组接管还在两轮稳定触发退化门槛，故按计划退出。
四个生产文件已恢复为 Q1，候选专属测试随生产代码撤回，完整内容保留在补丁中。
回滚后 Server 48 项、Services 操作及补读 35 项、两个包类型和全部门禁通过。
最终归档独立审查通过，无实质发现，见 [q2-review.md](./q2-review.md)。

完整两轮 median/p95、四组构造/接管/heap 和全局安全诊断见 [q2-performance.md](./q2-performance.md)。
原始样本、命令与身份在 [attempt-2/manifest.json](./attempt-2/manifest.json)；
可恢复的候选见 [candidate.patch](./attempt-2/candidate.patch) 和 [确切源码字节](./candidate-source/manifest.json)。

## Q2 实验入口

`run-experiments.py BASELINE_CHECKOUT CANDIDATE_CHECKOUT FRESH_OUTPUT_DIRECTORY` 顺序启动新进程，拒绝覆盖既有结果。
第一轮 baseline → candidate；第二轮 candidate → baseline。
热路径每版本每轮 3 进程；现行存储基准四组各 3 进程。
`summarize.py OUTPUT_DIRECTORY` 按已批准的门槛复算每轮结果。本次完整目录为 attempt-2；根目录第一次启动的 Node 导入错误、空 stdout、stderr、清单和当时脚本全部保留，不能用于收益结论。

热路径驱动在 Server 的 `__test__/tool-operation-hot-path.bench.mjs`。
候选查询、追加操作的派发、未决操作诊断使用独立临时数据库。
每份数据库初始为 10 条当前会话结果加 10,000 条无关历史，
正文每份 4 KiB；预热 10 次、正式测量 100 次。
派发会追加 110 条操作，查询夹具则始终保持 10 条候选。
所有临时库均只清理自身创建且验证位于系统临时根下的目录。

本轮未引入缓存、索引、SQL 查询后端或正文懒加载。
Q2 候选仍需遍历历史自有键；当前保留的 Q1 同样没有解决全量扫描或正文常驻。


## 原字节与 Git 复核

verify-archive.py --write 生成 integrity.json；暂存后直接运行 verify-archive.py，提交后运行 verify-archive.py --ref HEAD。
它逐项比较工作区、记录 SHA256 与 Git 原始 blob，并单独比较字节清单自身。
两份现存基准 JSON 保持原有字节；原始 stderr、失败空 stdout、补丁及源码快照不格式化。
归档清单的 SHA256 同时写入归档提交消息，便于独立复核。
