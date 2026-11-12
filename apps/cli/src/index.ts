import { acquireDataRootWriter, assertNoLegacyDirectoryOverrides, dataRootHome, initializeDataRoot, parseDataRootArgument } from "@vykor/host-config/paths";

async function main(): Promise<void> {
  if (process.argv[2] === "--internal-data-root-validation") {
    await (await import("@vykor/server/migration-validation")).runMigrationValidationEntry(); return;
  }
  const parsed = parseDataRootArgument(process.argv.slice(2));
  // Local data-root inspect/migrate/recover must be routed here, before normal
  // initialization and before importing program.ts (which loads product stores).
  const selected = await initializeDataRoot({ explicitRoot: parsed.explicitRoot });
  assertNoLegacyDirectoryOverrides(selected.dataRoot);
  // Holds credentials, TUI delayed saves and command writes until process exit.
  await acquireDataRootWriter({ homeDir: dataRootHome(), dataRoot: selected.dataRoot,
    kind: parsed.argv[0] === "serve" ? "daemon" : "cli" });
  process.argv = [...process.argv.slice(0, 2), ...parsed.argv];
  if (selected.source !== "default") console.error(`[data-root] ${selected.dataRoot} (source: ${selected.source})`);
  await import("./program.js");
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
