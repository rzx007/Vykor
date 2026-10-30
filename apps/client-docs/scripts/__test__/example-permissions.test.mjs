import assert from "node:assert/strict";
import test from "node:test";
import { CURRENT_PROTOCOL_VERSION, VykorApiError } from "@rzx/client";

// Import the actual runnable example and keep the published SDK implementation.
// Only HTTP/SSE cross the fake boundary: no daemon, provider or real network runs.
function exampleDaemon(context, replyStatus = 200) {
  const session = {
    id: "session-example", cwd: "/example", title: "Example", model: "configured-model",
    status: "idle", metadata: {}, createdAt: 1, updatedAt: 1,
  };
  const run = {
    id: "run-example", sessionId: session.id, inputId: "input-example", status: "running",
    metadata: {}, createdAt: 1, startedAt: 1, updatedAt: 1,
  };
  const request = {
    id: "permission-example", sessionId: session.id, runId: run.id, toolName: "Read",
    status: "pending", payload: {}, createdAt: 2, updatedAt: 2,
  };
  const snapshot = {
    cursor: 1, session, inputs: [], runs: [run], attempts: [], tasks: [],
    permissions: [], messages: [], parts: [],
  };
  const event = (seq, type, payload) => ({
    id: `event-${seq}`, seq, type, schemaVersion: 1,
    sessionId: session.id, payload, createdAt: seq,
  });
  const frame = events => new TextEncoder().encode(events.map(value => `data: ${JSON.stringify(value)}\n\n`).join(""));
  const calls = { replies: [], interrupts: [], openStreams: 0 };
  const logs = [];
  context.mock.method(console, "log", (...values) => logs.push(values));

  const env = {
    VYKOR_BASE_URL: "http://example-daemon.invalid", VYKOR_TOKEN: "test-only-token",
    VYKOR_MODEL: "configured-model", VYKOR_DAEMON_CWD: "/example",
  };
  const previousEnv = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  const previousExitCode = process.exitCode;
  Object.assign(process.env, env);
  context.after(() => {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    process.exitCode = previousExitCode;
  });

  context.mock.method(globalThis, "fetch", async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "http://example-daemon.invalid");
    const method = init?.method ?? "GET";
    if (url.pathname === "/capabilities") {
      return Response.json({ serverVersion: "test", protocol: { version: CURRENT_PROTOCOL_VERSION }, features: {} });
    }
    if (url.pathname === "/sessions" && method === "POST") return Response.json({ session });
    if (url.pathname === `/sessions/${session.id}/state`) return Response.json(snapshot);
    if (url.pathname === `/sessions/${session.id}/prompts` && method === "POST") {
      const prompt = JSON.parse(init.body);
      return Response.json({
        input: {
          id: prompt.id, sessionId: session.id, seq: 1, delivery: "queue", items: prompt.items,
          content: prompt.items[0].text, attachments: [], metadata: {}, createdAt: 1,
        },
        run, queue_state: "running",
      });
    }
    if (url.pathname === `/permissions/${request.id}/reply` && method === "POST") {
      calls.replies.push(JSON.parse(init.body));
      // The server refuses a second reply even before permission.replied reaches SSE.
      const status = calls.replies.length > 1 ? 409 : replyStatus;
      return status === 200
        ? Response.json({ request: { ...request, status: "denied", updatedAt: 4 } })
        : Response.json({ error: status === 409 ? "Permission request already resolved" : "Permission service failed" }, { status });
    }
    if (url.pathname === `/sessions/${session.id}/interrupt` && method === "POST") {
      calls.interrupts.push(JSON.parse(init.body));
      return Response.json({ session, interrupted: true });
    }
    if (url.pathname === "/events/stream") {
      let closed = false;
      let tail;
      let onAbort;
      const finish = () => {
        if (closed) return;
        closed = true;
        clearImmediate(tail);
        init.signal.removeEventListener("abort", onAbort);
        calls.openStreams -= 1;
      };
      return new Response(new ReadableStream({
        start(controller) {
          calls.openStreams += 1;
          onAbort = () => {
            if (closed) return;
            finish();
            controller.error(new DOMException("Aborted", "AbortError"));
          };
          init.signal.addEventListener("abort", onAbort, { once: true });
          controller.enqueue(frame([
            event(2, "permission.asked", { request }),
            event(3, "session.updated", { session: { ...session, updatedAt: 3 } }),
          ]));
          // Drain the two preceding events before releasing the reply/completion.
          // Both SDK observers see the same pending request during this interval.
          tail = setImmediate(() => {
            if (closed) return;
            controller.enqueue(frame([
              event(4, "permission.replied", { request: { ...request, status: "denied", updatedAt: 4 } }),
              event(5, "session.run.updated", { run: { ...run, status: "completed", finishedAt: 5, updatedAt: 5 } }),
            ]));
          });
        },
        cancel: finish,
      }), { headers: { "content-type": "text/event-stream" } });
    }
    throw new Error(`Unexpected request: ${method} ${url.pathname}`);
  });

  return {
    calls,
    logs,
    run: () => import(new URL(`../../examples/node/run-with-permissions.ts?case=${replyStatus}`, import.meta.url)),
  };
}

test("the runnable example replies once while the pending permission remains in unrelated updates", async context => {
  const daemon = exampleDaemon(context);
  await daemon.run();
  assert.deepEqual(daemon.calls.replies, [{ status: "denied" }]);
  assert.deepEqual(daemon.calls.interrupts, [], "A successful reply must not interrupt the normal Run");
  assert.ok(daemon.logs.some(values => values[0] === "Run 终态:" && values[1] === "completed"));
  assert.equal(daemon.calls.openStreams, 0, "Both example subscriptions must close");
});

test("a permission already answered by another client does not interrupt the normal Run", async context => {
  const daemon = exampleDaemon(context, 409);
  await daemon.run();
  assert.deepEqual(daemon.calls.replies, [{ status: "denied" }]);
  assert.deepEqual(daemon.calls.interrupts, []);
  assert.ok(daemon.logs.some(values => values[0] === "Run 终态:" && values[1] === "completed"));
  assert.equal(daemon.calls.openStreams, 0);
});

test("a real permission reply failure still interrupts the unfinished Run", async context => {
  const daemon = exampleDaemon(context, 500);
  await assert.rejects(daemon.run(), error => error instanceof VykorApiError && error.status === 500);
  assert.deepEqual(daemon.calls.replies, [{ status: "denied" }]);
  assert.deepEqual(daemon.calls.interrupts, [{ expectedRunId: "run-example" }]);
  assert.equal(daemon.calls.openStreams, 0);
});
