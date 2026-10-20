import type { ApprovalMode, Settings } from "@vykor/core";

// Symbol.for survives the runtime bundle boundary without serializing the baseline.
const baselineKey = Symbol.for("@vykor/approval-baseline-settings");
type SessionSettings = Settings & { [baselineKey]?: Settings };

/** A session-owned copy; narrowing permissions restores the original sandbox. */
export function settingsForApprovalMode(settings: Settings, mode: ApprovalMode | undefined): Settings {
  const baseline = (settings as SessionSettings)[baselineKey] ?? settings;
  if (mode !== "full_access") return baseline;
  if (baseline !== settings) return settings;
  const copy: Settings = {
    ...baseline,
    sandbox: {
      ...baseline.sandbox,
      enabled: false,
      network: { ...baseline.sandbox?.network, mode: "host" },
    },
  };
  Object.defineProperty(copy, baselineKey, { value: baseline });
  return copy;
}
