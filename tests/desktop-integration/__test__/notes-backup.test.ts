import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "@vykor/services";
import { importLegacyNotes, openDesktopNoteRepository, validateDesktopNotes } from "@vykor/services/notes";
import { expect, it } from "vitest";
import { DesktopBackupService } from "../../../apps/desktop/src/main/features/settings/desktop-backup-service.js";
import { createApplicationBackup, restoreApplicationBackup, verifyApplicationBackup } from "../../../packages/server/src/application/backup/application-backup.js";
import { publishRoot, rootFixture } from "../../helpers/data-root-fixture.js";

it("restores both SQLite snapshots and recovers the original revision from a version 3 archive", async () => {
  const directory = await mkdtemp(join(tmpdir(), "desktop-notes-integrated-backup-"));
  const liveRoot = join(directory, "root");
  const legacyDatabase = join(liveRoot, "data", "session-runtime", "sessions.db");
  const store = new SessionStore({ path: legacyDatabase });
  try {
    store.sessions.create({ id: "conversation", cwd: directory, model: "unused" });
    const legacy = store.openLegacyNotes();
    legacy.create({ content: "old contents" }, { id: "paper", now: 10 });
    legacy.update("paper", { content: "old backed-up revision", expectedRevision: 1 }, 20);
    const archive = join(directory, "older-backup");
    legacy.backupTo(join(archive, "notes"));
    await store.backupDatabase(join(archive, "database.sqlite"));
    const oldManifest = {
      version: 3, backupId: "old-backup", createdAt: 20, database: "database.sqlite",
      directories: { notes: true, artifacts: false, memory: false, "execution-output": false, attachments: false },
      recovery: { reviveLiveProcesses: false, closeActiveRecordsOnStartup: true },
    };
    await writeFile(join(archive, "manifest.json"), JSON.stringify(oldManifest));
    const files = ["database.sqlite", "manifest.json", ...(await readdir(join(archive, "notes"))).map(name => `notes/${name}`)];
    const hash = async () => Object.fromEntries(await Promise.all(files.map(async name => [
      name, createHash("sha256").update(await readFile(join(archive, name))).digest("hex"),
    ])));
    const oldHashes = await hash();
    await writeFile(join(archive, "checksums.json"), JSON.stringify(oldHashes));

    const native = join(liveRoot, "data", "desktop", "notes");
    await importLegacyNotes({ databasePath: legacyDatabase, destination: native });
    const notes = openDesktopNoteRepository(native);
    try {
      notes.repository.update("paper", { content: "current Desktop revision", expectedRevision: 2 });
      const backups = new DesktopBackupService({
        liveRoot: () => liveRoot,
        createDaemon: async ({ destination }) => ({ path: destination, manifest: await createApplicationBackup({ store, destination }) }),
        verifyDaemon: async (source) => ({ path: source, manifest: verifyApplicationBackup(source) }),
        restoreDaemon: async (source, target) => ({ path: target, manifest: restoreApplicationBackup({ source, storePath: join(target, "sessions.db") }) }),
        flushDesktop: async () => {}, backupNotes: notes.backupTo,
        validateNotes: validateDesktopNotes, importNotes: importLegacyNotes,
        recordBackup: async () => {},
      });
      const destination = join(directory, "desktop-backup");
      expect(await backups.backup({ destination, includeMemory: false, includeOutput: false })).toMatchObject({ desktopNotes: true, manifest: { version: 4 } });
      const restored = join(directory, "restored");
      const recovered = join(directory, "restored-old");
      await mkdir(recovered);
      await backups.restore({ source: destination, target: restored });
      await backups.restore({ source: archive, target: recovered });
      for (const [target, content, revision] of [
        [restored, "current Desktop revision", 3], [recovered, "old backed-up revision", 2],
      ] as const) {
        const targetStore = new SessionStore({ path: join(target, "data", "session-runtime", "sessions.db") });
        const targetNotes = openDesktopNoteRepository(join(target, "data", "desktop", "notes"));
        try {
          expect(targetStore.sessions.get("conversation")?.id).toBe("conversation");
          expect(targetNotes.repository.get("paper")).toMatchObject({ content, revision, createdAt: 10 });
        } finally { targetNotes.close(); targetStore.close(); }
      }
      expect(await hash()).toEqual(oldHashes);
      expect(await readFile(join(archive, "checksums.json"), "utf8")).toBe(JSON.stringify(oldHashes));
    } finally { notes.close(); }
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
}, 30_000);

it("keeps Desktop notes and their index when publishing a complete data root", async () => {
  const fixture = await rootFixture();
  const pathFor = (root: string) => join(root, "data", "desktop", "notes");
  try {
    const database = join(fixture.sourceRoot, "data", "session-runtime", "sessions.db");
    new SessionStore({ path: database }).close();
    await importLegacyNotes({ databasePath: database, destination: pathFor(fixture.sourceRoot) });
    const notes = openDesktopNoteRepository(pathFor(fixture.sourceRoot));
    try {
      notes.repository.create({ content: "移走后仍可打开" }, { id: "saved", now: 20 });
      notes.repository.organization();
    } finally { notes.close(); }
    const entries = await readdir(pathFor(fixture.sourceRoot), { withFileTypes: true });
    expect(entries.filter(entry => !entry.isFile()).map(entry => entry.name)).toEqual([]);
    const filenames = entries.map(entry => entry.name);
    const original = await Promise.all(filenames.map(name => readFile(join(pathFor(fixture.sourceRoot), name))));
    expect(await publishRoot(fixture.request())).toMatchObject({ phase: "committed", writersReleased: true });
    validateDesktopNotes(pathFor(fixture.targetRoot));
    const restored = openDesktopNoteRepository(pathFor(fixture.targetRoot));
    try {
      expect(restored.repository.get("saved")).toMatchObject({ content: "移走后仍可打开", revision: 1, createdAt: 20 });
    } finally { restored.close(); }
    expect(await Promise.all(filenames.map(name => readFile(join(pathFor(fixture.sourceRoot), name))))).toEqual(original);
  } finally { await fixture.close(); }
}, 90_000);
