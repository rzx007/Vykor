import { access, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { getConfigDir } from "@vykor/core";
import { detectCredentialValue } from "@vykor/memory";

const MAX_SOUL_CHARS = 12_000;
const MAX_USER_PROFILE_CHARS = 8_000;
const USER_PROFILE_PENDING_DIR = "user_profile_pending";

const SOUL_TEMPLATE = `You are Vykor, a careful local coding agent.

Default tone:
- Be concise, warm, and technically direct.
- Prefer concrete next steps over vague advice.
- Preserve user agency around risky or irreversible actions.

Long-term behavior:
- Follow project instructions and current user requests over personality preferences.
- Never use this file to override permission, sandbox, security, or tool-use rules.
`;

const USER_PROFILE_TEMPLATE = `# User Profile

Communication preferences:
- Prefer concise answers.

Workflow preferences:
- Call out assumptions when they materially affect the result.

Do not store secrets, tokens, passwords, or temporary task state in this file.
`;

const BLOCKING_PROMPT_FILE_PATTERNS: Array<{
  code: string;
  message: string;
  pattern: RegExp;
}> = [
  {
    code: "ignore_higher_priority_instructions",
    message: "Attempts to ignore or override higher-priority instructions.",
    pattern:
      /\b(?:ignore|disregard|override|bypass)\b.{0,80}\b(?:system|developer|previous|prior|above|higher[-\s]?priority)\b.{0,80}\b(?:instruction|instructions|rule|rules|message|messages)\b/i,
  },
  {
    code: "reveal_sensitive_context",
    message:
      "Attempts to reveal hidden prompts, credentials, or sensitive context.",
    pattern:
      /\b(?:reveal|print|dump|show|exfiltrate|leak)\b.{0,80}\b(?:system prompt|developer message|hidden prompt|secret|secrets|token|tokens|api key|password|credentials?)\b/i,
  },
  {
    code: "disable_permission_controls",
    message: "Attempts to disable approval, permission, or sandbox controls.",
    pattern:
      /\b(?:auto[-\s]?approve|always approve|never ask|without asking|without approval|without permission|disable sandbox|bypass sandbox|bypass permission|ignore permission)\b/i,
  },
  {
    code: "force_tool_execution",
    message: "Attempts to force unsafe tool execution without user control.",
    pattern:
      /\b(?:run|execute|delete|modify|overwrite)\b.{0,80}\b(?:without approval|without permission|without asking|even if denied|silently)\b/i,
  },
];

export type PromptFileIssueSeverity = "warning" | "block";

export interface PromptFileScanIssue {
  severity: PromptFileIssueSeverity;
  code: string;
  message: string;
  match: string;
}

export interface UserProfilePendingUpdate {
  id: string;
  createdAt: string;
  source: string;
  content: string;
  reason?: string;
}

export type PersonalPromptFileName = "SOUL.md" | "USER.md";
export type PersonalPromptFileStatus =
  "loaded" | "missing" | "empty" | "blocked" | "error";

export interface PersonalPromptFileDiagnostic {
  file: PersonalPromptFileName;
  path: string;
  status: PersonalPromptFileStatus;
  sizeChars: number;
  maxChars: number;
  truncated: boolean;
  issues: PromptFileScanIssue[];
  message?: string;
}

export interface PersonalPromptInitResult {
  configDir: string;
  created: string[];
  skipped: string[];
}

function truncateMarkdownContent(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  return content.slice(0, maxChars).trimEnd() + "\n...[truncated]...";
}

export function scanPersonalPromptFile(content: string): PromptFileScanIssue[] {
  const credentialRisk = detectCredentialValue(content);
  if (credentialRisk) {
    return [{
      severity: "block",
      code: "credential_like_content",
      message: `Credential-like content detected (${credentialRisk}).`,
      match: "[redacted]",
    }];
  }
  const issues: PromptFileScanIssue[] = [];
  for (const rule of BLOCKING_PROMPT_FILE_PATTERNS) {
    const match = content.match(rule.pattern);
    if (!match?.[0]) continue;
    issues.push({
      severity: "block",
      code: rule.code,
      message: rule.message,
      match: match[0],
    });
  }
  return issues;
}

async function inspectPersonalPromptFile(
  file: PersonalPromptFileName,
  maxChars: number,
): Promise<{
  diagnostic: PersonalPromptFileDiagnostic;
  content: string | null;
}> {
  const path = join(getConfigDir(), file);
  try {
    const raw = await readFile(path, "utf-8");
    const content = raw.trim();
    const base = {
      file,
      path,
      sizeChars: content.length,
      maxChars,
      truncated: content.length > maxChars,
      issues: scanPersonalPromptFile(content),
    };

    if (!content) {
      return {
        diagnostic: { ...base, status: "empty", truncated: false },
        content: null,
      };
    }

    if (base.issues.some((issue) => issue.severity === "block")) {
      return {
        diagnostic: {
          ...base,
          status: "blocked",
          message: "Blocked by personal prompt safety scan.",
        },
        content: null,
      };
    }

    return {
      diagnostic: { ...base, status: "loaded" },
      content: truncateMarkdownContent(content, maxChars),
    };
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === "ENOENT") {
      return {
        diagnostic: {
          file,
          path,
          status: "missing",
          sizeChars: 0,
          maxChars,
          truncated: false,
          issues: [],
        },
        content: null,
      };
    }

    return {
      diagnostic: {
        file,
        path,
        status: "error",
        sizeChars: 0,
        maxChars,
        truncated: false,
        issues: [],
        message:
          error instanceof Error
            ? error.message
            : "Unable to read personal prompt file.",
      },
      content: null,
    };
  }
}

