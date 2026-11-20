import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  CURRENT_PROTOCOL_VERSION, VykorClient, selectSessionPermissions, syncEvents, waitForRun,
} from "@rzx/client";

const model = "packed-test-model";
const provider = "packed-test-provider";
const key = "isolated-provider-fixture";
const answer = "continue with the packed client";
const resultText = "packed client received the answer";
const writeToolId = "call_packed_write";
const questionToolId = "call_packed_question";
const stopText = "hold this packed request until stopped";
const timeout = AbortSignal.timeout(60_000);

const blockingRequest = deferred();
const blockingConnectionClosed = deferred();
const failedProvider = deferred();
void failedProvider.promise.catch(() => {});
let requests = 0;

const server = createServer(async (request, response) => {
  try {
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/v1/chat/completions");
    assert.equal(request.headers.authorization, "Bearer " + key);
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const { messages, tools, model: requestedModel, stream } = JSON.parse(Buffer.concat(chunks));
    assert.equal(requestedModel, model);
    assert.equal(stream, true);
    assert.ok(!tools.some(tool => ["Browser", "BrowserDeveloper"].includes(tool.function?.name)),
      "CLI must keep browser tools out of a standalone daemon's model catalog");
    requests++;
    const latest = messages.at(-1);
    const frame = (delta, finish = null) => ({
      id: "chatcmpl-packed-" + requests, object: "chat.completion.chunk", created: 0, model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    });
    const call = (id, name, args) => {
      assert.ok(tools.some(tool => tool.function?.name === name), "CLI must offer " + name);
      return frame({ tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
    };
    response.setHeader("content-type", "text/event-stream");
    if (latest?.role === "user" && JSON.stringify(latest.content).includes(stopText)) {
      response.write("data: " + JSON.stringify(frame({ role: "assistant", content: "stoppable" })) + "\n\n");
      response.once("close", () => blockingConnectionClosed.resolve());
      blockingRequest.resolve();
      return;
    }
    let output;
    if (requests === 1) {
      output = [call(writeToolId, "Write", { file_path: join(workspace, "approved.txt"), content: "written after approval\n" }), frame({}, "tool_calls")];
    } else if (requests === 2) {
      assert.equal(latest?.tool_call_id, writeToolId);
      output = [call(questionToolId, "AskUser", { question: "Should the packed run continue?" }), frame({}, "tool_calls")];
    } else {
      assert.equal(requests, 3);
      assert.equal(latest?.tool_call_id, questionToolId);
      assert.ok(JSON.stringify(latest.content).includes(answer), "the answer must reach the model as a tool result");
      output = [frame({ content: resultText }), frame({}, "stop")];
    }
    response.end([frame({ role: "assistant" }), ...output]
      .map(chunk => "data: " + JSON.stringify(chunk) + "\n\n").join("") + "data: [DONE]\n\n");
  } catch (error) {
    failedProvider.reject(error);
    response.destroy();
  }
});

const require = createRequire(import.meta.url);
const cliManifestPath = require.resolve("@rzx/ohs/package.json");
const cliManifest = require(cliManifestPath);
assert.equal(cliManifest.name, "@rzx/ohs");
assert.ok(Object.keys(cliManifest.dependencies).every(name => !name.startsWith("@vykor/")));
const cli = resolve(dirname(cliManifestPath), cliManifest.bin.vk);
const dataRoot = resolve("data-root");
const workspace = resolve("workspace");
const isolatedHome = resolve("home");
for (const directory of [dataRoot, workspace, isolatedHome]) await mkdir(directory);

let daemon;
let exited;
let diagnostics = "";
const subscriptions = [];
try {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  await writeFile(join(dataRoot, "settings.json"), JSON.stringify({
    provider, model, apiFormat: "openai",
    customProviders: [{
      id: provider, displayName: "Packed fixture", apiFormat: "openai",
      baseUrl: "http://127.0.0.1:" + server.address().port + "/v1",
      models: [{ id: model, displayName: model }],
    }],
    permission: { mode: "default" },
    plugins: { enabled: false },
    memory: { enabled: false, sessionMemoryEnabled: false, autoExtractEnabled: false, autoDreamEnabled: false },
  }));
  await writeFile(join(dataRoot, "credentials.json"), JSON.stringify({ [provider]: { api_key: key } }));
  const token = randomUUID();
  const host = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|TMPDIR)$/i.test(name)));
  // Home overrides are local to the owned child. Never read the caller's profiles or data-root selector.
  daemon = spawn(process.execPath, [
    cli, "--data-root", dataRoot, "serve", "--host", "127.0.0.1", "--port", "0", "--token", token,
  ], {
    cwd: workspace, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...host, HOME: isolatedHome, USERPROFILE: isolatedHome, APPDATA: isolatedHome, LOCALAPPDATA: isolatedHome,
      XDG_CONFIG_HOME: isolatedHome, XDG_DATA_HOME: isolatedHome, VYKOR_DISABLE_MODELS_FETCH: "1",
    },
  });
  exited = once(daemon, "exit");
  void exited.catch(() => {});
  const listening = deferred();
  let stdout = "";
  daemon.stdout.on("data", chunk => {
    stdout = (stdout + chunk).slice(-8192);
    const url = stdout.match(/\[daemon\] listening (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
    if (url) listening.resolve(url);
  });
  daemon.stderr.on("data", chunk => { diagnostics = (diagnostics + chunk).slice(-8192); });
  const baseUrl = await Promise.race([
    listening.promise,
    exited.then(([code, signal]) => { throw new Error("Installed CLI exited before listening (" + (code ?? signal) + ")"); }),
    aborts(timeout),
  ]);
  await Promise.race([exercise(baseUrl, token), failedProvider.promise, aborts(timeout)]);
  console.log("installed CLI + independent SDK: idempotence, approval, question, reconnect, transcript and targeted stop ok");
} catch (error) {
  if (diagnostics) console.error(diagnostics);
  throw error;
} finally {
  for (const controller of subscriptions) controller.abort();
  if (daemon?.pid) {
    daemon.kill();
    const stopped = await Promise.race([exited.then(() => true), delay(3000, false, { ref: false })]);
    if (!stopped) {
      daemon.kill("SIGKILL");
      await exited;
    }
  }
  if (server.listening) {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function aborts(signal) {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

function subscription(client, sessionId) {
  const controller = new AbortController();
  subscriptions.push(controller);
  const updates = syncEvents(client, { sessionId, signal: AbortSignal.any([controller.signal, timeout]) });
  return {
    stop: async () => { controller.abort(); await updates.return(); },
    until: async (predicate) => {
      for (;;) {
        const { done, value } = await updates.next();
        assert.ok(!done, "the SDK subscription ended before the expected update");
        const result = predicate(value);
        if (result) return result;
      }
    },
  };
}

async function exercise(baseUrl, token) {
  const first = new VykorClient({ baseUrl, token });
  const second = new VykorClient({ baseUrl, token });
  const capabilities = await first.protocol.capabilities();
  assert.equal(capabilities.protocol.version, CURRENT_PROTOCOL_VERSION);
  assert.equal(capabilities.features.browserBridge, undefined);
  const browserHost = await fetch(baseUrl + "/browser-host/stream", {
    headers: { authorization: `Bearer ${token}`, "x-vykor-protocol-version": String(CURRENT_PROTOCOL_VERSION) },
    signal: timeout,
  });
  await browserHost.body?.cancel();
  assert.equal(browserHost.status, 404);
  const models = await first.runtime.listModels();
  assert.ok(models.some(item => item.models.some(entry => entry.id === model)), "CLI must expose its configured model");
  const session = await first.sessions.create({
    cwd: workspace, model, metadata: { runtime: { model, provider, approvalMode: "ask" } },
  });
  const observation = subscription(first, session.id);
  await observation.until(update => update.source === "snapshot");
  const prompt = { id: "packed-stable-input", items: [{ type: "text", text: "Please write one file and ask for a decision." }] };
  const admitted = await first.sessions.admitPrompt(session.id, prompt);
  assert.ok(admitted.run?.id);
  const runId = admitted.run.id;
  const duplicate = await first.sessions.admitPrompt(session.id, prompt);
  assert.equal(duplicate.input.id, admitted.input.id);
  assert.equal(duplicate.run?.id, runId);
  await assert.rejects(first.sessions.admitPrompt(session.id, {
    ...prompt, items: [{ type: "text", text: "Changed content under the same input ID." }],
  }), { status: 409 });

  const permission = await observation.until(update =>
    update.source === "live" && update.event?.type === "permission.asked"
      && selectSessionPermissions(update.state.buckets[session.id]).find(item => item.status === "pending" && item.toolName === "Write"));
  assert.equal(permission.runId, runId);
  await observation.stop();

  const reattached = subscription(second, session.id);
  const snapshot = await reattached.until(update => update.source === "snapshot" && update.state);
  assert.equal(snapshot.buckets[session.id].runs[runId].status, "running");
  assert.equal(selectSessionPermissions(snapshot.buckets[session.id]).find(item => item.status === "pending")?.id, permission.id);
  await assert.rejects(readFile(join(workspace, "approved.txt")), { code: "ENOENT" });
  assert.equal((await second.permissions.reply(permission.id, { status: "approved", decision: "once" })).status, "approved");
  const question = await reattached.until(update =>
    update.source === "live" && update.event?.type === "permission.asked"
      && selectSessionPermissions(update.state.buckets[session.id]).find(item => item.status === "pending" && item.toolName === "AskUser"));
  assert.equal(question.runId, runId);
  assert.equal(question.payload.input.kind, "question");
  assert.equal(await readFile(join(workspace, "approved.txt"), "utf8"), "written after approval\n");
  assert.equal((await second.permissions.reply(question.id, { status: "approved", decision: "once", answer })).status, "approved");
  await assert.rejects(first.permissions.reply(question.id, { status: "approved", decision: "once", answer }), { status: 409 });
  await reattached.until(update => update.source === "live" && update.event?.type === "permission.replied"
    && selectSessionPermissions(update.state.buckets[session.id]).some(item => item.id === question.id && item.status === "approved"));
  const completed = await waitForRun(second, { sessionId: session.id, runId, signal: timeout });
  assert.equal(completed.run.status, "completed");
  assert.ok(completed.messages.some(({ parts }) => parts.some(part => part.text?.includes(resultText))));
  assert.ok((await first.sessions.getState(session.id)).parts.some(part => part.text?.includes(resultText)));
  await reattached.stop();

  const stoppable = await second.sessions.admitPrompt(session.id, {
    id: "packed-targeted-stop", items: [{ type: "text", text: stopText }],
  });
  assert.ok(stoppable.run?.id);
  await blockingRequest.promise;
  assert.equal((await first.sessions.interrupt(session.id, { expectedRunId: runId })).interrupted, false);
  assert.equal((await first.sessions.getState(session.id)).runs.find(run => run.id === stoppable.run.id)?.status, "running");
  assert.equal((await second.sessions.interrupt(session.id, { expectedRunId: stoppable.run.id })).interrupted, true);
  const interrupted = await waitForRun(first, { sessionId: session.id, runId: stoppable.run.id, signal: timeout });
  assert.equal(interrupted.run.status, "interrupted");
  await blockingConnectionClosed.promise;
  assert.equal(requests, 4);
}
