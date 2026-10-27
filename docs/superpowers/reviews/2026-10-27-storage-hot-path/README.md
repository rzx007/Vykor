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

## Q2 实验入口

`run-experiments.py BASELINE_CHECKOUT CANDIDATE_CHECKOUT` 顺序启动新进程。
第一轮 baseline → candidate；第二轮 candidate → baseline。
热路径每版本每轮 3 进程；现行存储基准四组各 3 进程。
`summarize.py` 按已批准的门槛复算每轮结果。

热路径驱动在 Server 的 `__test__/tool-operation-hot-path.bench.mjs`。
候选查询、追加操作的派发、未决操作诊断使用独立临时数据库。
每份数据库初始为 10 条当前会话结果加 10,000 条无关历史，
正文每份 4 KiB；预热 10 次、正式测量 100 次。
派发会追加 110 条操作，查询夹具则始终保持 10 条候选。
所有临时库均只清理自身创建且验证位于系统临时根下的目录。

本轮未引入缓存、索引、SQL 查询后端或正文懒加载。
Q2 即使达标，仍需遍历历史自有键，正文仍完整常驻。
