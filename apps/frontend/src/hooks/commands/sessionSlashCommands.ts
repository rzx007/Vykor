import type { VykorClientState } from "@rzx/client";
import type { CommandCatalogEntry } from "@vykor/daemon-admin/workspace";
import {
  dispatchSessionCommand,
  resolveSessionCwd,
  type PresentationReadRequest,
  type SessionCommandHost,
  type SlashLine,
} from "./session-commands";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";

import type { FrontendConfig } from "../../types";

export type SessionSlashCtx = {
  client: SessionCommandHost["client"];
  sessionId: string | undefined;
  pushSystem: (text: string) => void;
  presentSystem: (title: string, content: string) => void;
  statusRef: MutableRefObject<Record<string, unknown>>;
  commandCatalogRef: MutableRefObject<CommandCatalogEntry[]>;
  clientState: VykorClientState;
  localBusy: boolean;
  cacheFirstRead?: (request: PresentationReadRequest) => void;
  daemon?: FrontendConfig["daemon"];
  setStatus: Dispatch<SetStateAction<Record<string, unknown>>>;
  onSettingsChanged?: () => void | Promise<void>;
};

export async function dispatchSessionSlashCommand(
  slash: SlashLine | null,
  ctx: SessionSlashCtx,
): Promise<"handled" | "unhandled" | "local_ui_ignored"> {
  const {
    client,
    sessionId,
    pushSystem,
    presentSystem,
    statusRef,
    commandCatalogRef,
    clientState,
    localBusy,
    cacheFirstRead,
    daemon,
    setStatus,
    onSettingsChanged,
  } = ctx;

  const outcome = await dispatchSessionCommand(slash, {
    client,
    sessionId,
    cwd: resolveSessionCwd({
      statusCwd: statusRef.current.cwd,
      daemonCwd: daemon?.cwd ?? undefined,
    }),
    model: statusRef.current.model != null
      ? String(statusRef.current.model)
      : daemon?.model ?? undefined,
    approvalMode: typeof statusRef.current.approval_mode === "string" ? statusRef.current.approval_mode : undefined,
    workMode: typeof statusRef.current.work_mode === "string" ? statusRef.current.work_mode : undefined,
    permissionMode: typeof statusRef.current.permission_mode === "string"
      ? statusRef.current.permission_mode
      : undefined,
    statusSessionId: typeof statusRef.current.session_id === "string"
      ? statusRef.current.session_id
      : sessionId,
    commandCatalog: commandCatalogRef.current,
    clientState,
    busy: localBusy,
    emit: pushSystem,
    present: presentSystem,
    cacheFirstRead,
    getRuntimeDiagnostics: () => ({
      runtime: `Node ${process.version}`,
      platform: process.platform,
      architecture: process.arch,
    }),
    patchStatus: (patch) => setStatus((current) => ({ ...current, ...patch })),
  });

  if (outcome === "local_ui") return "local_ui_ignored";
  if (outcome === "handled") {
    void Promise.resolve().then(() => onSettingsChanged?.()).catch(() => {});
  }
  return outcome;
}
