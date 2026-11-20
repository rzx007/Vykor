import { webcrypto } from "node:crypto";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { BusinessDataService } from "../../../apps/desktop/src/main/features/business-data/business-data-service";
import { classifyRecoverySessions } from "../../../apps/desktop/src/main/features/business-data/legacy-composer";
import { collectLegacyBusinessSources, resetBusinessDataCache } from "../../../apps/desktop/src/renderer/src/lib/business-data";
import { readComposerRecovery } from "../../../apps/desktop/src/renderer/src/stores/desktop-session/composer-recovery";
import { migrateDataRoot, recoverDataRootMigration } from "../../../packages/server/src/daemon-host/data-root-migration";
import { readDataRootSelector } from "@vykor/host-config/paths";
import { rootFixture, scriptedRootServer } from "../../helpers/data-root-fixture";

afterEach(() => { resetBusinessDataCache(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it("imports only formal drafts and recovers a failed same-root installation twice while keeping shell preferences and original keys", async () => {
  const fixture = await rootFixture();
  // Keep Node file URLs for SQLite migration discovery while using real jsdom Storage.
  const { JSDOM } = createRequire(new URL("../../../apps/desktop/package.json", import.meta.url))("jsdom");
  const dom = new JSDOM("", { url: "https://owned-fixture.invalid" });
  vi.stubGlobal("localStorage", dom.window.localStorage);
  vi.stubEnv("VYKOR_CONFIG_DIR", fixture.sourceRoot);
  vi.stubEnv("VYKOR_DISABLE_MODELS_FETCH", "1");
  vi.stubGlobal("crypto", webcrypto);
  const runtime = await scriptedRootServer(fixture.sourceRoot);
  let closed = false;
  try {
    const cwd = join(fixture.sourceRoot, "workspaces/chat"), metadata = { desktop: { workspaceMode: "outside_project" } };
    const formal = await runtime.client.sessions.create({ cwd, model: "root-fixture", metadata });
    const temporary = await runtime.client.sessions.create({ cwd, model: "root-fixture", storage: "memory", metadata });
    const draft = (text: string) => ({ document: { version: 1, items: [{ type: "text", text }] }, attachments: [] });
    const temporaryText = "temporary-draft-never-exported";
    const raw = JSON.stringify({ version: 1, drafts: { [`session:${formal.id}`]: draft("formal draft"), [`session:${temporary.id}`]: draft(temporaryText), "session:unknown-old": draft("unknown retained only in original key") },
      submissions: [{ id: "stable-input-id", sessionId: formal.id, items: [{ type: "text", text: "unsent" }], attachments: [], createdAt: 1, placement: "transcript" }] });
    const key = "vykor.desktop.composer-recovery.v1";
    localStorage.setItem(key, raw); localStorage.setItem("window-preference", "original-window-size");
    await fixture.file(join(fixture.userDataDir, "desktop-preferences.json"), '{"theme":"original"}');
    await fixture.file(join(fixture.userDataDir, "Cache/opaque"), "browser cache stays");
    const service = new BusinessDataService(fixture.sourceRoot);
    const host = { userDataDir: fixture.userDataDir, documentsDir: fixture.documentsDir };
    const api = { read: service.read.bind(service), write: service.write.bind(service), importLegacy: service.importLegacy.bind(service), flush: service.flush.bind(service),
      classifySessions: (ids: string[]) => classifyRecoverySessions(ids, async id => (await runtime.client.sessions.getState(id)).session),
      recordDesktopScan: (sources: Record<string, string>) => service.recordDesktopScan(sources, host) };
    vi.stubGlobal("window", { desktop: { businessData: api } });
    const recovered = await readComposerRecovery();
    expect(Object.keys(recovered.composerDraftsByScope)).toEqual([`session:${formal.id}`]);
    expect(recovered.sessionRuntimes[formal.id]?.pendingPromptSubmissions["stable-input-id"]?.id).toBe("stable-input-id");
    const sources = await collectLegacyBusinessSources(localStorage);
    expect((await service.recordDesktopScan(sources, host)).ready).toBe(false);
    await service.acknowledgeUnresolvedComposer(sources.composer!);
    expect((await service.recordDesktopScan(sources, host)).ready).toBe(true);
    await service.flush(); await runtime.close(); closed = true;
    const original = await readFile(join(fixture.sourceRoot, "data/session-runtime/sessions.db"));
    let installed = false;
    const result = await migrateDataRoot(fixture.request(fixture.sourceRoot, fixture.sourceRoot), {
      prepareStoppedCopy: async () => ({ freshDesktopScanId: (await service.recordDesktopScan(sources, host)).id,
        desktopExportPath: join(fixture.sourceRoot, "data/desktop/legacy-import.json") }),
      withInstalledCopy: async () => { installed = true; throw new Error("owned acceptance fault after installation"); },
    });
    expect(installed, await readFile(result.journalPath, "utf8")).toBe(true);
    expect(result).toMatchObject({ phase: "failed", writersReleased: false });
    expect(await recoverDataRootMigration(result.journalPath, { homeDir: fixture.homeDir })).toMatchObject({ recoveryWritersReleased: true });
    await recoverDataRootMigration(result.journalPath, { homeDir: fixture.homeDir });
    expect(readDataRootSelector(fixture.homeDir)).toBeUndefined();
    expect(await readFile(join(fixture.sourceRoot, "data/session-runtime/sessions.db"))).toEqual(original);
    const newer = await service.write({ kind: "composer" }, { version: 1, drafts: { [`session:${formal.id}`]: draft("newer draft") }, submissions: [] }, 1);
    await service.importLegacy({ kind: "composer" }, { version: 1, drafts: {}, submissions: [] }, sources.composer!, ["unknown-old"]);
    expect((await service.read({ kind: "composer" }))?.revision).toBe(newer.revision);
    expect(localStorage.getItem(key)).toBe(raw); expect(localStorage.getItem("window-preference")).toBe("original-window-size");
    expect(await readFile(join(fixture.userDataDir, "desktop-preferences.json"), "utf8")).toBe('{"theme":"original"}');
    expect(await readFile(join(fixture.userDataDir, "Cache/opaque"), "utf8")).toBe("browser cache stays");
    expect(await readFile(join(fixture.sourceRoot, "data/desktop/composer-recovery.json"), "utf8")).not.toContain(temporaryText);
    expect(await readFile(result.journalPath, "utf8")).not.toContain(temporaryText);
  } finally { if (!closed) await runtime.close(); dom.window.close(); await fixture.close(); }
}, 90000);
