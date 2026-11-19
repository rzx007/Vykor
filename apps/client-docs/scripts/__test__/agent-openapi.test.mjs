import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { CURRENT_PROTOCOL_VERSION, VykorClient } from "@rzx/client";

const documentUrl = new URL("../../public/agent-openapi.json", import.meta.url);
const contractUrl = new URL("../../../../scripts/client-public-api-contract.json", import.meta.url);
const sessionId = "session/1";
const assetId = "asset/1";
const requestId = "request/1";
const target = { kind: "agent", jobId: "job/1", runId: "run/1" };
const items = [{ type: "text", text: "Continue" }];
const pathValues = { sessionId, assetId, requestId, runId: target.runId, jobId: target.jobId,
  inputId: "input/1", messageId: "message/1", partId: "part/1", goalId: "goal/1" };

const argumentsByMethod = {
  protocol: { capabilities: [], health: [] },
  runtime: {
    listModels: [], listAgentPersonas: [], listSkills: [], getSessionMcp: [sessionId],
  },
  sessions: {
    list: [{ cwd: "/work", includeArchived: true, includeChildren: true, limit: 10 }],
    search: [{ query: "needle", limit: 10 }], get: [sessionId],
    create: [{ cwd: "/work", model: "model" }], update: [sessionId, { title: "Renamed" }],
    fork: [sessionId, {}], archive: [sessionId], delete: [sessionId],
    getState: [sessionId, { partView: "summary" }],
    listMessages: [sessionId, { cursor: 1, afterSeq: 1, limit: 10 }],
    listMessageParts: [sessionId, { cursor: 1, afterSeq: 1, limit: 10, partView: "summary", messageId: "message/1" }],
    getMessagePart: [sessionId, "message/1", "part/1"],
    admitPrompt: [sessionId, { id: "input/1", items, delivery: "steer", expectedActiveRunId: "run/1", outputSchema: { type: "object" } }],
    editLatestPrompt: [sessionId, { id: "input/1", sourceMessageId: "message/1", items }],
    promoteQueuedPrompt: [sessionId, "input/1", { queuedRunId: "run/2", expectedActiveRunId: "run/1" }],
    cancelQueuedPrompt: [sessionId, "input/1", { queuedRunId: "run/2" }],
    resumeInterruptedRun: [sessionId, "run/1", { id: "input/2" }],
    interrupt: [sessionId, { expectedRunId: "run/1", source: "user" }],
    compact: [sessionId], rewind: [sessionId, { count: 1 }], remember: [sessionId],
    export: [sessionId, { json: true, filename: "session.json" }], getUsage: [sessionId],
    getGoal: [sessionId], createGoal: [sessionId, { requestId, objective: "Build" }],
    updateGoal: [sessionId, "goal/1", { requestId, expectedRevision: 1, objective: "Build again" }],
    applyGoalAction: [sessionId, "goal/1", { requestId, action: "pause", expectedRevision: 1 }],
  },
  permissions: {
    list: [{ sessionId, status: "pending", toolName: "AskUser", limit: 5 }], listApprovals: [],
    reply: [requestId, { status: "approved", decision: "once", answer: "Continue" }], revokeApproval: [requestId],
  },
  attachments: {
    upload: [{ displayName: "example.txt", mediaType: "text/plain", body: new Uint8Array([1]) }],
    get: [assetId], download: [assetId, { range: { start: 0, end: 0 } }], delete: [assetId],
  },
  jobs: {
    list: [{ sessionId, kinds: ["agent", "shell"], statuses: ["running"], includeFinished: false, limit: 5 }],
    createBackgroundShell: [{ sessionId, command: "echo ok" }],
    read: [target, { sessionId, after: 1, maxChars: 20 }],
    wait: [target, { sessionId, timeoutMs: 10, after: 1, maxChars: 20 }],
    send: [target, { sessionId, data: "Continue" }], cancel: [target, { sessionId, reason: "Stop" }],
  },
  events: {
    list: [{ sessionId, cursor: 1, afterSeq: 1, limit: 10, partView: "summary" }],
    stream: [{ sessionId, cursor: 1, partView: "summary" }],
  },
  files: {
    list: [sessionId, { path: ".", limit: 5 }], stat: [sessionId, "README.md"],
    readText: [sessionId, "README.md", { maxBytes: 10 }],
    find: [sessionId, { pattern: "*.md", path: ".", limit: 5 }],
    search: [sessionId, { query: "test", include: "*.md", path: ".", limit: 5, caseSensitive: false }],
  },
};

const loadJson = async url => JSON.parse(await readFile(url, "utf8"));
const resolveRef = (document, value) => value.$ref
  ? value.$ref.slice(2).split("/").reduce((parent, key) => parent[key], document) : value;

