import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, openSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseNoteOrganization,
  reconcileOrganization,
  type NoteOrganizationSnapshotRecord,
  type NoteOrganizationV1Record,
} from "@vykor/domain-contracts/notes";
import {
  ensureNoteDirectory,
  readUtf8File,
  replaceUtf8File,
} from "./markdown-note-files.js";

export type NoteOrganizationSnapshot = NoteOrganizationSnapshotRecord;
type DiskFile = ReturnType<typeof readUtf8File>;
const etagOf = (file: DiskFile): string =>
  file
    ? createHash("sha256")
        .update(file.content)
        .update(file.identity)
        .digest("hex")
    : "missing";
const serialize = (value: NoteOrganizationV1Record): string =>
  JSON.stringify(value, null, 2) + "\n";
function isFuture(value: unknown): boolean {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as { version?: unknown }).version === "number" &&
    Number((value as { version: number }).version) > 1
  );
}

export class NoteOrganizationConflictError extends Error {
  constructor(
    message = "组织文件已被外部修改，请重新操作。可打开便签目录查看 organization.json 和 organization.previous.json。",
  ) {
    super(message);
    this.name = "NoteOrganizationConflictError";
  }
}
export class NoteOrganizationReadOnlyError extends NoteOrganizationConflictError {
  constructor() {
    super("组织文件来自更新版本，请升级应用或恢复兼容版本。当前组织只读。");
    this.name = "NoteOrganizationReadOnlyError";
  }
}
export class NoteOrganizationRepository {
  readonly path: string;
  readonly previousPath: string;
  private queue: Promise<unknown> = Promise.resolve();
  private writeBlockedWarning: string | undefined;
  constructor(readonly directory: string) {
    this.path = join(directory, "organization.json");
    this.previousPath = join(directory, "organization.previous.json");
  }

  private replace(
    organization: NoteOrganizationV1Record,
    before: DiskFile,
    rotatePrevious = true,
  ): NoteOrganizationSnapshot {
    if (etagOf(readUtf8File(this.path)) !== etagOf(before))
      throw new NoteOrganizationConflictError();
    // This rotation protects the version just checked. Standard file APIs cannot
    // protect another process's write between this check and the final rename.
    if (before && rotatePrevious)
      replaceUtf8File(this.previousPath, before.content);
    const content = serialize(organization);
    const writtenFileKey = replaceUtf8File(this.path, content);
    const after = readUtf8File(this.path);
    if (
      !after ||
      after.content !== content ||
      after.fileKey !== writtenFileKey
    ) {
      this.writeBlockedWarning =
        "组织文件在保存后又被外部修改，已暂停整理写入。请打开便签目录检查 organization.json 与 organization.previous.json，再重启应用。";
      throw new NoteOrganizationConflictError(this.writeBlockedWarning);
    }
    return {
      organization,
      etag: etagOf(after),
      readOnly: false,
    };
  }

  read(noteIds: readonly string[]): NoteOrganizationSnapshot {
    ensureNoteDirectory(this.directory);
    const before = readUtf8File(this.path);
    if (this.writeBlockedWarning) {
      let organization = reconcileOrganization(undefined, noteIds).organization;
      try {
        const input: unknown = before ? JSON.parse(before.content) : undefined;
        if (!isFuture(input))
          organization = reconcileOrganization(input, noteIds).organization;
      } catch {
        /* A blocked writer must not repair the external file. */
      }
      return {
        organization,
        etag: etagOf(before),
        readOnly: true,
        warning: this.writeBlockedWarning,
      };
    }
    let input: unknown;
    let warning: string | undefined;
    try {
      input = before ? JSON.parse(before.content) : undefined;
      if (isFuture(input))
        return {
          organization: reconcileOrganization(undefined, noteIds).organization,
          etag: etagOf(before),
          readOnly: true,
          warning: new NoteOrganizationReadOnlyError().message,
        };
      const reconciled = reconcileOrganization(input, noteIds);
      if (!before || reconciled.changed) {
        // Keep previous usable: a repaired duplicate/single-note folder is not
        // itself a valid recovery snapshot. Preserve the earlier valid rotation.
        let rotatePrevious = true;
        if (before) {
          try {
            parseNoteOrganization(input);
          } catch {
            rotatePrevious = false;
          }
        }
        return this.replace(reconciled.organization, before, rotatePrevious);
      }
      return {
        organization: reconciled.organization,
        etag: etagOf(before),
        readOnly: false,
      };
    } catch (error) {
      if (error instanceof NoteOrganizationConflictError) throw error;
      // Only malformed content is recoverable; unsafe paths and write failures
      // propagate without replacing their contents.
      if (
        !(error instanceof SyntaxError) &&
        !(error instanceof Error && error.name === "DomainValidationError")
      )
        throw error;
      if (before) {
        const corruptPath = join(
          this.directory,
          `organization.corrupt-${Date.now()}-${randomUUID()}.json`,
        );
        const handle = openSync(corruptPath, "wx");
        try {
          writeFileSync(handle, before.content, "utf8");
          fsyncSync(handle);
        } finally {
          closeSync(handle);
        }
      }
      warning =
        "组织文件损坏，已保留带时间戳的副本并重建桌面。可打开便签目录恢复。";
    }
    return {
      ...this.replace(
        reconcileOrganization(undefined, noteIds).organization,
        before,
        false,
      ),
      warning,
    };
  }

  save(
    organization: NoteOrganizationV1Record,
    expectedEtag: string,
    noteIds: readonly string[] | (() => readonly string[]),
  ): Promise<NoteOrganizationSnapshot> {
    // Capture now so a caller cannot mutate a queued request.
    const requested = structuredClone(organization);
    const work = this.queue.then(() => {
      if (this.writeBlockedWarning)
        throw new NoteOrganizationConflictError(this.writeBlockedWarning);
      ensureNoteDirectory(this.directory);
      const validated = parseNoteOrganization(
        requested,
        typeof noteIds === "function" ? noteIds() : noteIds,
      );
      const before = readUtf8File(this.path);
      if (before) {
        try {
          if (isFuture(JSON.parse(before.content)))
            throw new NoteOrganizationReadOnlyError();
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
        }
      }
      if (etagOf(before) !== expectedEtag)
        throw new NoteOrganizationConflictError();
      if (before?.content === serialize(validated))
        return {
          organization: validated,
          etag: etagOf(before),
          readOnly: false,
        };
      return this.replace(validated, before);
    });
    this.queue = work.catch(() => undefined);
    return work;
  }
}

/** Restore validation never repairs or rewrites checksummed backup files. */
export function validateNoteOrganizationFiles(
  directory: string,
  noteIds: readonly string[],
  allowFuture = false,
): void {
  ensureNoteDirectory(directory);
  for (const name of ["organization.json", "organization.previous.json"]) {
    const file = readUtf8File(join(directory, name));
    if (!file) continue;
    const parsed: unknown = JSON.parse(file.content);
    if (isFuture(parsed)) {
      if (allowFuture) continue;
      throw new NoteOrganizationReadOnlyError();
    }
    // previous is a historical recovery copy and may refer to notes since deleted.
    parseNoteOrganization(
      parsed,
      name === "organization.json" ? noteIds : undefined,
    );
  }
}
