import { createHash, randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import {
  AttachmentBlobStore,
  AttachmentIntegrityService,
  DEFAULT_RETENTION_POLICY,
  SessionStore,
} from "@vykor/services";

export interface BackupSourceDirectories {
  artifacts?: string;
  memory?: string;
  executionOutput?: string;
  attachments?: string;
}

export interface ApplicationBackupManifest {
  version: 1 | 2;
  backupId: string;
  createdAt: number;
  database: "database.sqlite";
  directories: Record<"artifacts" | "memory" | "execution-output" | "attachments", boolean>;
  attachments?: {
    assets: number;
    uniqueBlobs: number;
    physicalBytes: number;
    consistency: {
      errors: number;
      warnings: number;
      issueCounts: Record<string, number>;
    };
  };
  recovery: {
    reviveLiveProcesses: false;
    closeActiveRecordsOnStartup: true;
  };
}

export async function createApplicationBackup(input: {
  store: SessionStore;
  destination: string;
  sources?: BackupSourceDirectories;
}): Promise<ApplicationBackupManifest> {
  const destination = resolve(input.destination);
  if (existsSync(destination) && readdirSync(destination).length > 0) {
    throw new Error(`Backup destination is not empty: ${destination}`);
  }
  for (const source of [input.sources?.artifacts, input.sources?.memory, input.sources?.executionOutput]) {
    if (source) assertDestinationOutsideSource(destination, source);
  }
  if (input.sources?.attachments) assertDestinationOutsideSource(destination, input.sources.attachments);
  const attachmentStats = validateAttachmentFiles(
    input.store,
    input.sources?.attachments,
  );
  const attachmentConsistency = input.sources?.attachments
    ? summarizeAttachmentIntegrity(await new AttachmentIntegrityService({
        store: input.store,
        attachments: input.store.attachments,
        blobs: new AttachmentBlobStore({ root: input.sources.attachments }),
      }).scan({ gracePeriodMs: DEFAULT_RETENTION_POLICY.attachmentGracePeriodMs }))
    : { errors: 0, warnings: 0, issueCounts: {} };
  mkdirSync(destination, { recursive: true });
  await input.store.backupDatabase(join(destination, "database.sqlite"));
  const directories = {
    artifacts: copyOptionalDirectory(input.sources?.artifacts, join(destination, "artifacts")),
    memory: copyOptionalDirectory(input.sources?.memory, join(destination, "memory")),
    "execution-output": copyOptionalDirectory(
      input.sources?.executionOutput,
      join(destination, "execution-output"),
    ),
    attachments: copyOptionalDirectory(
      input.sources?.attachments,
      join(destination, "attachments"),
    ),
  };
  const manifest: ApplicationBackupManifest = {
    version: 2,
    backupId: randomUUID(),
    createdAt: Date.now(),
    database: "database.sqlite",
    directories,
    attachments: { ...attachmentStats, consistency: attachmentConsistency },
    recovery: {
      reviveLiveProcesses: false,
      closeActiveRecordsOnStartup: true,
    },
  };
  writeFileSync(join(destination, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf-8");
  writeFileSync(
    join(destination, "checksums.json"),
    JSON.stringify(checksumsFor(destination, ["checksums.json"]), null, 2) + "\n",
    "utf-8",
  );
  validateBackupAttachmentFiles(destination, manifest);
  return manifest;
}

export function restoreApplicationBackup(input: {
  source: string;
  storePath: string;
  destinations?: BackupSourceDirectories;
}): ApplicationBackupManifest {
  const source = resolve(input.source);
  const manifest = JSON.parse(readFileSync(join(source, "manifest.json"), "utf-8")) as ApplicationBackupManifest;
  if (![1, 2].includes(manifest.version) || manifest.database !== "database.sqlite") {
    throw new Error("Unsupported backup manifest");
  }
  if (!isDirectoryManifest(manifest.directories)) {
    throw new Error("Invalid backup directory manifest");
  }
  verifyChecksums(source);
  validateBackupAttachmentFiles(source, manifest);
  const storePath = resolve(input.storePath);
  if (existsSync(storePath)) throw new Error(`Restore Store already exists: ${storePath}`);
  const restoreId = randomUUID();
  const targets: RestoreTarget[] = [
    createRestoreTarget(storePath, "file", restoreId),
    ...optionalRestoreTargets(input.destinations, manifest, restoreId),
  ];
  validateRestoreTargetLayout(source, targets);
  for (const target of targets) preflightRestoreTarget(target);
  if (manifest.directories.attachments && !input.destinations?.attachments) {
    throw new Error("Attachment restore is incomplete: attachment destination is required");
  }
  try {
    stageRestoreTarget(targets[0]!, join(source, manifest.database));
    stageOptionalRestoreTarget(targets, input.destinations?.artifacts, join(source, "artifacts"));
    stageOptionalRestoreTarget(targets, input.destinations?.memory, join(source, "memory"));
    stageOptionalRestoreTarget(
      targets,
      input.destinations?.executionOutput,
      join(source, "execution-output"),
    );
    stageOptionalRestoreTarget(targets, input.destinations?.attachments, join(source, "attachments"));
    validateStagedRestore(targets, storePath, input.destinations?.attachments, manifest);
    commitRestoreTargets(targets);
    return manifest;
  } catch (error) {
    rollbackRestoreTargets(targets);
    throw error;
  }
}

function copyOptionalDirectory(source: string | undefined, destination: string): boolean {
  if (!source || !existsSync(source) || !statSync(source).isDirectory()) return false;
  cpSync(resolve(source), destination, { recursive: true });
  return true;
}

function assertDestinationOutsideSource(destination: string, source: string): void {
  const sourceRoot = resolve(source);
  const nested = relative(sourceRoot, destination);
  if (nested === "" || (!nested.startsWith("..") && !isAbsolute(nested))) {
    throw new Error(`Backup destination cannot be inside a source directory: ${destination}`);
  }
}

interface RestoreTarget {
  finalPath: string;
  stagePath: string;
  holdPath: string;
  kind: "file" | "directory";
  hadEmptyFinal: boolean;
  heldFinal: boolean;
  committed: boolean;
}

function createRestoreTarget(
  finalPath: string,
  kind: RestoreTarget["kind"],
  restoreId: string,
): RestoreTarget {
  const resolved = resolve(finalPath);
  const stem = `.${basename(resolved)}.restore-${restoreId}`;
  return {
    finalPath: resolved,
    stagePath: join(dirname(resolved), `${stem}.stage`),
    holdPath: join(dirname(resolved), `${stem}.empty`),
    kind,
    hadEmptyFinal: false,
    heldFinal: false,
    committed: false,
  };
}

function optionalRestoreTargets(
  destinations: BackupSourceDirectories | undefined,
  manifest: ApplicationBackupManifest,
  restoreId: string,
): RestoreTarget[] {
  const entries: Array<[string | undefined, boolean | undefined]> = [
    [destinations?.artifacts, manifest.directories.artifacts],
    [destinations?.memory, manifest.directories.memory],
    [destinations?.executionOutput, manifest.directories["execution-output"]],
    [destinations?.attachments, manifest.directories.attachments],
  ];
  return entries
    .filter((entry): entry is [string, true] => Boolean(entry[0] && entry[1]))
    .map(([destination]) => createRestoreTarget(destination, "directory", restoreId));
}

function preflightRestoreTarget(target: RestoreTarget): void {
  for (const temporary of [target.stagePath, target.holdPath]) {
    if (existsSync(temporary)) throw new Error(`Restore temporary path already exists: ${temporary}`);
  }
  if (!existsSync(target.finalPath)) return;
  if (target.kind === "file") throw new Error(`Restore Store already exists: ${target.finalPath}`);
  const stat = statSync(target.finalPath);
  if (!stat.isDirectory() || readdirSync(target.finalPath).length > 0) {
    throw new Error(`Restore directory is not empty: ${target.finalPath}`);
  }
  target.hadEmptyFinal = true;
}

function validateRestoreTargetLayout(source: string, targets: RestoreTarget[]): void {
  const unique = new Set<string>();
  for (const target of targets) {
    const normalized = target.finalPath.toLocaleLowerCase();
    if (unique.has(normalized)) {
      throw new Error(`Restore targets must be distinct: ${target.finalPath}`);
    }
    unique.add(normalized);
    const fromSource = relative(source, target.finalPath);
    if (fromSource === "" || (!fromSource.startsWith("..") && !isAbsolute(fromSource))) {
      throw new Error(`Restore target cannot be inside the backup source: ${target.finalPath}`);
    }
  }
  for (const left of targets) {
    for (const right of targets) {
      if (left === right) continue;
      const nested = relative(left.finalPath, right.finalPath);
      if (nested === "" || (!nested.startsWith("..") && !isAbsolute(nested))) {
        throw new Error(`Restore targets cannot contain one another: ${right.finalPath}`);
      }
    }
  }
}

function stageRestoreTarget(target: RestoreTarget, source: string): void {
  mkdirSync(dirname(target.stagePath), { recursive: true });
  cpSync(source, target.stagePath, target.kind === "directory" ? { recursive: true } : undefined);
}

function stageOptionalRestoreTarget(
  targets: RestoreTarget[],
  destination: string | undefined,
  source: string,
): void {
  if (!destination) return;
  const target = targets.find((candidate) => candidate.finalPath === resolve(destination));
  if (target) stageRestoreTarget(target, source);
}

function validateStagedRestore(
  targets: RestoreTarget[],
  storePath: string,
  attachmentsPath: string | undefined,
  manifest: ApplicationBackupManifest,
): void {
  const databaseTarget = targets.find((target) => target.finalPath === resolve(storePath))!;
  const attachmentTarget = attachmentsPath
    ? targets.find((target) => target.finalPath === resolve(attachmentsPath))
    : undefined;
  const database = new SessionStore({ path: databaseTarget.stagePath });
  try {
    const stats = validateAttachmentFiles(database, attachmentTarget?.stagePath);
    if (manifest.version === 2 && manifest.attachments && (
      manifest.attachments.assets !== stats.assets ||
      manifest.attachments.uniqueBlobs !== stats.uniqueBlobs ||
      manifest.attachments.physicalBytes !== stats.physicalBytes
    )) {
      throw new Error("Attachment restore is inconsistent with its manifest");
    }
  } finally {
    database.close();
  }
}

function summarizeAttachmentIntegrity(report: {
  issues: Array<{ code: string; severity: "warning" | "error" }>;
}): NonNullable<ApplicationBackupManifest["attachments"]>["consistency"] {
  const issueCounts: Record<string, number> = {};
  let errors = 0;
  let warnings = 0;
  for (const issue of report.issues) {
    issueCounts[issue.code] = (issueCounts[issue.code] ?? 0) + 1;
    if (issue.severity === "error") errors++;
    else warnings++;
  }
  if (errors > 0) throw new Error("Attachment backup is inconsistent");
  return { errors, warnings, issueCounts };
}

function commitRestoreTargets(targets: RestoreTarget[]): void {
  for (const target of targets) {
    if (target.hadEmptyFinal) {
      renameSync(target.finalPath, target.holdPath);
      target.heldFinal = true;
    }
    renameSync(target.stagePath, target.finalPath);
    target.committed = true;
  }
  for (const target of targets) {
    if (target.heldFinal) {
      removeRestorePath(target.holdPath);
      target.heldFinal = false;
    }
  }
}

function rollbackRestoreTargets(targets: RestoreTarget[]): void {
  for (const target of [...targets].reverse()) {
    if (target.committed) removeRestorePath(target.finalPath);
    removeRestorePath(target.stagePath);
    if (target.heldFinal && existsSync(target.holdPath)) {
      renameSync(target.holdPath, target.finalPath);
      target.heldFinal = false;
    } else if (target.committed && target.hadEmptyFinal && !existsSync(target.finalPath)) {
      mkdirSync(target.finalPath, { recursive: false });
    } else {
      removeRestorePath(target.holdPath);
    }
  }
}

function removeRestorePath(path: string): void {
  if (!existsSync(path)) return;
  rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
}

function checksumsFor(root: string, excluded: string[]): Record<string, string> {
  const checksums: Record<string, string> = {};
  for (const path of walkFiles(root)) {
    const name = relative(root, path).replaceAll("\\", "/");
    if (excluded.includes(name)) continue;
    checksums[name] = createHash("sha256").update(readFileSync(path)).digest("hex");
  }
  return checksums;
}

function verifyChecksums(root: string): void {
  const expected = JSON.parse(readFileSync(join(root, "checksums.json"), "utf-8")) as Record<string, string>;
  const actual = checksumsFor(root, ["checksums.json"]);
  const names = Object.keys(actual).sort();
  const expectedNames = Object.keys(expected).sort();
  if (
    names.length !== expectedNames.length ||
    names.some((name, index) => name !== expectedNames[index] || actual[name] !== expected[name])
  ) {
    throw new Error("Backup checksum verification failed");
  }
}

function walkFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(path));
    else if (entry.isFile()) files.push(path);
    else throw new Error(`Backup contains unsupported filesystem entry: ${path}`);
  }
  return files.sort();
}

