import { appendFileSync } from "node:fs";
import { SessionStore } from "../../../../packages/services/src/session-runtime/store.js";

const [databasePath, effectsPath, stopAt] = process.argv.slice(2);
const store = new SessionStore({ path: databasePath! });
try {
  store.acquireApplicationOwner({ ownerId: "worker-owner", pid: process.pid, staleAfterMs: 60_000 });
  store.sessions.create({ id: "crash-session", cwd: process.cwd(), model: "offline" });
  store.runs.createRun({ id: "crash-run", sessionId: "crash-session" });
  store.runs.updateRun("crash-run", { status: "running" });
  const intent = {
    scope: { agentId: "crash-session", sessionId: "crash-session", runId: "crash-run",
      inputId: "crash-input", cwd: process.cwd(), traceId: "crash-trace", signal: new AbortController().signal },
    toolUse: { type: "tool_use" as const, id: "crash-call", name: "ExternalWrite", input: { text: "saved" } },
    toolIdentity: "fixture/external-write@1",
  };
  const operation = store.toolOperations.authorize({ intent,
    operation: store.toolOperations.prepare(intent), policyVersion: "fixture-policy-v1" });
  const receipt = store.toolOperations.dispatch({ intent, operation, policyVersion: "fixture-policy-v1", ownerId: "worker-owner" });
  if (stopAt !== "dispatch") appendFileSync(effectsPath!, receipt.operationId + "\n");
  if (stopAt === "confirmed") store.toolOperations.settle({ receipt, result: {
    toolUseId: "crash-call", toolName: "ExternalWrite", toolAttemptId: receipt.toolAttemptId,
    content: [{ type: "text", text: "saved" }], executionState: "completed",
  } });
  process.send?.({ phase: stopAt, receipt });
  setInterval(() => {}, 1000);
} catch (error) {
  process.send?.({ error: String(error) });
  store.close();
  process.exitCode = 1;
}
