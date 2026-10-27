import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { DetachedProcessSupervisor } from "@vykor/execution-node";
import { createProcessJobSource } from "../process-job-source.js";

it("uses supervisor admission for idempotent Shell creation and bounded output", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "process-job-source-"));
  const processes = new DetachedProcessSupervisor(join(cwd, "output"));
  const source = createProcessJobSource({ sessionId: "session", cwd, processes });
  try {
    const input = { sessionId: "session", cwd, requestId: "same", command: `${JSON.stringify(process.execPath)} -e "process.stdout.write('abcdefgh')"`, description: "output", settings: { model: "offline", apiFormat: "openai" as const, maxTurns: 1, permission: { mode: "full_access" as const }, sandbox: { enabled: false } } };
    const [first, second] = await Promise.all([source.backgroundShell.create(input), source.backgroundShell.create(input)]);
    expect(second).toEqual(first);
    expect(processes.listExecutions()).toHaveLength(1);
    await expect(source.backgroundShell.create({ ...input, description: "changed" })).rejects.toThrow(/identity conflict/);
    const target = { kind: "shell", jobId: first.jobId } as const;
    const read = await source.jobs.wait({ sessionId: "session", target, timeoutMs: 5_000, maxChars: 4 });
    expect(read.text).toBe("efgh");
    expect(read.truncated).toBe(true);
    expect(read.snapshot.exitCode).toBe(0);
    expect((await source.jobs.list({ sessionId: "session", kinds: ["agent"] })).jobs).toEqual([]);
  } finally { await processes.aclose(); rmSync(cwd, { recursive: true, force: true }); }
});