function isDirectoryManifest(value: unknown): value is ApplicationBackupManifest["directories"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.artifacts === "boolean" &&
    typeof candidate.memory === "boolean" &&
    typeof candidate["execution-output"] === "boolean" &&
    (typeof candidate.attachments === "boolean" || candidate.attachments === undefined);
}

function validateAttachmentFiles(
  store: Pick<SessionStore, "attachments">,
  attachmentsRoot: string | undefined,
): Omit<NonNullable<ApplicationBackupManifest["attachments"]>, "consistency"> {
  const assets = store.attachments.listAttachments({ includeDeleted: true })
    .filter((asset) => asset.sha256 && asset.sizeBytes !== undefined);
  const unique = new Map<string, number>();
  for (const asset of assets) unique.set(asset.sha256!, asset.sizeBytes!);
  if (unique.size > 0 && !attachmentsRoot) {
    throw new Error(`Attachment backup is incomplete: missing attachment directory for ${assets[0]!.id}`);
  }
  let physicalBytes = 0;
  for (const [sha256, expectedSize] of unique) {
    const path = join(resolve(attachmentsRoot!), "blobs", sha256.slice(0, 2), sha256);
    if (!existsSync(path)) {
      const asset = assets.find((candidate) => candidate.sha256 === sha256)!;
      throw new Error(`Attachment backup is incomplete: missing blob for ${asset.id}`);
    }
    const stat = statSync(path);
    if (!stat.isFile() || stat.size !== expectedSize) {
      const asset = assets.find((candidate) => candidate.sha256 === sha256)!;
      throw new Error(`Attachment backup is incomplete: corrupt blob for ${asset.id}`);
    }
    physicalBytes += stat.size;
  }
  return { assets: assets.length, uniqueBlobs: unique.size, physicalBytes };
}

function validateBackupAttachmentFiles(
  source: string,
  manifest: ApplicationBackupManifest,
): void {
  const database = new SessionStore({ path: join(source, manifest.database) });
  try {
    const stats = validateAttachmentFiles(
      database,
      manifest.directories.attachments ? join(source, "attachments") : undefined,
    );
    if (manifest.version === 1 && stats.assets > 0) {
      throw new Error("Attachment backup is incomplete: version 1 backup contains attachment records without blobs");
    }
    if (manifest.version === 2 && manifest.attachments && (
      manifest.attachments.assets !== stats.assets ||
      manifest.attachments.uniqueBlobs !== stats.uniqueBlobs ||
      manifest.attachments.physicalBytes !== stats.physicalBytes
    )) {
      throw new Error("Attachment backup manifest does not match its database and blobs");
    }
  } finally {
    database.close();
  }
}
