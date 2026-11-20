import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CURRENT_PROTOCOL_VERSION } from "@vykor/protocol";
import { SessionStore } from "@vykor/services";
import { expect, it, vi } from "vitest";
import { VykorHttpServer } from "../server.js";

it("skips audit for a staged Desktop component and records standalone daemon backups by default", async () => {
  const root = mkdtempSync(join(tmpdir(), "maintenance-backup-audits-"));
  const data = join(root, "data");
  vi.stubEnv("VYKOR_CONFIG_DIR", join(root, "config"));
  vi.stubEnv("VYKOR_DATA_DIR", data);
  const openLegacyNotes = vi.spyOn(SessionStore.prototype, "openLegacyNotes");
  const server = new VykorHttpServer({ storePath: join(data, "session-runtime", "sessions.db"), token: "fixture-token", logger: () => {} });
  try {
    await server.application.ready();
    const headers = { authorization: "Bearer fixture-token", "x-vykor-protocol-version": String(CURRENT_PROTOCOL_VERSION), "content-type": "application/json" };
    const create = async (destination: string, recordAudit?: boolean) => {
      const response = await server.app.request("/maintenance/backup", { method: "POST", headers, body: JSON.stringify({ destination, recordAudit }) });
      const result = await response.json();
      expect(response.status, JSON.stringify(result)).toBe(200);
      return result;
    };
    const auditDirectory = join(data, "backup-audits");
    const staged = await create(join(root, "desktop-staging", "daemon"), false);
    expect(staged.manifest).toMatchObject({ version: 4, scope: "daemon-only" });
    expect(existsSync(auditDirectory)).toBe(false);
    const standalone = await create(join(root, "daemon-backup"));
    const audit = JSON.parse(readFileSync(join(auditDirectory, `${standalone.manifest.backupId}.json`), "utf8"));
    expect(audit).toMatchObject({ path: standalone.path, manifest: standalone.manifest });
    const storage = await server.app.request("/maintenance/storage", { headers });
    expect(storage.status).toBe(200);
    expect((await storage.json()).backups).toEqual([expect.objectContaining({ path: standalone.path, manifest: standalone.manifest })]);
    expect(openLegacyNotes).not.toHaveBeenCalled();
  } finally {
    await server.close();
    openLegacyNotes.mockRestore();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
});
