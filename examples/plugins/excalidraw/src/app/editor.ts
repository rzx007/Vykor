import type { Commit, Diagram, Scene } from "#excalidraw/contract.ts";
import { validateScene } from "#excalidraw/domain/scene.ts";

export interface EditorState {
  document: Diagram | null;
  dirty: boolean;
  saving: boolean;
  error: string | null;
}
export function createEditorController(ports: {
  read(id: string): Promise<Diagram>;
  commit(input: Commit): Promise<Diagram>;
  onScene(scene: Scene, mode: "reset" | "update"): void;
  onState(state: EditorState): void;
}) {
  let document: Diagram | null = null;
  let draft: Scene | null = null;
  let draftTitle: string | null = null;
  let saving: Promise<void> | null = null;
  let error: string | null = null;
  let generation = 0;
  let retryable = false;
  let refreshing: Promise<void> | null = null;
  let refreshQueued = false;
  const drafts = new Map<string, { document: Diagram; draft: Scene | null; draftTitle: string | null; error: string | null; retryable: boolean }>();
  const stash = () => { if (document) drafts.set(document.id, { document, draft, draftTitle, error, retryable }); };

  const state = (): EditorState => ({
    document,
    dirty: draft !== null || draftTitle !== null,
    saving: saving !== null,
    error,
  });
  const emit = () => ports.onState(state());
  const fingerprint = (scene: Scene) => JSON.stringify(scene);
  async function flush(): Promise<void> {
    if (saving) return saving;
    if (error) throw new Error(error);
    if ((!draft && draftTitle === null) || !document) return;
    const run = async () => {
      while ((draft || draftTitle !== null) && document) {
        const scene = draft ?? document.scene;
        const title = draftTitle;
        const written = await ports.commit({
          id: document.id,
          expectedRevision: document.revision,
          operationId: crypto.randomUUID(),
          scene,
          ...(title !== null ? { title } : {}),
        });
        document = written;
        if (draft && fingerprint(draft) === fingerprint(scene)) draft = null;
        if (draftTitle === title) draftTitle = null;
      }
    };
    saving = run()
      .catch((e) => {
        error = e instanceof Error ? e.message : String(e);
        const admission = (e as { data?: { code?: string; notAccepted?: boolean } }).data;
        retryable = admission?.notAccepted === true && ["plugin_app_busy", "plugin_app_hidden"].includes(admission.code ?? "");
        throw e;
      })
      .finally(() => {
        saving = null;
        emit();
      });
    emit();
    return saving;
  }
  function refresh(): Promise<void> {
    if (!document) return Promise.resolve();
    refreshQueued = true;
    if (refreshing) return refreshing;
    refreshing = (async () => {
      while (refreshQueued) {
        refreshQueued = false;
        const target: string | undefined = document?.id;
        const observedGeneration = generation;
        if (!target) return;
        const loaded = await ports.read(target);
        // Switching away and back is a new view even when its document id matches.
        if (generation !== observedGeneration || document?.id !== target || loaded.revision <= document.revision) continue;
        if (draft || draftTitle !== null || saving) {
          if (!saving) {
            error = "远端画板已有更新，草稿已保留。请保存副本或明确重载。";
            retryable = false;
            emit();
          }
          continue;
        }
        document = loaded;
        ports.onScene(loaded.scene, "update");
        emit();
      }
    })().finally(() => {
      refreshing = null;
      // A notification can arrive in a microtask after the loop ends but before settlement.
      if (refreshQueued) return refresh();
    });
    return refreshing;
  }
  return {
    state,
    scene: () => draft ?? document?.scene ?? { elements: [], appState: {}, files: {} },
    async close() {
      const nextGeneration = ++generation;
      await flush();
      if (nextGeneration !== generation) return;
      document = null;
      draft = null;
      draftTitle = null;
      error = null;
      ports.onScene({ elements: [], appState: {}, files: {} }, "reset");
      emit();
    },
    async open(id: string, discard = false) {
      const nextGeneration = ++generation;
      // 丢弃只针对未接受的草稿；在途提交必须结束，避免旧 ACK 把新文档切回去。
      if (discard) await saving?.catch(() => {});
      else if (document?.id === id || !error) await flush();
      if (nextGeneration !== generation) return;
      stash();
      const retained = !discard ? drafts.get(id) : undefined;
      if (retained && (retained.draft || retained.draftTitle !== null || retained.error)) {
        ({ document, draft, draftTitle, error, retryable } = retained);
        ports.onScene(draft ?? document.scene, "reset"); emit(); return;
      }
      const loaded = await ports.read(id);
      if (nextGeneration !== generation) return;
      // 读取期间也可能产生手动编辑；先等待其 ACK，不能用旧读取覆盖新内容或冲突草稿。
      if (!discard && !error) await flush();
      if (nextGeneration !== generation) return;
      const sameDocument = document?.id === loaded.id;
      if (!discard && sameDocument && loaded.revision <= document!.revision) return;
      // Edits can continue in the old tab while the new resource is loading.
      stash();
      document = loaded;
      drafts.delete(id);
      retryable = false;
      draft = null;
      draftTitle = null;
      error = null;
      ports.onScene(loaded.scene, sameDocument && !discard ? "update" : "reset");
      emit();
    },
    edit(raw: Scene) {
      if (!document) return;
      const scene = validateScene(raw);
      if (fingerprint(scene) === fingerprint(draft ?? document.scene)) return;
      draft = scene;
      emit();
      // 保存的正确性由 ACK 和版本承担；无需用 debounce 的时长猜测用户是否已经完成编辑。
      if (!error) void flush().catch(() => {});
    },
    async rename(title: string) {
      if (!document) throw new Error("No diagram is open");
      const trimmed = title.trim();
      if (!trimmed || trimmed.length > 200)
        throw new Error("Title must contain 1 to 200 characters");
      if (trimmed === (draftTitle ?? document.title)) return flush();
      draftTitle = trimmed;
      emit();
      await flush();
    },
    resume() {
      if (!retryable) return;
      retryable = false; error = null; emit();
      void flush().catch(() => {});
    },
    refresh,
    flush,
  };
}
