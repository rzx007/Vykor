"""Sequential local comparison; no other tests/builds/scans during this run.

python run-experiments.py BASELINE_CHECKOUT CANDIDATE_CHECKOUT
Each checkout must have its own pnpm workspace installation. The hot-path
driver is copied byte-for-byte to the frozen Q1 checkout before invocation.
Storage-growth is unchanged. Every worker output/stderr and exit is retained.
"""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import shutil
from datetime import datetime, timezone

HERE = Path(__file__).resolve().parent
HOT = Path("packages/server/src/application/session/execution/__test__/tool-operation-hot-path.bench.mjs")
GROWTH = Path("packages/services/src/database/persistence/__test__/storage-growth.bench.mjs")
CHECKOUTS = dict(zip(("baseline", "candidate"), map(lambda p: Path(p).resolve(), sys.argv[1:3])))


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def git(root, *args):
    return subprocess.check_output(["git", "-C", str(root), *args]).decode().strip()


def save(path, data):
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")


def median(values):
    return sorted(values)[len(values) // 2]


def main():
    assert len(CHECKOUTS) == 2
    if any((HERE / name).exists() for name in ("manifest.json", "candidate.patch", "run-reservation.json")) or any(HERE.glob("r[12]-*.json")):
        raise FileExistsError("Existing experiment evidence must be preserved; use a fresh output directory")
    started = datetime.now(timezone.utc).isoformat()
    with (HERE / "run-reservation.json").open("x", encoding="utf-8", newline="\n") as reservation:
        json.dump({"startedAt": started, "arguments": sys.argv[1:], "coordinatorSha256": sha(Path(__file__))}, reservation, indent=2)
        reservation.write("\n")
    node = shutil.which("node")
    assert node
    manifest = {"startedAt": datetime.now(timezone.utc).isoformat(), "processes": [],
                "node": subprocess.check_output([node, "--version"]).decode().strip(),
                "nodeExecutable": node, "nodeExecutableSha256": sha(Path(node)), "checkouts": {}}
    source_paths = {"server": Path("packages/server/src/application/session/execution/tool-operation-service.ts"),
        "services": Path("packages/services/src/index.ts"),
        "operations": Path("packages/services/src/tool-operations/tool-operation-repository.ts"),
        "executions": Path("packages/services/src/execution-records/execution-repository.ts")}
    for label, root in CHECKOUTS.items():
        links = {}
        for package in (root / "packages").iterdir():
            scope = package / "node_modules/@vykor"
            if not scope.exists():
                continue
            for link in scope.iterdir():
                target = link.resolve()
                assert target.is_relative_to(root), (link, target)
                links[str(link.relative_to(root))] = str(target)
        assert links, "No local workspace dependencies found"
        manifest["checkouts"][label] = {"root": str(root), "head": git(root, "rev-parse", "HEAD"),
            "status": git(root, "status", "--short"), "hotSha256": sha(root / HOT),
            "growthSha256": sha(root / GROWTH), "workspaceLinks": links,
            "sourceSha256": {key: sha(root / path) for key, path in source_paths.items()}}
    assert len({v["hotSha256"] for v in manifest["checkouts"].values()}) == 1
    assert len({v["growthSha256"] for v in manifest["checkouts"].values()}) == 1
    (HERE / "candidate.patch").write_bytes(subprocess.check_output(
        ["git", "-C", str(CHECKOUTS["candidate"]), "diff", "--binary", "HEAD", "--", "packages"]))
    for round_no, order in ((1, ("baseline", "candidate")), (2, ("candidate", "baseline"))):
        for label in order:
            root = CHECKOUTS[label]
            for kind, groups in (("hot", [None]), ("growth", [(100, 4096), (1000, 4096), (10000, 4096), (10000, 0)])):
                for group in groups:
                    for repeat in range(1, 4):
                        suffix = "" if group is None else "-%s-%s" % group
                        name = f"r{round_no}-{label}-{kind}{suffix}-{repeat}"
                        package = root / ("packages/server" if kind == "hot" else "packages/services")
                        script = root / (HOT if kind == "hot" else GROWTH)
                        expected = manifest["checkouts"][label]
                        assert sha(script) == expected["hotSha256" if kind == "hot" else "growthSha256"]
                        for key, path in source_paths.items():
                            assert sha(root / path) == expected["sourceSha256"][key], "Source changed during measurement"
                        loader = root / "apps/cli/node_modules/tsx/dist/loader.mjs"
                        command = [node, "--expose-gc", "--import", str(loader), str(script)]
                        if group is not None:
                            command += ["--worker", *map(str, group)]
                        entry = {"name": name, "round": round_no, "label": label, "kind": kind,
                            "group": group, "repeat": repeat, "command": command, "cwd": str(package),
                            "startedAt": datetime.now(timezone.utc).isoformat()}
                        print("Starting", name, flush=True)
                        completed = subprocess.run(command, cwd=package, capture_output=True)
                        (HERE / f"{name}.json").write_bytes(completed.stdout)
                        (HERE / f"{name}.stderr.txt").write_bytes(completed.stderr)
                        entry.update(exitCode=completed.returncode, endedAt=datetime.now(timezone.utc).isoformat(),
                                     stdoutSha256=sha(HERE / f"{name}.json"))
                        manifest["processes"].append(entry)
                        save(HERE / "manifest.json", manifest)
                        if completed.returncode:
                            raise RuntimeError(f"{name} failed: all stdout/stderr preserved")
                        data = json.loads(completed.stdout)
                        assert data["node"] == manifest["node"]
                        assert data["sha256"] == expected["hotSha256" if kind == "hot" else "growthSha256"]
                        if kind == "hot":
                            assert Path(data["root"]).resolve() == root
                            for key, path in source_paths.items():
                                assert Path(data["sources"][key]["path"]).resolve() == (root / path).resolve()
                                assert data["sources"][key]["sha256"] == expected["sourceSha256"][key]
                            print(name, "candidate", data["candidates"]["timing"]["medianMs"],
                                  "dispatch", data["dispatch"]["timing"]["medianMs"], flush=True)
                        else:
                            print(name, "construct", data["constructMs"], "takeover", data["takeoverMs"], flush=True)
    manifest["endedAt"] = datetime.now(timezone.utc).isoformat()
    manifest["completed"] = True
    save(HERE / "manifest.json", manifest)


if __name__ == "__main__":
    main()
