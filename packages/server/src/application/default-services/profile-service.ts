import { initializePersonalPromptFiles, inspectPersonalPromptFiles, type PersonalPromptFileDiagnostic } from "@vykor/prompts";

import type { ProfileService } from "../settings-api.js";

export function createDefaultProfileService(): ProfileService {
  return {
    async status() {
      const diagnostics = await inspectPersonalPromptFiles();
      return { report: formatPersonalPromptDiagnostics(diagnostics) };
    },
    async init() {
      const result = await initializePersonalPromptFiles();
      const diagnostics = await inspectPersonalPromptFiles();
      const lines = [
        `Personal prompt directory: ${result.configDir}`,
        `Created: ${result.created.length}`,
        ...result.created.map((path) => `  + ${path}`),
        `Skipped existing: ${result.skipped.length}`,
        ...result.skipped.map((path) => `  = ${path}`),
        "",
        formatPersonalPromptDiagnostics(diagnostics),
      ];
      return { report: lines.join("\n") };
    },
  };
}

function formatPersonalPromptDiagnostics(diagnostics: PersonalPromptFileDiagnostic[]): string {
  const lines = ["Personal prompt files:"];
  for (const item of diagnostics) {
    const flags = [
      item.truncated ? "truncated" : "",
      item.issues.length > 0 ? `${item.issues.length} issue(s)` : "",
    ].filter(Boolean);
    lines.push(`- ${item.file}: ${item.status}${flags.length ? ` (${flags.join(", ")})` : ""}`);
    lines.push(`  path: ${item.path}`);
    if (item.message) lines.push(`  note: ${item.message}`);
    for (const issue of item.issues) {
      lines.push(`  ${issue.severity}: ${issue.code} - ${issue.message}`);
    }
  }
  return lines.join("\n");
}
