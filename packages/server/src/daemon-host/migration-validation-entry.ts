import { randomBytes } from "node:crypto";
import { initializeMigrationValidationRoot, resolveUserDataPaths } from "@vykor/host-config/paths";

/** Loaded before product bootstrap; there is deliberately no user-supplied guard bypass flag. */
export async function runMigrationValidationEntry(): Promise<void> {
  if (!process.send || !process.connected) throw new Error("Migration validation requires coordinator IPC");
  let close: (() => Promise<void>) | undefined, stopping = false;
  const stop = async () => { stopping = true; await close?.(); process.exit(0); };
  process.once("disconnect", () => { void stop(); });
  process.once("SIGTERM", () => { void stop(); });
  const context = await new Promise<{ homeDir: string; targetRoot: string; journalPath: string }>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Migration validation context timed out")), 10000);
    process.once("message", message => {
      clearTimeout(timeout);
      if (!message || typeof message !== "object" || (message as { type?: unknown }).type !== "validate-data-root") { reject(new Error("Invalid migration validation context")); return; }
      resolve(message as never);
    });
  });
  initializeMigrationValidationRoot(context);
  process.on("message", message => { if ((message as { type?: string })?.type === "close-validation") void stop(); });
  const { startVykorDaemon } = await import("../daemon/default-daemon.js");
  const token = randomBytes(32).toString("hex");
  const runtime = await startVykorDaemon({ host: "127.0.0.1", port: 0, token, version: "migration-validation",
    storePath: resolveUserDataPaths(context.targetRoot).sessionsDatabasePath, storeFileMustExist: true,
    outsideProjectWorkspaceRoot: resolveUserDataPaths(context.targetRoot).workspacesDir,
    deferBackgroundActivation: true, logger: () => {} });
  close = () => runtime.server.close();
  if (stopping) { await stop(); return; }
  process.send!({ type: "validation-ready", pid: process.pid, url: runtime.listen.url, token, storePath: runtime.server.store.path });
}
