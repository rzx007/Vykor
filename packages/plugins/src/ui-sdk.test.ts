import { MessageChannel } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import { createPluginUiClient } from "./ui-sdk.js";

const mountId = "20000000-0000-4000-8000-000000000001";
const instanceId = "10000000-0000-4000-8000-000000000001";
const snapshot = {
  instanceId, revision: 1, status: "open", data: { count: 1 },
  actions: [{ id: "apply", label: "应用", completion: "keep-open" }],
  readOnly: false, theme: "light", locale: "zh-CN", surface: "tool-result",
};
const cleanup: Array<() => void> = [];
afterEach(() => { cleanup.splice(0).forEach(fn => fn()); vi.unstubAllGlobals(); vi.useRealTimers(); });

function setup() {
  const ready: unknown[] = [];
  const parent = { postMessage: (value: unknown) => ready.push(value) };
  const child = Object.assign(new EventTarget(), { parent });
  vi.stubGlobal("window", child);
  const channel = new MessageChannel();
  cleanup.push(() => { channel.port1.close(); channel.port2.close(); });
  const messages: Array<Record<string, any>> = [];
  channel.port2.on("message", data => messages.push(JSON.parse(data)));
  const init = (source: unknown = parent) => child.dispatchEvent(Object.assign(new Event("message"), {
    source, data: { version: 1, type: "plugin-ui-init", mountId }, ports: [channel.port1],
  }));
  const push = (value = snapshot) => channel.port2.postMessage(JSON.stringify({
    version: 1, mountId, type: "snapshot", snapshot: value,
  }));
  const reply = (id: string, result: unknown, idMount = mountId) => channel.port2.postMessage(JSON.stringify({
    version: 1, mountId: idMount, id, result,
  }));
  return { ready, init, push, reply, messages, channel };
}

it("initializes only from the parent and waits for a valid port snapshot", async () => {
  const f = setup();
  const pending = createPluginUiClient();
  expect(f.ready).toEqual([{ version: 1, type: "plugin-ui-ready" }]);
  let initialized = false;
  void pending.then(() => { initialized = true; });
  f.init({});
  f.push();
  await new Promise(resolve => setTimeout(resolve, 5));
  expect(initialized).toBe(false);
  f.init();
  f.push();
  const client = await pending;
  cleanup.push(() => client.dispose());
  const reading = client.getSnapshot();
  await vi.waitFor(() => expect(f.messages).toHaveLength(1));
  f.reply(f.messages[0]!.id, snapshot);
  expect((await reading).data).toEqual({ count: 1 });
});

it("captures revision/args, accepts only its own response and returns the durable receipt", async () => {
  const f = setup(); const initializing = createPluginUiClient(); f.init(); f.push();
  const client = await initializing; cleanup.push(() => client.dispose());
  const args = { text: "before" };
  const action = client.requestAction("apply", args);
  args.text = "after";
  await vi.waitFor(() => expect(f.messages).toHaveLength(1));
  expect(f.messages[0]!.params).toEqual({ actionId: "apply", args: { text: "before" }, expectedRevision: 1 });
  const receipt = { requestId: "30000000-0000-4000-8000-000000000001", runId: "ui_run_test", instanceId, revision: 2, status: "pending" };
  f.reply(f.messages[0]!.id, receipt, "40000000-0000-4000-8000-000000000001");
  let settled = false; void action.then(() => { settled = true; });
  await new Promise(resolve => setTimeout(resolve, 5)); expect(settled).toBe(false);
  f.reply(f.messages[0]!.id, receipt);
  expect(await action).toEqual(receipt);
});

it("ignores older snapshots but applies same-revision theme updates with owned listener data", async () => {
  const f = setup(); const initializing = createPluginUiClient(); f.init(); f.push();
  const client = await initializing; cleanup.push(() => client.dispose());
  const seen: Array<{ revision: number; count: unknown; theme: string }> = [];
  const off = client.onSnapshot(value => {
    seen.push({ revision: value.revision, count: value.data.count, theme: value.theme });
    value.data.count = 999;
  });
  f.push({ ...snapshot, revision: 2, data: { count: 2 } });
  f.push({ ...snapshot, revision: 1, data: { count: 0 } });
  f.push({ ...snapshot, revision: 2, data: { count: 2 }, theme: "dark" });
  await vi.waitFor(() => expect(seen).toHaveLength(3));
  expect(seen).toEqual([
    { revision: 1, count: 1, theme: "light" }, { revision: 2, count: 2, theme: "light" }, { revision: 2, count: 2, theme: "dark" },
  ]);
  off();
});

it("blocks readonly/invalid actions and rejects pending requests on disposal", async () => {
  const f = setup(); const initializing = createPluginUiClient(); f.init(); f.push({ ...snapshot, readOnly: true });
  const client = await initializing;
  await expect(client.requestAction("apply", {})).rejects.toMatchObject({ code: "plugin_ui_read_only" });
  await expect(client.resize(Infinity)).rejects.toMatchObject({ code: "plugin_ui_invalid_message" });
  expect(f.messages).toEqual([]);
  const pending = client.getSnapshot();
  const rejection = expect(pending).rejects.toMatchObject({ code: "plugin_ui_mount_closed" });
  client.dispose();
  await rejection;
  await expect(client.getSnapshot()).rejects.toMatchObject({ code: "plugin_ui_mount_closed" });
});

it("rejects initialization after the fixed handshake deadline", async () => {
  vi.useFakeTimers();
  const f = setup(); const pending = createPluginUiClient();
  const rejection = expect(pending).rejects.toMatchObject({ code: "plugin_ui_load_timeout" });
  await vi.advanceTimersByTimeAsync(10_000);
  await rejection;
  f.init(); f.push();
});

it("rejects non-JSON args before a message is sent", async () => {
  const f = setup(); const initializing = createPluginUiClient(); f.init(); f.push();
  const client = await initializing; cleanup.push(() => client.dispose());
  await expect(client.requestAction("apply", { n: NaN })).rejects.toMatchObject({ code: "plugin_ui_invalid_message" });
  expect(f.messages).toEqual([]);
});

it("bounds pending requests and clears every one on disposal", async () => {
  const f = setup(); const initializing = createPluginUiClient(); f.init(); f.push();
  const client = await initializing;
  const requests = Array.from({ length: 16 }, () => client.getSnapshot().catch(error => error.code));
  await expect(client.getSnapshot()).rejects.toMatchObject({ code: "plugin_ui_rate_limited" });
  client.dispose();
  expect(await Promise.all(requests)).toEqual(Array(16).fill("plugin_ui_mount_closed"));
});

it("expires an ordinary request without resending after a late response", async () => {
  const f = setup(); const initializing = createPluginUiClient(); f.init(); f.push();
  const client = await initializing; cleanup.push(() => client.dispose());
  vi.useFakeTimers();
  const pending = client.getSnapshot();
  const rejection = expect(pending).rejects.toMatchObject({ code: "plugin_ui_request_timeout" });
  await vi.advanceTimersByTimeAsync(30_000);
  await rejection;
  vi.useRealTimers();
  await vi.waitFor(() => expect(f.messages).toHaveLength(1));
  f.reply(f.messages[0]!.id, snapshot);
  await new Promise(resolve => setTimeout(resolve, 5));
  expect(f.messages).toHaveLength(1);
});
