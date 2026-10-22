const REMOVED_LIFECYCLE_TOOL_REPLACEMENTS: Record<string, string | undefined> =
  {
    taskget: "JobRead",
    task_get: "JobRead",
    tasklist: "JobList",
    task_list: "JobList",
    taskoutput: "JobRead",
    task_output: "JobRead",
    taskstop: "JobCancel",
    task_stop: "JobCancel",
    taskwait: "JobWait",
    task_wait: "JobWait",
    taskupdate: undefined,
    task_update: undefined,
    sendmessage: "JobSend",
    send_message: "JobSend",
    terminalread: "JobRead",
    terminal_read: "JobRead",
    terminallist: "JobList",
    terminal_list: "JobList",
    terminalsend: "JobSend",
    terminal_send: "JobSend",
    terminalsignal: "JobCancel",
    terminal_signal: "JobCancel",
    terminalclose: "JobCancel",
    terminal_close: "JobCancel",
  };

/** Reject only lifecycle names removed by the Jobs hard cut; unknown plugin tools remain valid. */
export function assertNoRemovedLifecycleToolNames(
  tools: readonly string[],
  source: string,
): void {
  const removed = new Map<string, string | undefined>();
  for (const tool of tools) {
    const trimmed = tool.trim();
    const key = trimmed.toLowerCase();
    if (
      Object.prototype.hasOwnProperty.call(
        REMOVED_LIFECYCLE_TOOL_REPLACEMENTS,
        key,
      )
    ) {
      removed.set(trimmed, REMOVED_LIFECYCLE_TOOL_REPLACEMENTS[key]);
    }
  }
  if (removed.size === 0) return;

  const migrations = [...removed].map(([tool, replacement]) =>
    replacement
      ? `"${tool}" -> "${replacement}"`
      : `"${tool}" (remove it; no Job equivalent)`,
  );
  throw new Error(
    `${source} contains removed lifecycle tool names: ${migrations.join(", ")}. ` +
      "Compatibility aliases are not supported.",
  );
}
