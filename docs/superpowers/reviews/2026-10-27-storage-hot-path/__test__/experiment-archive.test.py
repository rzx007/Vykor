"""Regression checks for preserving failed experiment evidence."""
import json
import io
from contextlib import redirect_stdout
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parents[1]


def load(name, directory):
    source = HERE / name
    namespace = {"__file__": str(source), "__name__": "archive_under_test"}
    exec(compile(source.read_text(encoding="utf-8"), str(source), "exec"), namespace)
    namespace["HERE"] = directory
    return namespace


class ExperimentArchiveTests(unittest.TestCase):
    def test_existing_evidence_is_rejected_before_starting_commands(self):
        with tempfile.TemporaryDirectory(prefix="hot-path-archive-test-") as folder:
            directory = Path(folder)
            manifest = directory / "manifest.json"
            original = b'{"failedWorker":"keep these original bytes"}\n'
            manifest.write_bytes(original)
            module = load("run-experiments.py", directory)
            module["CHECKOUTS"] = {"baseline": directory, "candidate": directory}
            with patch.object(module["subprocess"], "check_output", side_effect=RuntimeError("Must reject before running any command")) as command:
                caught = None
                try:
                    module["main"]()
                except Exception as error:
                    caught = error
                self.assertIsInstance(caught, FileExistsError)
                command.assert_not_called()
            self.assertEqual(manifest.read_bytes(), original)

    def test_successful_worker_exits_cannot_accept_an_incomplete_coordinator_run(self):
        with tempfile.TemporaryDirectory(prefix="hot-path-archive-test-") as folder:
            directory = Path(folder)
            processes = []
            for number in (1, 2):
                for label in ("baseline", "candidate"):
                    for kind, groups in (("hot", [None]), ("growth", [[100, 4096], [1000, 4096], [10000, 4096], [10000, 0]])):
                        for group in groups:
                            for repeat in (1, 2, 3):
                                name = f"r{number}-{label}-{kind}-{group}-{repeat}"
                                processes.append({"name": name, "round": number, "label": label, "kind": kind, "group": group, "exitCode": 0})
                                if kind == "hot":
                                    value = 20 if label == "baseline" else 10
                                    timing = {"medianMs": value, "p95Ms": value}
                                    data = {key: {"timing": timing} for key in ("candidates", "dispatch", "blocked")}
                                    data["dispatch"]["safety"] = {"measured": timing}
                                else:
                                    data = {"constructMs": 100, "takeoverMs": 100,
                                            "before": {"heapUsed": 0}, "reloaded": {"heapUsed": 100 * 1048576}}
                                (directory / (name + ".json")).write_text(json.dumps(data), encoding="utf-8")
            # A worker may exit 0 before the coordinator rejects its identity.
            (directory / "manifest.json").write_text(json.dumps({"processes": processes}), encoding="utf-8")
            module = load("summarize.py", directory)
            with self.assertRaises(ValueError):
                module["main"]()
            self.assertFalse((directory / "comparison.json").exists())
            (directory / "manifest.json").write_text(json.dumps({"processes": processes,
                "completed": True, "endedAt": "2026-10-27T00:00:00+00:00"}), encoding="utf-8")
            with redirect_stdout(io.StringIO()):
                module["main"]()
            self.assertTrue(json.loads((directory / "comparison.json").read_text())["retainQ2"])


if __name__ == "__main__":
    unittest.main()
