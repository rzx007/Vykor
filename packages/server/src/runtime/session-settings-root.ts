import { isAbsolute } from "node:path";
import type { SessionRecord } from "@vykor/protocol";

/** A task worktree executes in its own cwd but keeps its owning project's settings. */
export function sessionSettingsRoot(session: SessionRecord): string {
  const desktop = session.metadata?.desktop;
  if (!desktop || typeof desktop !== "object" || Array.isArray(desktop)) return session.cwd;
  const path = (desktop as Record<string, unknown>).settingsRoot;
  return typeof path === "string" && isAbsolute(path) ? path : session.cwd;
}
