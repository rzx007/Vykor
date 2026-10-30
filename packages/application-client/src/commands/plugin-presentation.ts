import type { ReloadPluginsResponse } from "../types/index.js";

/** Reload invalidates runtimes; it does not prove that every plugin activated. */
export function formatPluginReload(result: ReloadPluginsResponse): string {
  const lines = [result.message];
  if (!result.plugins.length) lines.push("No plugins discovered.");
  else {
    lines.push("Plugin validation after reload (runtimes load on next use):");
    for (const plugin of result.plugins) {
      lines.push(`- ${plugin.identity.id} [${plugin.enabled ? "enabled" : "disabled"}/${plugin.installation}/${plugin.activation}]`);
      for (const diagnostic of plugin.diagnostics) lines.push(`  ${diagnostic.severity}: ${diagnostic.code}: ${diagnostic.message}`);
      if (plugin.permissions.missing.length) lines.push(`  Missing permissions: ${plugin.permissions.missing.join(", ")}`);
      if (plugin.installation !== "installed" || plugin.permissions.missing.length || plugin.diagnostics.some(item => item.code.includes("permission"))) {
        lines.push(plugin.scope === "managed"
          ? "  Ask your administrator to repair this managed plugin."
          : "  Review the source and permissions, then run vk plugin install-local <source> or vk plugin link <source>, supplying --approve <permission> for each requested permission.");
      }
    }
  }
  lines.push(...result.warnings.map(warning => `! ${warning}`));
  return lines.join("\n");
}
