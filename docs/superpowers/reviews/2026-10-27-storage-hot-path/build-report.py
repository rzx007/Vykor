"""Build readable comparisons without modifying any original worker bytes."""
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
RUN = HERE / "attempt-2"


def main():
    comparison = json.loads((RUN / "comparison.json").read_bytes())
    manifest = json.loads((RUN / "manifest.json").read_bytes())
    assert manifest["completed"] and len(manifest["processes"]) == 60
    assert comparison["retainQ2"] is False
    rows = """# Q2 两轮性能验收与回滚

结论：Q2 未通过保留门槛，生产改动已撤回；保留 Q1、基准、候选补丁及全部实验材料，不继续增加索引。

第一轮收益达标，第二轮候选查询与模拟派发均倒退，不能合并两轮或挑选进程给出收益承诺。1,000 Run × 4 KiB 的 owner 接管在两轮都同时增加超过 20% 和 10 ms，另行触发稳定退化退出条件。

## 身份与方法

- 起点为最新 origin/main 的计划提交 c0bdb5db；Q1 冻结提交为 13d9f7cca84a9acef5644d8a89367d07c94ef6e5。2ae6a425 仅为原归档数据版本。
- Windows / Node v24.18.1；同一个 Node 可执行文件的路径及 SHA256、所有命令、退出码、源码 SHA 和工作区链接见[完整执行清单](./attempt-2/manifest.json)。内部工作区链接均指向各自检出，hot worker 实际导入路径与冻结 SHA 逐项核对。
- 热路径驱动 SHA256 为 1c8c2ee5804b07fc331f58b1d00bc5682736b62083cbcfe8054f762b79e16cb3，两版本完全相同，见[冻结记录](./driver-freeze.json)。存储驱动未改，执行 CRLF 字节 SHA256 为 f43f16f969f7c6366081e7a54406b15ed8a2939d8db2d9a1168605431ab43c0f，Git blob 为 5370f3e0c6339994763a26256a3a5dd465e03764，可由冻结提交恢复。
- 两轮分别 baseline → candidate、candidate → baseline。每版本每轮热路径 3 新进程，存储四组各 3 新进程，共 60/60 成功。每个查询或模拟循环预热 10 次、正式 100 次；全部样本保留，不合并两轮。
- 表格取三个进程统计量的中位数。进程内 median 沿用现行驱动的上中位数，p95 为最近秩法；每进程全部 100 次计时均在原件。百分比为候选相对基线，负数表示下降。
- 测量期间本任务其他代理、测试、类型检查、构建与扫描均停止。未控制整机调度、其他应用、CPU 状态和磁盘缓存，不能用这些波动豁免门槛。模块导入、建库和种子写入排除在热路径计时之外，存储基准另测构造和接管。

## 热路径：两轮分别比较

候选查询需每轮至少下降 30%；模拟危险派发需每轮至少下降 10% 或 2 ms，两项同时满足。安全子查询和阻塞诊断只作补充，不替代完整派发。

| 轮次 | 指标 | 基线 median ms | 候选 median ms | 变化 | 基线 p95 ms | 候选 p95 ms | p95 变化 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |""".splitlines()
    names = {"candidates": "固定 10 条候选", "dispatch": "完整模拟危险派发", "safety": "实际安全子查询", "blocked": "未决及失败 ID 阻塞诊断"}
    for r in comparison["rounds"]:
        for key, name in names.items():
            m, p = r["hot"][key]["medianMs"], r["hot"][key]["p95Ms"]
            rows.append(f"| {r['round']} | {name} | {m['baseline']:.4f} | {m['candidate']:.4f} | {m['percentDelta']:+.2f}% | {p['baseline']:.4f} | {p['candidate']:.4f} | {p['percentDelta']:+.2f}% |")
    rows += """

第一轮两项主要收益达标；第二轮两项均未达标。第二轮派发 p95 增加 22.19%，第一轮未出现同项退化，故不单独认定为稳定 p95 退化；第二轮主要收益失败已足以退出。

## 构造、接管与 GC 后驻留

单元格为“基线 → 候选（百分比；绝对差）”。构造/接管同时增加 >20% 和 >10 ms，GC 后 heap 同时增加 >10% 和 >5 MiB，并在两轮同组同项复现时退出。

| 轮次 | Run / 正文字节 | 构造 ms | owner 接管 ms | 接管 GC 后 heap 增量 MiB | 本轮超阈项 |
| --- | --- | --- | --- | --- | --- |""".splitlines()
    for r in comparison["rounds"]:
        for group, values in r["growth"].items():
            cells = []
            for metric in ("constructMs", "takeoverMs", "reloadedHeapMiB"):
                v = values[metric]
                cells.append(f"{v['baseline']:.3f} → {v['candidate']:.3f}（{v['percentDelta']:+.2f}%；{v['absoluteDelta']:+.3f}）")
            breaches = [x.split(":")[1] for x in r["growthRegressions"] if x.startswith(group + ":")]
            rows.append(f"| {r['round']} | {group} | " + " | ".join(cells) + " | " + (", ".join(breaches) or "无") + " |")
    rows += """

1,000 Run 正文组接管：第一轮 113.567 → 160.570 ms（+41.39%，+47.003 ms），第二轮 134.201 → 266.381 ms（+98.49%，+132.180 ms），构成稳定退化。第二轮同组构造另超阈，第一轮未复现；没有稳定 heap 超阈。

## 全局安全投影诊断

现行存储基准仍让该查询输出全部 N 条元数据，不承担常数时间目标。这里的 N 是总 Run 数，不能与热路径夹具的“10 + 10,000”或筛选后结果混算。

| 轮次 | Run / 正文字节 | 输出条数 | 基线 median ms | 候选 median ms | 变化 |
| --- | --- | ---: | ---: | ---: | ---: |""".splitlines()
    for number in (1, 2):
        for group in ([100, 4096], [1000, 4096], [10000, 4096], [10000, 0]):
            values = {}
            for label in ("baseline", "candidate"):
                samples = [json.loads((RUN / (e["name"] + ".json")).read_bytes()) for e in manifest["processes"]
                           if e["round"] == number and e["label"] == label and e["kind"] == "growth" and e["group"] == group]
                values[label] = sorted(s["safety"]["medianMs"] for s in samples)[1]
            b, c = values["baseline"], values["candidate"]
            rows.append(f"| {number} | {group[0]}/{group[1]} | {group[0]} | {b:.4f} | {c:.4f} | {(c / b - 1) * 100:+.2f}% |")
    rows += """

## 独立夹具与断言

- 候选查询固定为当前会话 10 条完成结果与 10,000 条无关完成历史，总计 10,010 条 Operation/Attempt/Execution/Run；初末数量及候选插入次序相同。关闭后才建立派发数据库。
- 派发夹具初始 10,010 条操作、10,011 个 Run；110 次循环后为 10,120 条操作/Attempt、10,011 个 Execution，当前结果 10 → 120。每进程真实执行 440 次安全复查，包含两个 policy check 和 authorize/dispatch Server 重查。
- 安全包装透明转发 this、参数和返回值，并在 finally 还原；驱动不主动调用 Q2 新筛选形式。基线普通派发安全读取逐次输出 10,011–10,120 条，候选输出 0 条，仍遍历全部历史自有键。
- 第三个独立数据库含无关根 unknown、终态 Run 的 dispatching，以及当前树 confirmed read_only 的真实回执提交失败 ID。危险操作被阻断，只有对应失败解除后才允许；基线返回 10,014 条元数据、候选返回 3 条，初末数量不变。

## 失败材料、恢复与复算

- 第一次启动因 Windows --import 绝对路径格式失败，未进入测量；[失败清单](./manifest.json)、stderr、空 stdout、[当时脚本](./attempt-1-run-experiments.py) 均保留。改为 file URL 后，在全新 attempt-2 目录完整运行两轮，计时驱动 SHA 未变。
- [完整正式清单](./attempt-2/manifest.json) 列出全部原始 JSON、stderr、命令、时间和退出码；每个成功进程的 PID 在对应 JSON 中。[派生数值及门槛](./attempt-2/comparison.json) 不替代原始样本。
- [候选完整补丁](./attempt-2/candidate.patch) 包含生产、测试、README 和确切基准；[确切源码映射](./candidate-source/manifest.json) 在撤回前保存五份原始文件，Git 按原字节归档，.txt 后缀避免它们被当作在用源码。
- run-experiments.py 拒绝覆盖原件，并用独占占位阻止同目录并发；summarize.py 只接受完整完成身份校验的运行。两项先失败回归、修复及独立复审见[基准审查](./benchmark-review.md)。
- 复算命令：python docs/superpowers/reviews/2026-10-27-storage-hot-path/summarize.py docs/superpowers/reviews/2026-10-27-storage-hot-path/attempt-2，然后运行同目录 build-report.py。

本报告不把新实验当作旧 N4 的复验，不宣称消除全量扫描或解决正文常驻。最终保留的生产实现只有 Q1。""".splitlines()
    (HERE / "q2-performance.md").write_text("\n".join(rows) + "\n", encoding="utf-8", newline="\n")


if __name__ == "__main__":
    main()
