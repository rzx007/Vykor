/** Dependency inventories describe existing source; the source itself is still checked in full. */
export function referenceScanSource(path, source) {
  if (path !== "scripts/architecture-policy.json"
    && path !== "docs/superpowers/reviews/2026-10-22-protocol-layering-baseline.json") return source;
  const inventory = JSON.parse(source);
  if (path === "scripts/architecture-policy.json") delete inventory.stageExceptions;
  else delete inventory.dependencyInventory;
  return JSON.stringify(inventory, null, 2);
}
