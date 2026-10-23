import { it, expect, vi } from "vitest";
import { createEditorController } from "../editor.ts";
import type { Diagram } from "../../contract.ts";
const doc = (id = "one", revision = 1): Diagram => ({ id, revision, title: id, updatedAt: 1, scene: { elements: [], appState: { viewBackgroundColor: `#00000${revision}` }, files: {} } });
it("coalesces edits behind one in-flight commit and only marks saved after ACK", async () => {
  let finish!: () => void;
  const commit = vi.fn(async input => { await new Promise<void>(r => { finish = r; }); return { ...doc(input.id, input.expectedRevision + 1), scene: input.scene }; });
  const editor = createEditorController({ read: async id => doc(id), commit, onScene: vi.fn(), onState: vi.fn() });
  await editor.open("one"); editor.edit(doc("one", 2).scene);
  editor.edit(doc("one", 3).scene); editor.edit(doc("one", 4).scene);
  expect(commit).toHaveBeenCalledTimes(1); expect(editor.state().dirty).toBe(true);
  finish(); await vi.waitFor(() => expect(commit).toHaveBeenCalledTimes(2));
  expect(commit.mock.calls[1][0].scene).toEqual(doc("one", 4).scene);
  finish(); await editor.flush(); expect(editor.state().dirty).toBe(false);
});
it("keeps a conflicted document draft when visiting another document", async () => {
  const editor = createEditorController({ read: async id => doc(id), commit: async () => { throw new Error("revision_conflict"); }, onScene: vi.fn(), onState: vi.fn() });
  await editor.open("one"); editor.edit(doc("one", 2).scene); await editor.flush().catch(() => {});
  await editor.open("two"); expect(editor.state().document?.id).toBe("two");
  await editor.open("one"); expect(editor.scene()).toEqual(doc("one", 2).scene); expect(editor.state().error).toContain("revision_conflict");
});
it("never silently retries an unknown save result after edits or visibility resume", async () => {
  const commit = vi.fn(async () => { throw new Error("Disconnected"); });
  const editor = createEditorController({ read: async id => doc(id), commit, onScene: vi.fn(), onState: vi.fn() });
  await editor.open("one"); editor.edit(doc("one", 2).scene); await editor.flush().catch(() => {});
  editor.edit(doc("one", 3).scene); editor.resume(); await Promise.resolve();
  expect(commit).toHaveBeenCalledTimes(1); expect(editor.state().dirty).toBe(true);
});

it("retries only a proven unaccepted busy request when the host is available again", async () => {
  let busy = true;
  const commit = vi.fn(async input => { if (busy) throw Object.assign(new Error("busy"), { data: { code: "plugin_app_busy", notAccepted: true } }); return { ...doc(input.id, input.expectedRevision + 1), scene: input.scene }; });
  const editor = createEditorController({ read: async id => doc(id), commit, onScene: vi.fn(), onState: vi.fn() });
  await editor.open("one"); editor.edit(doc("one", 2).scene); await editor.flush().catch(() => {});
  expect(editor.state().dirty).toBe(true); busy = false; editor.resume(); await editor.flush();
  expect(commit).toHaveBeenCalledTimes(2); expect(editor.state().dirty).toBe(false);
});
it("keeps a dirty scene on resource updates and stops autosave on revision conflict", async () => {
  let loaded = doc();
  const editor = createEditorController({ read: async () => loaded, commit: async () => { throw new Error("unknown_result"); }, onScene: vi.fn(), onState: vi.fn() });
  await editor.open("one"); editor.edit(doc("one", 2).scene); await editor.flush().catch(() => {});
  loaded = doc("one", 3); await editor.refresh();
  expect(editor.scene()).toEqual(doc("one", 2).scene); expect(editor.state().dirty).toBe(true); expect(editor.state().error).toContain("草稿已保留");
});

it("keeps edits made to a conflicted document while the next tab is still loading", async () => {
  let finishRead!: (value: Diagram) => void;
  const read = vi.fn(async id => doc(id));
  const editor = createEditorController({ read, commit: async () => { throw new Error("revision_conflict"); }, onScene: vi.fn(), onState: vi.fn() });
  await editor.open("one"); editor.edit(doc("one", 2).scene); await editor.flush().catch(() => {});
  read.mockImplementationOnce(() => new Promise(resolve => { finishRead = resolve; }));
  const switching = editor.open("two");
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  editor.edit(doc("one", 4).scene); finishRead(doc("two")); await switching;
  await editor.open("one"); expect(editor.scene()).toEqual(doc("one", 4).scene);
});

it("coalesces refresh notifications behind one read and follows up with the latest revision", async () => {
  let inFlight = 0, maximum = 0;
  const reads: Array<(value: Diagram) => void> = [];
  const read = vi.fn(async id => doc(id));
  const editor = createEditorController({ read, commit: vi.fn(), onScene: vi.fn(), onState: vi.fn() });
  await editor.open("one");
  read.mockImplementation(id => new Promise<Diagram>(resolve => {
    maximum = Math.max(maximum, ++inFlight);
    reads.push(value => { inFlight--; resolve(value); });
  }));
  const pending = [editor.refresh(), editor.refresh(), editor.refresh(), editor.refresh()];
  expect(read).toHaveBeenCalledTimes(2); expect(maximum).toBe(1);
  reads[0](doc("one", 2));
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(3));
  expect(inFlight).toBe(1); reads[1](doc("one", 4));
  await Promise.all(pending);
  expect(maximum).toBe(1); expect(read).toHaveBeenCalledTimes(3);
  expect(editor.state().document?.revision).toBe(4);
});
it("does not apply an old refresh after switching away and back to the same document", async () => {
  let finishRead!: (value: Diagram) => void;
  const read = vi.fn(async id => doc(id));
  const onScene = vi.fn();
  const editor = createEditorController({ read, commit: vi.fn(), onScene, onState: vi.fn() });
  await editor.open("one");
  read.mockImplementationOnce(() => new Promise(resolve => { finishRead = resolve; }));
  const refreshing = editor.refresh();
  await editor.open("two"); await editor.open("one");
  const changes = onScene.mock.calls.length;
  finishRead(doc("one", 9)); await refreshing;
  expect(editor.state().document).toMatchObject({ id: "one", revision: 1 });
  expect(onScene).toHaveBeenCalledTimes(changes);
});

it("does not lose a refresh queued while the previous read is settling", async () => {
  let latest = doc();
  const read = vi.fn(async () => latest);
  let editor!: ReturnType<typeof createEditorController>;
  editor = createEditorController({ read, commit: vi.fn(), onScene: vi.fn(), onState(state) {
    if (state.document?.revision === 2) queueMicrotask(() => { latest = doc("one", 3); void editor.refresh(); });
  } });
  await editor.open("one"); latest = doc("one", 2);
  await editor.refresh();
  await vi.waitFor(() => expect(editor.state().document?.revision).toBe(3));
  expect(read).toHaveBeenCalledTimes(3);
});
