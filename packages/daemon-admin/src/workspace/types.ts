export type CommandKind = "session" | "template";

export type CommandSelection = "execute" | "submenu" | "insert";

export type CommandSource =
  "builtin" | "bundled" | "user" | "plugin" | "project";

interface CommandCatalogEntryBase {
  name: string;
  displayName?: string;
  description?: string;
  source?: CommandSource;
  argumentHint?: string;
  selection?: CommandSelection;
  requiresEmptyComposer?: boolean;
}

export type CommandCatalogEntry = CommandCatalogEntryBase & (
  | { kind: "session"; path?: never; skillName?: never }
  | { kind: "template"; path: string; skillName: string }
);

export interface ListCommandsOptions {
  cwd: string;
}

export interface HookInfo {
  id: string;
  event: string;
  type: string;
  enabled: boolean;
  origin: "settings" | "runtime";
}
