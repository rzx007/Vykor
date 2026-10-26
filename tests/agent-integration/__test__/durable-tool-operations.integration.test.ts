import { fork, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { SessionStore } from "../../../packages/services/src/session-runtime/store.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const workerPath = fileURLToPath(new URL("./fixtures/s1-tool-operation-worker.ts", import.meta.url));
const loader = pathToFileURL(join(root, "apps/cli/node_modules/tsx/dist/loader.mjs")).href;

function pauseWorker(databasePath: string, effectsPath: string, phase: string): Promise<ChildProcess> {
  return new Promise((resolveWorker, reject) => {
    const worker = fork(workerPath, [databasePath, effectsPath, phase], {
      cwd: root, execArgv: ["--import", loader], stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    let errors = "";
    worker.stderr!.on("data", chunk => { errors += String(chunk); });
    const fail = (error: Error) => {
      clearTimeout(timeout);
      if (worker.exitCode !== null || worker.signalCode !== null) { reject(error); return; }
      worker.once("exit", () => reject(error));
      worker.kill("SIGKILL");
    };
    const timeout = setTimeout(() => {
      fail(new Error(`worker did not reach ${phase}: ${errors}`));
    }, 30_000);
    worker.once("message", (message: any) => {
      clearTimeout(timeout);
      if (message.error) fail(new Error(message.error));
      else if (message.phase === phase) resolveWorker(worker);
      else fail(new Error("Unexpected worker phase"));
    });
    worker.once("error", error => { clearTimeout(timeout); reject(error); });
    worker.once("exit", code => {
      clearTimeout(timeout);
      if (code !== null && code !== 0) reject(new Error(`worker exited ${code}: ${errors}`));
    });
  });
}

async function killWorker(worker: ChildProcess): Promise<void> {
  await new Promise<void>((resolveExit, reject) => {
    worker.once("exit", () => resolveExit());
    worker.once("error", reject);
    worker.kill("SIGKILL");
  });
}

describe("S1 tool operation safety across real process termination", () => {
  it.each(["dispatch", "applied", "confirmed"])("preserves the %s crash window without repeating effects", async phase => {
    const dir = mkdtempSync(join(tmpdir(), "vykor-s1-crash-"));
    const databasePath = join(dir, "session.db");
    const effectsPath = join(dir, "external-effects.txt");
    let store: SessionStore | undefined;
    let worker: ChildProcess | undefined;
    try {
      worker = await pauseWorker(databasePath, effectsPath, phase);
      await killWorker(worker);
      worker = undefined;
      store = new SessionStore({ path: databasePath });
      store.acquireApplicationOwner({ ownerId: "recovery-owner", pid: process.pid, staleAfterMs: 60_000,
        canTakeOver: () => true });
      store.toolOperations.recoverDispatching();
      const operations = store.toolOperations.list({ sessionId: "crash-session" });
      expect(operations).toHaveLength(1);
      const operation = operations[0]!;
      expect(operation.state).toBe(phase === "confirmed" ? "confirmed" : "unknown");
      expect(store.toolOperations.listAttempts(operation.id)).toHaveLength(1);
      if (phase !== "dispatch") expect(readFileSync(effectsPath, "utf8").trim().split("\n")).toEqual([operation.id]);
      else expect(existsSync(effectsPath)).toBe(false);
      if (phase === "confirmed") expect(operation.result?.content).toEqual([{ type: "text", text: "saved" }]);
      else {
        const intent = {
          scope: { agentId: "crash-session", sessionId: "crash-session", runId: "crash-run", inputId: "crash-input",
            cwd: root, traceId: "recovery-trace", signal: new AbortController().signal },
          toolUse: { type: "tool_use" as const, id: "crash-call", name: "ExternalWrite", input: { text: "saved" } },
          toolIdentity: "fixture/external-write@1",
        };
        const ticket = store.toolOperations.prepare(intent);
        expect(() => store!.toolOperations.dispatch({ intent, operation: ticket,
          policyVersion: "fixture-policy-v1", ownerId: "recovery-owner" })).toThrow();
        expect(store.toolOperations.listAttempts(operation.id)).toHaveLength(1);
        if (phase === "applied") {
          // This independent effect record is the test system's authoritative read-only lookup.
          const evidence = readFileSync(effectsPath, "utf8").trim();
          const confirmed = store.toolOperations.reconcile({ operationId: operation.id, expectedRevision: ticket.revision,
            outcome: "applied", evidence, result: { operationId: operation.id, toolUseId: "crash-call",
              toolName: "ExternalWrite", toolAttemptId: operation.activeAttemptId,
              content: [{ type: "text", text: "saved" }], executionState: "completed" } });
          expect(confirmed.state).toBe("confirmed");
          expect(store.toolOperations.prepare(intent).result?.content).toEqual([{ type: "text", text: "saved" }]);
          expect(readFileSync(effectsPath, "utf8").trim().split("\n")).toEqual([operation.id]);
        }
      }
    } finally {
      if (worker && worker.exitCode === null) await killWorker(worker);
      store?.close();
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});