test("OpenAPI covers the actual requests of every public SDK resource method", async () => {
  const document = await loadJson(documentUrl);
  const { resourceMethods } = await loadJson(contractUrl);
  const operations = new Map(Object.entries(document.paths).flatMap(([path, methods]) =>
    Object.entries(methods).map(([verb, operation]) => [operation.operationId, { path, verb, operation }])));

  assert.equal(document.openapi, "3.1.0");
  assert.equal(document["x-vykor-protocol-version"], CURRENT_PROTOCOL_VERSION);
  assert.deepEqual(Object.keys(argumentsByMethod).sort(), Object.keys(resourceMethods).sort());
  assert.deepEqual([...operations.keys()].sort(), Object.entries(resourceMethods)
    .flatMap(([resource, methods]) => methods.map(method => `${resource}.${method}`)).sort());
  assert.equal(operations.size, Object.values(document.paths).reduce((total, methods) => total + Object.keys(methods).length, 0));

  for (const [resource, methods] of Object.entries(resourceMethods)) {
    assert.deepEqual(Object.keys(argumentsByMethod[resource]).sort(), [...methods].sort());
    for (const method of methods) {
      const id = `${resource}.${method}`;
      const { verb, path, operation } = operations.get(id);
      const calls = [];
      const client = new VykorClient({
        baseUrl: "http://daemon.test", token: "example-token",
        fetch: async (url, init) => {
          const request = new Request(url, init);
          calls.push(request);
          if (new URL(request.url).pathname === "/capabilities") {
            return Response.json({ serverVersion: "test", protocol: { version: CURRENT_PROTOCOL_VERSION }, features: { steer: 2, structuredDelivery: 1 } });
          }
          return Response.json({ error: "stop after recording the request" }, { status: 400 });
        },
      });
      const invoke = async () => {
        const result = client[resource][method](...argumentsByMethod[resource][method]);
        if (result[Symbol.asyncIterator]) await result[Symbol.asyncIterator]().next();
        else await result;
      };
      if (id === "protocol.capabilities") await invoke();
      else await assert.rejects(invoke, error => error.status === 400, id);

      const request = calls.at(-1);
      const url = new URL(request.url);
      const pathParams = [...path.matchAll(/\{([^}]+)\}/g)].map(([, name]) => name);
      const expectedPath = path.replaceAll(/\{([^}]+)\}/g, (_, name) => {
        assert.ok(pathValues[name], `Unknown path parameter ${name}`);
        return encodeURIComponent(pathValues[name]);
      });
      assert.equal(url.pathname, expectedPath, id);
      assert.equal(request.method, verb.toUpperCase(), id);

      const parameters = (operation.parameters ?? []).map(value => resolveRef(document, value));
      assert.deepEqual(parameters.filter(parameter => parameter.in === "path").map(parameter => parameter.name).sort(), pathParams.sort(), id);
      for (const name of url.searchParams.keys()) assert.ok(parameters.some(parameter => parameter.in === "query" && parameter.name === name), `${id} query ${name}`);
      for (const parameter of parameters.filter(value => value.in === "query" && value.required)) assert.ok(url.searchParams.has(parameter.name), `${id} requires ${parameter.name}`);
      for (const parameter of parameters.filter(value => value.in === "header" && value.required)) assert.ok(request.headers.has(parameter.name), `${id} requires ${parameter.name}`);

      if (resource === "protocol") {
        assert.deepEqual(operation.security, [], id);
        assert.deepEqual(calls.map(value => new URL(value.url).pathname), [expectedPath], id);
        assert.equal(request.headers.has("authorization"), false, id);
        assert.equal(request.headers.has("x-vykor-protocol-version"), false, id);
      } else {
        assert.deepEqual(operation.security ?? document.security, [{ bearerAuth: [] }], id);
        assert.equal(request.headers.get("authorization"), "Bearer example-token", id);
        assert.equal(request.headers.get("x-vykor-protocol-version"), String(CURRENT_PROTOCOL_VERSION), id);
        const protocolHeader = parameters.find(parameter => parameter.name === "x-vykor-protocol-version");
        assert.equal(protocolHeader?.required, true, id);
        assert.equal(protocolHeader.schema.const, String(CURRENT_PROTOCOL_VERSION), id);
        assert.ok(operation.responses[426], id);
        assert.equal(new URL(calls[0].url).pathname, "/capabilities", id);
      }

      if (request.headers.get("content-type") === "application/json") {
        const body = await request.json();
        const schema = resolveRef(document, operation.requestBody.content["application/json"].schema);
        for (const name of Object.keys(body)) assert.ok(Object.hasOwn(schema.properties, name), `${id} body ${name}`);
        for (const name of schema.required ?? []) assert.ok(Object.hasOwn(body, name), `${id} requires body property ${name}`);
        if (id === "permissions.reply") assert.equal(body.answer, "Continue");
      }
      assert.ok(Object.keys(operation.responses).some(code => /^2\d\d$/.test(code)), id);
    }
  }
});

test("OpenAPI keeps event replay, replies and public projections explicit", async () => {
  const document = await loadJson(documentUrl);
  const stream = document.paths["/events/stream"].get;
  assert.ok(stream.responses[200].content["text/event-stream"]);
  assert.ok(stream.parameters.map(value => resolveRef(document, value)).some(value => value.in === "header" && value.name === "Last-Event-ID"));
  const reply = document.paths["/permissions/{requestId}/reply"].post;
  assert.equal(resolveRef(document, reply.requestBody.content["application/json"].schema).properties.answer.type, "string");
  assert.ok(reply.responses[409]);
  const prompt = document.paths["/sessions/{sessionId}/prompts"].post;
  assert.ok(prompt.responses[409]);
  assert.ok(!Object.hasOwn(resolveRef(document, prompt.requestBody.content["application/json"].schema).properties, "pluginAppContexts"));
  assert.ok(!Object.hasOwn(document.components.schemas.SessionSnapshot.properties, "pluginApps"));
  for (const status of [200, 206, 304, 416]) assert.ok(document.paths["/attachments/{assetId}/content"].get.responses[status]);

  const references = value => {
    if (value === null || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (key === "$ref") {
        assert.ok(child.startsWith("#/components/"), `Non-local reference ${child}`);
        assert.ok(resolveRef(document, value), `Unresolved reference ${child}`);
      } else references(child);
    }
  };
  references(document);
});