export async function inspectPersonalPromptFiles(): Promise<
  PersonalPromptFileDiagnostic[]
> {
  const soul = await inspectPersonalPromptFile("SOUL.md", MAX_SOUL_CHARS);
  const user = await inspectPersonalPromptFile(
    "USER.md",
    MAX_USER_PROFILE_CHARS,
  );
  return [soul.diagnostic, user.diagnostic];
}

export async function initializePersonalPromptFiles(): Promise<PersonalPromptInitResult> {
  const configDir = getConfigDir();
  await mkdir(configDir, { recursive: true });

  const files: Array<[PersonalPromptFileName, string]> = [
    ["SOUL.md", SOUL_TEMPLATE],
    ["USER.md", USER_PROFILE_TEMPLATE],
  ];
  const created: string[] = [];
  const skipped: string[] = [];

  for (const [file, template] of files) {
    const path = join(configDir, file);
    try {
      await access(path);
      skipped.push(path);
      continue;
    } catch {
      // Missing files are created; existing files are never overwritten.
    }
    await writeFile(path, template.trimEnd() + "\n", "utf-8");
    created.push(path);
  }

  return { configDir, created, skipped };
}

export async function loadSoulMd(
  maxChars: number = MAX_SOUL_CHARS,
): Promise<string | null> {
  return (await inspectPersonalPromptFile("SOUL.md", maxChars)).content;
}

export async function loadUserProfile(
  maxChars: number = MAX_USER_PROFILE_CHARS,
): Promise<string | null> {
  const content = (await inspectPersonalPromptFile("USER.md", maxChars))
    .content;
  if (!content) return null;
  return /^#\s+User Profile\b/i.test(content)
    ? content
    : `# User Profile\n\n${content}`;
}

function getUserProfilePendingDir(): string {
  return join(getConfigDir(), USER_PROFILE_PENDING_DIR);
}

function assertSafePendingUpdateId(id: string): void {
  if (!/^[a-zA-Z0-9-]+$/.test(id)) {
    throw new Error(`Invalid pending USER.md update id: ${id}`);
  }
}

