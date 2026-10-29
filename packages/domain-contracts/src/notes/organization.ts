import { DomainValidationError } from "../validation-error.js";

export const NOTE_ORGANIZATION_VERSION = 1;
export const MAX_ORGANIZATION_ITEMS = 10_000;
export type DesktopItem = { type: "note" | "folder"; id: string };
export interface NoteFolderRecord {
  name: string;
  createdAt: number;
  updatedAt: number;
}
export interface NoteOrganizationV1Record {
  version: 1;
  folders: Record<string, NoteFolderRecord>;
  desktop: DesktopItem[];
  folderItems: Record<string, string[]>;
}
export type NoteOrganizationV1 = NoteOrganizationV1Record;
export interface NoteOrganizationSnapshotRecord {
  organization: NoteOrganizationV1Record;
  etag: string;
  readOnly: boolean;
  warning?: string;
}
export interface SaveNoteOrganizationInput {
  organization: NoteOrganizationV1Record;
  expectedEtag: string;
}
export interface ReconcileResult {
  organization: NoteOrganizationV1Record;
  changed: boolean;
}

function invalid(message: string): never {
  throw new DomainValidationError(message, "organization");
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    invalid("组织数据必须是对象");
  return value as Record<string, unknown>;
}
function fields(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    invalid("组织数据含未知字段");
}
function id(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[\p{L}\p{N}_ -]{1,120}$/u.test(value) ||
    /^(con|prn|aux|nul|com\d|lpt\d)$/iu.test(value) ||
    ["__proto__", "constructor", "prototype"].includes(value)
  )
    invalid("无效的便签或文件夹 ID");
  return value;
}
function folderId(value: unknown): string {
  const result = id(value);
  if (result === "desktop") invalid("无效的文件夹 ID");
  return result;
}
export function validateFolderName(value: unknown): string {
  if (typeof value !== "string") invalid("文件夹名称须为 1–80 个字符");
  const name = value.trim();
  if (!name || Array.from(name).length > 80)
    invalid("文件夹名称须为 1–80 个字符");
  return name;
}
/** Parse shape separately so disk reconciliation can repair duplicate and deleted references. */
export function parseOrganizationShape(
  value: unknown,
): NoteOrganizationV1Record {
  const body = record(value);
  fields(body, ["version", "folders", "desktop", "folderItems"]);
  if (body.version !== 1) invalid("不支持的组织文件版本");
  const folders = record(body.folders),
    items = record(body.folderItems);
  if (
    !Array.isArray(body.desktop) ||
    body.desktop.length > MAX_ORGANIZATION_ITEMS ||
    Object.keys(folders).length > MAX_ORGANIZATION_ITEMS ||
    Object.keys(items).length > MAX_ORGANIZATION_ITEMS
  )
    invalid("组织项目过多");
  const result: NoteOrganizationV1Record = {
    version: 1,
    folders: {},
    desktop: [],
    folderItems: {},
  };
  for (const [key, raw] of Object.entries(folders)) {
    folderId(key);
    const folder = record(raw);
    fields(folder, ["name", "createdAt", "updatedAt"]);
    if (
      !Number.isSafeInteger(folder.createdAt) ||
      Number(folder.createdAt) < 0 ||
      !Number.isSafeInteger(folder.updatedAt) ||
      Number(folder.updatedAt) < 0
    )
      invalid("文件夹时间无效");
    result.folders[key] = {
      name: validateFolderName(folder.name),
      createdAt: Number(folder.createdAt),
      updatedAt: Number(folder.updatedAt),
    };
  }
  let count = body.desktop.length;
  for (const raw of body.desktop) {
    const item = record(raw);
    fields(item, ["type", "id"]);
    if (item.type !== "note" && item.type !== "folder")
      invalid("无效的桌面项目");
    result.desktop.push({
      type: item.type,
      id: item.type === "folder" ? folderId(item.id) : id(item.id),
    });
  }
  for (const [key, raw] of Object.entries(items)) {
    folderId(key);
    if (!Array.isArray(raw) || (count += raw.length) > MAX_ORGANIZATION_ITEMS)
      invalid("组织项目过多");
    result.folderItems[key] = raw.map(id);
  }
  return result;
}
export function assertOrganizationInvariants(
  value: NoteOrganizationV1Record,
  noteIds?: readonly string[],
): void {
  assertParsedOrganizationInvariants(parseOrganizationShape(value), noteIds);
}
function assertParsedOrganizationInvariants(
  organization: NoteOrganizationV1Record,
  noteIds?: readonly string[],
): void {
  const seen = new Set<string>(),
    folders = new Set<string>();
  const allowed = noteIds ? new Set(noteIds) : undefined;
  const visit = (noteId: string) => {
    if (seen.has(noteId) || (allowed && !allowed.has(noteId)))
      invalid("便签重复归属或引用不存在的便签");
    seen.add(noteId);
  };
  for (const item of organization.desktop) {
    if (item.type === "note") visit(item.id);
    else {
      if (folders.has(item.id) || !Object.hasOwn(organization.folders, item.id))
        invalid("文件夹重复或不存在");
      folders.add(item.id);
      const notes = organization.folderItems[item.id];
      if (!notes || notes.length < 2) invalid("文件夹至少需要两张便签");
      notes.forEach(visit);
    }
  }
  if (
    Object.keys(organization.folders).some((key) => !folders.has(key)) ||
    Object.keys(organization.folderItems).some((key) => !folders.has(key))
  )
    invalid("存在未放在桌面的文件夹");
  if (allowed && seen.size !== allowed.size) invalid("组织数据缺少现有便签");
}
export function parseNoteOrganization(
  value: unknown,
  noteIds?: readonly string[],
): NoteOrganizationV1Record {
  const result = parseOrganizationShape(value);
  assertParsedOrganizationInvariants(result, noteIds);
  return result;
}
export function parseSaveNoteOrganizationInput(
  value: unknown,
): SaveNoteOrganizationInput {
  const body = record(value);
  fields(body, ["organization", "expectedEtag"]);
  if (
    typeof body.expectedEtag !== "string" ||
    body.expectedEtag.length < 1 ||
    body.expectedEtag.length > 200
  )
    invalid("expectedEtag 必须是有效的保存基线");
  return {
    organization: parseNoteOrganization(body.organization),
    expectedEtag: body.expectedEtag,
  };
}
export function reconcileOrganization(
  input: unknown,
  noteIds: readonly string[],
): ReconcileResult {
  const source =
    input === undefined
      ? { version: 1 as const, folders: {}, desktop: [], folderItems: {} }
      : parseOrganizationShape(input);
  const organization: NoteOrganizationV1Record = {
    version: 1,
    folders: {},
    desktop: [],
    folderItems: {},
  };
  const known = new Set(noteIds),
    seen = new Set<string>(),
    seenFolders = new Set<string>();
  const take = (noteId: string) => {
    if (!known.has(noteId) || seen.has(noteId)) return false;
    seen.add(noteId);
    return true;
  };
  for (const item of source.desktop) {
    if (item.type === "note") {
      if (take(item.id)) organization.desktop.push(item);
      continue;
    }
    if (seenFolders.has(item.id) || !Object.hasOwn(source.folders, item.id))
      continue;
    seenFolders.add(item.id);
    const notes = (source.folderItems[item.id] ?? []).filter(take);
    if (notes.length < 2)
      organization.desktop.push(
        ...notes.map((noteId) => ({ type: "note" as const, id: noteId })),
      );
    else {
      organization.desktop.push(item);
      organization.folders[item.id] = { ...source.folders[item.id]! };
      organization.folderItems[item.id] = notes;
    }
  }
  for (const noteId of noteIds)
    if (take(noteId)) organization.desktop.push({ type: "note", id: noteId });
  assertOrganizationInvariants(organization, noteIds);
  return {
    organization,
    changed: JSON.stringify(source) !== JSON.stringify(organization),
  };
}
function copy(value: NoteOrganizationV1Record): NoteOrganizationV1Record {
  return structuredClone(value);
}
function finish(value: NoteOrganizationV1Record): NoteOrganizationV1Record {
  assertOrganizationInvariants(value);
  return value;
}
function detach(value: NoteOrganizationV1Record, noteId: string): void {
  value.desktop = value.desktop.filter(
    (item) => item.type !== "note" || item.id !== noteId,
  );
  for (const [folderId, notes] of Object.entries(value.folderItems)) {
    const remaining = notes.filter((item) => item !== noteId);
    value.folderItems[folderId] = remaining;
    if (remaining.length < 2) {
      value.desktop = value.desktop.flatMap((item) =>
        item.type === "folder" && item.id === folderId
          ? remaining.map((id) => ({ type: "note" as const, id }))
          : [item],
      );
      delete value.folders[folderId];
      delete value.folderItems[folderId];
    }
  }
}
function hasNote(value: NoteOrganizationV1Record, noteId: string): boolean {
  return (
    value.desktop.some((item) => item.type === "note" && item.id === noteId) ||
    Object.values(value.folderItems).some((notes) => notes.includes(noteId))
  );
}
function indexAt(index: number, length: number): number {
  return Math.max(
    0,
    Math.min(Number.isFinite(index) ? Math.trunc(index) : length, length),
  );
}
export function mergeNotes(
  value: NoteOrganizationV1Record,
  input: {
    activeNoteId: string;
    targetNoteId: string;
    folderId: string;
    folderName: string;
    now: number;
  },
): NoteOrganizationV1Record {
  const next = copy(value);
  if (
    input.activeNoteId === input.targetNoteId ||
    !hasNote(next, input.activeNoteId) ||
    !next.desktop.some(
      (item) => item.type === "note" && item.id === input.targetNoteId,
    ) ||
    Object.hasOwn(next.folders, input.folderId)
  )
    invalid("无法合成文件夹");
  folderId(input.folderId);
  detach(next, input.activeNoteId);
  const position = next.desktop.findIndex(
    (item) => item.type === "note" && item.id === input.targetNoteId,
  );
  next.desktop.splice(position, 1, { type: "folder", id: input.folderId });
  next.folders[input.folderId] = {
    name: validateFolderName(input.folderName),
    createdAt: input.now,
    updatedAt: input.now,
  };
  next.folderItems[input.folderId] = [input.targetNoteId, input.activeNoteId];
  return finish(next);
}
export function moveNoteToFolder(
  value: NoteOrganizationV1Record,
  input: {
    noteId: string;
    folderId: string;
    index?: number;
    folderIndex?: number;
  },
): NoteOrganizationV1Record {
  const next = copy(value),
    destination = next.folderItems[input.folderId];
  if (!destination || !hasNote(next, input.noteId)) invalid("无法移入文件夹");
  if (destination.includes(input.noteId))
    return reorderInContainer(value, {
      containerId: input.folderId,
      activeId: input.noteId,
      toIndex: input.index ?? input.folderIndex ?? destination.length,
    });
  detach(next, input.noteId);
  const notes = next.folderItems[input.folderId]!;
  notes.splice(
    indexAt(input.index ?? input.folderIndex ?? notes.length, notes.length),
    0,
    input.noteId,
  );
  return finish(next);
}
export function moveNoteToDesktop(
  value: NoteOrganizationV1Record,
  input: { noteId: string; desktopIndex: number },
): NoteOrganizationV1Record {
  const next = copy(value);
  if (!hasNote(next, input.noteId)) invalid("便签不存在");
  detach(next, input.noteId);
  next.desktop.splice(indexAt(input.desktopIndex, next.desktop.length), 0, {
    type: "note",
    id: input.noteId,
  });
  return finish(next);
}
export function dissolveFolder(
  value: NoteOrganizationV1Record,
  folderId: string,
): NoteOrganizationV1Record {
  const next = copy(value),
    notes = next.folderItems[folderId];
  if (!notes) invalid("文件夹不存在");
  next.desktop = next.desktop.flatMap((item) =>
    item.type === "folder" && item.id === folderId
      ? notes.map((id) => ({ type: "note" as const, id }))
      : [item],
  );
  delete next.folders[folderId];
  delete next.folderItems[folderId];
  return finish(next);
}
export function renameFolder(
  value: NoteOrganizationV1Record,
  input: { folderId: string; name: string; now: number },
): NoteOrganizationV1Record {
  const next = copy(value);
  if (!next.folders[input.folderId]) invalid("文件夹不存在");
  next.folders[input.folderId] = {
    ...next.folders[input.folderId]!,
    name: validateFolderName(input.name),
    updatedAt: input.now,
  };
  return finish(next);
}
export function reorderInContainer(
  value: NoteOrganizationV1Record,
  input: { containerId: string; activeId: string; toIndex: number },
): NoteOrganizationV1Record {
  const next = copy(value);
  if (input.containerId === "desktop") {
    const from = next.desktop.findIndex((item) => item.id === input.activeId);
    if (from < 0) invalid("桌面项目不存在");
    const [item] = next.desktop.splice(from, 1);
    next.desktop.splice(indexAt(input.toIndex, next.desktop.length), 0, item!);
  } else {
    const notes = next.folderItems[input.containerId];
    if (!notes) invalid("文件夹不存在");
    const from = notes.indexOf(input.activeId);
    if (from < 0) invalid("夹内便签不存在");
    notes.splice(from, 1);
    notes.splice(indexAt(input.toIndex, notes.length), 0, input.activeId);
  }
  return finish(next);
}
