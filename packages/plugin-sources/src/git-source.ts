import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { tmpdir } from "node:os";

const execFileAsync = promisify(execFile);
const PRIVATE_PREFIX = "vykor-plugin-git-";
const GIT_TIMEOUT_MS = 2 * 60 * 1_000;
const MAX_GIT_OUTPUT = 512 * 1024;

export interface ResolvedGitPluginSource {
  url: string;
  ref?: string;
  commit: string;
  sourceDigest: string;
  candidateRoot: string;
  cleanup: () => Promise<void>;
}

export type GitRunner = (
  args: string[],
  options: { cwd: string },
) => Promise<{ stdout: string; stderr: string }>;

export interface ResolveGitPluginSourceInput {
  url: string;
  ref?: string;
  runGit?: GitRunner;
}

function gitSourceError(message: string): Error {
  return new Error(`Unsafe plugin git source: ${message}`);
}

function normalizeGitUrl(value: string): string {
  const url = value.trim();
  if (
    !url ||
    url.length > 2_048 ||
    url.startsWith("-") ||
    /[\0\r\n]/.test(url)
  ) {
    throw gitSourceError("invalid git source url");
  }

  try {
    const parsed = new URL(url);
    if (["https:", "http:", "ssh:", "file:"].includes(parsed.protocol)) return url;
  } catch {
    if (/^[\w.-]+@[\w.-]+:.+/.test(url) && !/\s/.test(url)) return url;
  }

  throw gitSourceError("invalid git source url");
}

function normalizeGitRef(value: string | undefined): string | undefined {
  const ref = value?.trim();
  if (!ref) return undefined;
  if (
    ref.length > 256 ||
    ref.startsWith("-") ||
    /[\0\r\n]/.test(ref)
  ) {
    throw gitSourceError("invalid git ref");
  }
  return ref;
}

function sourceDigest(input: { url: string; ref?: string; commit: string }): string {
  return createHash("sha256")
    .update("vykor-plugin-git-source-v1\0")
    .update(input.url)
    .update("\0")
    .update(input.ref ?? "")
    .update("\0")
    .update(input.commit)
    .digest("hex");
}

async function cleanupPrivateRoot(root: string): Promise<void> {
  const resolvedRoot = resolve(root);
  const resolvedTmp = resolve(tmpdir());
  if (resolve(join(resolvedRoot, "..")) !== resolvedTmp || !resolvedRoot.startsWith(join(resolvedTmp, PRIVATE_PREFIX))) {
    throw gitSourceError("refusing to clean an unknown temporary directory");
  }
  await rm(resolvedRoot, { recursive: true, force: true });
}

async function defaultGitRunner(args: string[], options: { cwd: string }): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync("git", args, {
    cwd: options.cwd,
    windowsHide: true,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: MAX_GIT_OUTPUT,
  });
  return { stdout, stderr };
}

export async function resolveGitPluginSource(input: ResolveGitPluginSourceInput): Promise<ResolvedGitPluginSource> {
  const url = normalizeGitUrl(input.url);
  const ref = normalizeGitRef(input.ref);
  const root = await mkdtemp(join(tmpdir(), PRIVATE_PREFIX));
  const runGit = input.runGit ?? defaultGitRunner;
  try {
    await runGit(["init"], { cwd: root });
    await runGit(["remote", "add", "origin", url], { cwd: root });
    await runGit(["-c", "advice.detachedHead=false", "fetch", "--depth=1", "origin", ref ?? "HEAD"], { cwd: root });
    await runGit(["-c", "advice.detachedHead=false", "checkout", "--detach", "FETCH_HEAD"], { cwd: root });
    const revision = await runGit(["rev-parse", "HEAD"], { cwd: root });
    const commit = revision.stdout.trim();
    if (!/^[a-f0-9]{40,64}$/i.test(commit)) throw gitSourceError("git returned an invalid commit");
    await rm(join(root, ".git"), { recursive: true, force: true });
    return {
      url,
      ...(ref ? { ref } : {}),
      commit,
      sourceDigest: sourceDigest({ url, ref, commit }),
      candidateRoot: root,
      cleanup: () => cleanupPrivateRoot(root),
    };
  } catch (error) {
    await cleanupPrivateRoot(root);
    throw error;
  }
}
