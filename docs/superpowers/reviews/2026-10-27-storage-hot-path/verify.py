"""Capture exact targeted validation commands, output and exit codes."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

sys.stdout.reconfigure(encoding="utf-8")

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
SERVER_TESTS = ["src/application/session/execution/__test__/tool-operation-service.test.ts",
    "src/application/session/execution/__test__/tool-operation-invocation.test.ts",
    "src/application/session/execution/__test__/tool-operation-review.test.ts",
    "src/application/maintenance/__test__/cleanup-settings.test.ts"]
SERVICES_TESTS = ["src/tool-operations/__test__/tool-operation-repository.test.ts",
    "src/execution-records/__test__/execution-repository.test.ts",
    "src/tool-results/__test__/tool-result-reader.test.ts",
    "src/conversations/__test__/record-rollback.test.ts",
    "src/conversations/__test__/conversation-transactions.test.ts",
    "src/session-runtime/__test__/temporary-chat-storage.test.ts",
    "src/session-runtime/__test__/store.test.ts"]


def pnpm(*args):
    return ["cmd.exe", "/d", "/c", shutil.which("pnpm.cmd"), *args]


def main():
    phase = sys.argv[1]
    if phase == "q1-red":
        commands = [pnpm("--filter", "@vykor/server", "exec", "vitest", "run", SERVER_TESTS[0], SERVER_TESTS[3])]
    elif phase == "q2-red":
        commands = [pnpm("--filter", "@vykor/services", "exec", "vitest", "run", *SERVICES_TESTS[:2])]
    else:
        commands = [pnpm("--filter", "@vykor/server", "exec", "vitest", "run", *SERVER_TESTS)]
        if phase == "q2-green":
            commands += [pnpm("--filter", "@vykor/services", "exec", "vitest", "run", *SERVICES_TESTS),
                         pnpm("--filter", "@vykor/services", "check-types")]
        commands += [pnpm("--filter", "@vykor/server", "check-types"),
            ["node", "scripts/architecture-boundaries.mjs"], pnpm("check:retired-ui"), pnpm("check-docs"),
            ["git", "diff", "--check"]]
    records_path = HERE / "validation.json"
    records = json.loads(records_path.read_text(encoding="utf-8")) if records_path.exists() else []
    for i, command in enumerate(commands, 1):
        if len(sys.argv) > 2 and i < int(sys.argv[2]):
            continue
        name = f"{phase}-{i}"
        attempt = 1
        while (HERE / (name + ".txt")).exists():
            attempt += 1
            name = f"{phase}-{i}-rerun-{attempt}"
        print(name, " ".join(command), flush=True)
        env = dict(os.environ, NO_COLOR="1")
        env.pop("FORCE_COLOR", None)
        result = subprocess.run(command, cwd=ROOT, capture_output=True, env=env)
        output = result.stdout + result.stderr
        log = HERE / (name + ".txt")
        log.write_bytes(output)
        records.append({"phase": phase, "step": i, "command": command, "cwd": str(ROOT),
                        "exitCode": result.returncode, "log": log.name})
        records_path.write_text(json.dumps(records, indent=2) + "\n", encoding="utf-8", newline="\n")
        print(output.decode("utf-8", errors="replace")[-2200:], flush=True)
        if phase.endswith("-red"):
            assert result.returncode != 0, "New regression cases did not fail"
        elif result.returncode:
            sys.exit(result.returncode)


if __name__ == "__main__":
    main()
