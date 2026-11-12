import { assertNoLegacyDirectoryOverrides, initializeDataRoot, parseDataRootArgument } from "@vykor/host-config/paths";

async function main(): Promise<void> {
  const parsed = parseDataRootArgument(process.argv.slice(2));
  // Local data-root inspect/migrate/recover must be routed here, before normal
  // initialization and before importing program.ts (which loads product stores).
  const selected = await initializeDataRoot({ explicitRoot: parsed.explicitRoot });
  assertNoLegacyDirectoryOverrides(selected.dataRoot);
  process.argv = [...process.argv.slice(0, 2), ...parsed.argv];
  if (selected.source !== "default") console.error(`[data-root] ${selected.dataRoot} (source: ${selected.source})`);
  await import("./program.js");
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
