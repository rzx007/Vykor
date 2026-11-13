import { mkdtemp, mkdir, rm, readdir, readFile, writeFile, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { afterEach, expect, it } from "vitest";
import { SessionDatabase } from "../../../../services/src/database/session-database.js";
import { acquireDataRootWriter } from "@vykor/host-config/paths";
import * as host from "../index.js";
import { writeDaemonRegistry } from "../../daemon/paths.js";
import { BusinessDataService } from "../../../../../apps/desktop/src/main/features/business-data/business-data-service.js";
const owned: string[] = [];
afterEach(async () => { for (const path of owned.splice(0)) await rm(path, { recursive: true, force: true }); });
async function fixture() {
  const homeDir = await mkdtemp(join(tmpdir(), "legacy-desktop-export-")); owned.push(homeDir);
  const sourceRoot = join(homeDir, "source"), old = join(homeDir, "old-data"), database = join(old, "session-runtime/sessions.db");
  await mkdir(sourceRoot);
  const db = SessionDatabase.open({ path: database });
  db.connection.prepare("INSERT INTO session(id,cwd,title,model,status,metadata_json,created_at,updated_at,archived_at) VALUES(?,?,?,?,?,?,?,?,?)").run("archived", homeDir, "private title", "unused", "idle", "{}", 1, 1, 1);
  const request = { homeDir, sourceRoot, targetRoot: join(homeDir, "target"), environment: { VYKOR_DATA_DIR: old }, legacy: { documentsDir: join(homeDir, "Documents"), userDataDir: join(homeDir, "electron") } };
  return { request, db, database };
}
it("classifies the real legacy dataset including committed WAL and archived IDs without creating a canonical DB", async () => {
  const { request, db, database } = await fixture();
  // Keep WAL committed bytes present; this handle writes no more and owns no product writer.
  const bytes = await readFile(database);
  try {
    expect(host).toHaveProperty("prepareLegacyDesktopSessionLookup");
    const prepared = await (host as any).prepareLegacyDesktopSessionLookup(request);
    const lookup = prepared.lookup ?? prepared;
    expect(await lookup(["archived", "unknown"])).toEqual({ archived: "persistent", unknown: "unknown" });
    expect(await readFile(database)).toEqual(bytes);
    expect(await readdir(request.sourceRoot)).not.toContain("data");
    expect((await readdir(request.homeDir)).some(name => name.startsWith(".vykor-desktop-export-"))).toBe(false);
  } finally { db.close(); }
});
it("refuses a real writer before preparing any export copy", async () => {
  const { request, db } = await fixture(); db.close();
  const writer = await acquireDataRootWriter({ homeDir: request.homeDir, dataRoot: request.sourceRoot, kind: "cli" });
  try {
    expect(host).toHaveProperty("prepareLegacyDesktopSessionLookup");
    await expect((host as any).prepareLegacyDesktopSessionLookup(request)).rejects.toMatchObject({ code: "data_root_writers_busy" });
  } finally { await writer.release(); }
});
it("uses the unique authenticated legacy daemon for archived/temporary IDs and rejects changed identity", async () => {
  const { request, db, database } = await fixture(); db.close();
  const server = createServer((req, res) => {
    if (req.headers.authorization !== "Bearer owned-token") { res.writeHead(401); res.end(); return; }
    res.setHeader("content-type", "application/json");
    if (req.url === "/debug/process") res.end(JSON.stringify({ pid: process.pid }));
    else if (req.url === "/sessions/archived") res.end(JSON.stringify({ session: { id: "archived" } }));
    else if (req.url === "/sessions/temporary") res.end(JSON.stringify({ session: { id: "temporary", storage: "memory" } }));
    else if (req.url === "/sessions/invalid") res.end(JSON.stringify({ session: { id: "invalid", storage: "unexpected" } }));
    else { res.writeHead(404); res.end("{}"); }
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const registry = { url: `http://127.0.0.1:${port}`, token: "owned-token", pid: process.pid, storePath: database, startedAt: 1, version: "owned" };
  const file = join(request.environment.VYKOR_DATA_DIR, "daemon/registry.json");
  writeDaemonRegistry(registry, file);
  try {
    const prepared = await host.prepareLegacyDesktopSessionLookup(request);
    const lookup = (prepared as any).lookup ?? prepared;
    expect(await lookup(["archived", "temporary", "missing"])).toEqual({ archived: "persistent", temporary: "memory", missing: "unknown" });
    await expect(lookup(["invalid"])).rejects.toThrow(/Invalid legacy session classification/);
    writeDaemonRegistry({ ...registry, token: "changed" }, file);
    await expect(lookup(["archived"])).rejects.toThrow(/identity changed/);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
it.each(["different-root", "same-root"])("retains host-only env sources across clearing pins in %s, migrates the real dataset, and consumes only the target receipt", async mode => {
  const { request, db } = await fixture(); db.close();
  const prepared = await host.prepareLegacyDesktopSessionLookup(request);
  expect(prepared).toHaveProperty("legacySources");
  const business = new BusinessDataService(request.sourceRoot);
  await business.recordDesktopScan({}, { ...request.legacy, legacySources: (prepared as any).legacySources } as any);
  await expect(business.recordDesktopScan({ "invalid-key": "invalid" }, request.legacy)).rejects.toThrow(/INVALID_SCAN/);
  expect(JSON.parse(await readFile(join(request.sourceRoot, "data/desktop/legacy-import.json"), "utf8")).legacySources.status).toBe("pending");
  await business.recordDesktopScan({}, request.legacy);
  expect((await host.inspectDataRootMigration({ ...request, rootInputs: { homeDir: request.homeDir, environment: request.environment } })).blockers.some(value => value.code === "fixed_directory_environment")).toBe(true);
  const afterRestart = { ...request, targetRoot: mode === "same-root" ? request.sourceRoot : request.targetRoot, environment: {}, rootInputs: { homeDir: request.homeDir, environment: {} } };
  const preview = await host.inspectDataRootMigration(afterRestart);
  expect(preview.databases[0]?.path).toBe(join(request.environment.VYKOR_DATA_DIR, "session-runtime/sessions.db"));
  expect(preview.blockers).toEqual([]);
  const moved = await host.migrateDataRoot(afterRestart, { prepareStoppedCopy: async () => {
    const fresh = await business.recordDesktopScan({}, request.legacy);
    return { freshDesktopScanId: fresh.id, desktopExportPath: join(request.sourceRoot, "data/desktop/legacy-import.json") };
  } });
  expect(moved.phase).toBe("verified");
  const journal = JSON.parse(await readFile(moved.journalPath, "utf8"));
  const sourceManifest = JSON.parse(await readFile(join(mode === "same-root" ? journal.backupRoot : request.sourceRoot, "data/desktop/legacy-import.json"), "utf8"));
  const targetManifest = JSON.parse(await readFile(join(afterRestart.targetRoot, "data/desktop/legacy-import.json"), "utf8"));
  expect(sourceManifest.legacySources.status).toBe("pending");
  expect(targetManifest.legacySources.status).toBe("consumed");
  const next = await host.inspectDataRootMigration({ ...afterRestart, sourceRoot: afterRestart.targetRoot, targetRoot: join(request.homeDir, "next-target") });
  expect(next.databases.map(value => value.path)).toEqual([join(afterRestart.targetRoot, "data/session-runtime/sessions.db")]);
  expect(next.blockers.some(value => value.code === "legacy_source_receipt_invalid")).toBe(false);
  expect((await host.recoverDataRootMigration(moved.journalPath, { homeDir: request.homeDir })).phase).toBe("failed");
});
it("prefers a new canonical DB while retaining separate channels/images, and refuses a substituted source identity", async () => {
  const { request, db } = await fixture(); db.close();
  const channels = join(request.homeDir, "old-channels"), images = join(request.homeDir, "old-images");
  await mkdir(channels); await mkdir(images); await writeFile(join(channels, "channel.txt"), "owned"); await writeFile(join(images, "image.png"), "owned");
  const observed = { ...request, environment: { ...request.environment, VYKOR_CHANNELS_DIR: channels, VYKOR_IMAGE_ATTACHMENT_CACHE_DIR: images } };
  const prepared = await host.prepareLegacyDesktopSessionLookup(observed);
  expect(prepared).toHaveProperty("legacySources");
  await new BusinessDataService(request.sourceRoot).recordDesktopScan({}, { ...request.legacy, legacySources: (prepared as any).legacySources } as any);
  const manifestPath = join(request.sourceRoot, "data/desktop/legacy-import.json"), retained = await readFile(manifestPath, "utf8"), forged = JSON.parse(retained);
  forged.legacySources.documentsDir = join(request.homeDir, "forged-documents"); await writeFile(manifestPath, JSON.stringify(forged));
  const restarted = { ...request, environment: {}, rootInputs: { homeDir: request.homeDir, environment: {} } };
  expect((await host.inspectDataRootMigration(restarted)).blockers.some(value => value.code === "legacy_source_receipt_invalid")).toBe(true);
  await writeFile(manifestPath, retained);
  const canonical = join(request.sourceRoot, "data/session-runtime/sessions.db"); SessionDatabase.open({ path: canonical }).close();
  await rename(request.environment.VYKOR_DATA_DIR, `${request.environment.VYKOR_DATA_DIR}-retained`);
  const preview = await host.inspectDataRootMigration(restarted);
  expect(preview.databases.map(value => value.path)).toEqual([canonical]);
  expect(preview.sources.some(value => value.from === channels)).toBe(true);
  expect(preview.sources.some(value => value.from === images)).toBe(true);
  await rename(channels, `${channels}-retained`); await mkdir(channels);
  expect((await host.inspectDataRootMigration(restarted)).blockers).toEqual(expect.arrayContaining([expect.objectContaining({ code: "legacy_source_receipt_invalid" })]));
});
