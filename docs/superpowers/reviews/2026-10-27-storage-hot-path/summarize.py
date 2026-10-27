"""Recompute the pre-agreed gates without dropping or merging rounds."""
import json
import sys
from pathlib import Path
from runpy import run_path

HERE = Path(__file__).resolve().parent


def median(values):
    return sorted(values)[len(values) // 2]


def delta(baseline, candidate):
    return {"baseline": baseline, "candidate": candidate, "absoluteDelta": candidate - baseline,
            "percentDelta": (candidate / baseline - 1) * 100 if baseline else None}


def main():
    global HERE
    if len(sys.argv) > 1:
        HERE = Path(sys.argv[1]).resolve()
    manifest = json.loads((HERE / "manifest.json").read_text(encoding="utf-8"))
    if not manifest.get("endedAt") or manifest.get("completed") is not True:
        raise ValueError("The experiment coordinator did not complete all identity checks")
    rounds = []
    for number in (1, 2):
        data = {}
        for label in ("baseline", "candidate"):
            entries = [entry for entry in manifest["processes"] if entry["round"] == number and entry["label"] == label]
            assert len(entries) == 15
            assert all(entry["exitCode"] == 0 for entry in entries)
            hot = [json.loads((HERE / (entry["name"] + ".json")).read_bytes()) for entry in entries if entry["kind"] == "hot"]
            data[label] = {"hot": {}, "growth": {}}
            for kind in ("candidates", "dispatch", "blocked"):
                data[label]["hot"][kind] = {metric: median([sample[kind]["timing"][metric] for sample in hot])
                                            for metric in ("medianMs", "p95Ms")}
            data[label]["hot"]["safety"] = {metric: median([s["dispatch"]["safety"]["measured"][metric] for s in hot])
                                           for metric in ("medianMs", "p95Ms")}
            for group in ((100, 4096), (1000, 4096), (10000, 4096), (10000, 0)):
                samples = [json.loads((HERE / (e["name"] + ".json")).read_bytes()) for e in entries
                           if e["kind"] == "growth" and e["group"] == list(group)]
                assert len(samples) == 3
                data[label]["growth"]["%s/%s" % group] = {
                    "constructMs": median([s["constructMs"] for s in samples]),
                    "takeoverMs": median([s["takeoverMs"] for s in samples]),
                    "reloadedHeapMiB": median([(s["reloaded"]["heapUsed"] - s["before"]["heapUsed"]) / 1048576 for s in samples]),
                }
        hot = {kind: {metric: delta(data["baseline"]["hot"][kind][metric], data["candidate"]["hot"][kind][metric])
                      for metric in ("medianMs", "p95Ms")} for kind in ("candidates", "dispatch", "blocked", "safety")}
        growth = {group: {metric: delta(data["baseline"]["growth"][group][metric], data["candidate"]["growth"][group][metric])
                          for metric in ("constructMs", "takeoverMs", "reloadedHeapMiB")} for group in data["baseline"]["growth"]}
        candidate_gate = hot["candidates"]["medianMs"]["percentDelta"] <= -30
        dispatch_gate = hot["dispatch"]["medianMs"]["percentDelta"] <= -10 or hot["dispatch"]["medianMs"]["absoluteDelta"] <= -2
        regressions = []
        for group, metrics in growth.items():
            for metric, values in metrics.items():
                percent, absolute = (10, 5) if metric == "reloadedHeapMiB" else (20, 10)
                if values["percentDelta"] > percent and values["absoluteDelta"] > absolute:
                    regressions.append(group + ":" + metric)
        rounds.append({"round": number, "hot": hot, "growth": growth,
                       "candidateGate": candidate_gate, "dispatchGate": dispatch_gate,
                       "growthRegressions": regressions,
                       "p95Regressions": [kind for kind in ("candidates", "dispatch") if hot[kind]["p95Ms"]["percentDelta"] > 20]})
    stable_growth = sorted(set(rounds[0]["growthRegressions"]) & set(rounds[1]["growthRegressions"]))
    stable_p95 = sorted(set(rounds[0]["p95Regressions"]) & set(rounds[1]["p95Regressions"]))
    keep = all(row["candidateGate"] and row["dispatchGate"] for row in rounds) and not stable_growth and not stable_p95
    result = {"rounds": rounds, "stableGrowthRegressions": stable_growth, "stableP95Regressions": stable_p95,
              "retainQ2": keep}
    (HERE / "comparison.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8", newline="\n")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