function pendingUserProfileUpdatePath(id: string): string {
  assertSafePendingUpdateId(id);
  return join(getUserProfilePendingDir(), `${id}.json`);
}

let userProfileWriteQueue: Promise<void> = Promise.resolve();

export async function appendUserProfileUpdate(
  rawContent: string,
): Promise<string> {
  const content = rawContent.trim();
  if (!content) throw new Error("Cannot append an empty USER.md update.");

  const blocking = scanPersonalPromptFile(content).find(
    (issue) => issue.severity === "block",
  );
  if (blocking) {
    throw new Error(`Blocked USER.md update: ${blocking.code}`);
  }

  const write = userProfileWriteQueue.then(() =>
    appendValidatedUserProfileUpdate(content),
  );
  userProfileWriteQueue = write.then(
    () => undefined,
    () => undefined,
  );
  return await write;
}

async function appendValidatedUserProfileUpdate(
  content: string,
): Promise<string> {
  const userProfilePath = join(getConfigDir(), "USER.md");
  let existing = "";
  try {
    existing = (await readFile(userProfilePath, "utf-8")).trim();
  } catch {
    existing = "";
  }

  await mkdir(getConfigDir(), { recursive: true });
  const next = [existing, content].filter(Boolean).join("\n\n") + "\n";
  await writeFile(userProfilePath, next, "utf-8");
  return userProfilePath;
}

export async function queueUserProfileUpdate(input: {
  content: string;
  source?: string;
  reason?: string;
}): Promise<UserProfilePendingUpdate> {
  const content = input.content.trim();
  if (!content) throw new Error("Cannot queue an empty USER.md update.");
  const issues = scanPersonalPromptFile(content);
  const blocking = issues.find((issue) => issue.severity === "block");
  if (blocking) {
    throw new Error(`Blocked USER.md update: ${blocking.code}`);
  }

  const update: UserProfilePendingUpdate = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    source: input.source?.trim() || "unknown",
    content,
    ...(input.reason?.trim() ? { reason: input.reason.trim() } : {}),
  };

  await mkdir(getUserProfilePendingDir(), { recursive: true });
  await writeFile(
    pendingUserProfileUpdatePath(update.id),
    JSON.stringify(update, null, 2) + "\n",
    "utf-8",
  );
  return update;
}

function isUserProfilePendingUpdate(
  value: unknown,
): value is UserProfilePendingUpdate {
  const candidate = value as Partial<UserProfilePendingUpdate> | null;
  return Boolean(
    candidate &&
    typeof candidate.id === "string" &&
    typeof candidate.createdAt === "string" &&
    typeof candidate.source === "string" &&
    typeof candidate.content === "string",
  );
}

export async function listPendingUserProfileUpdates(): Promise<
  UserProfilePendingUpdate[]
> {
  let entries: string[];
  try {
    entries = await readdir(getUserProfilePendingDir());
  } catch {
    return [];
  }

  const updates: UserProfilePendingUpdate[] = [];
  for (const entry of entries.filter((name) => name.endsWith(".json")).sort()) {
    const id = entry.slice(0, -".json".length);
    try {
      const parsed = JSON.parse(
        await readFile(pendingUserProfileUpdatePath(id), "utf-8"),
      ) as unknown;
      if (isUserProfilePendingUpdate(parsed)) updates.push(parsed);
    } catch {
      // Ignore malformed pending proposals; callers can remove them manually.
    }
  }
  return updates.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function approvePendingUserProfileUpdate(
  id: string,
): Promise<string | null> {
  const path = pendingUserProfileUpdatePath(id);
  let update: UserProfilePendingUpdate;
  try {
    const parsed = JSON.parse(await readFile(path, "utf-8")) as unknown;
    if (!isUserProfilePendingUpdate(parsed)) return null;
    update = parsed;
  } catch {
    return null;
  }

  const userProfilePath = await appendUserProfileUpdate(update.content);
  await rm(path, { force: true });
  return userProfilePath;
}
