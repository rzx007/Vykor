import { StringDecoder } from "node:string_decoder";
import type { EnvironmentGrepOptions, EnvironmentGrepResult, EnvironmentProcess } from "@vykor/environment";
import { matchesGlob, MAX_LINE_BYTES } from "./host-search.js";

export const GREP_OUTPUT_BYTES = 8192;
export const GREP_LIMIT_HINT = "Results limited. Narrow path, include, or pattern; use Read for context.";

export class GrepSearchError extends Error {
  constructor(readonly kind: "invalid_input" | "interrupted" | "timeout" | "unknown_outcome", message: string) {
    super(message);
    this.name = "GrepSearchError";
  }
}

export function checkGrepOptions(pattern: string, options: EnvironmentGrepOptions): void {
  if (typeof pattern !== "string" || pattern.includes("\0") || pattern.length > 16384
    || !Number.isSafeInteger(options.limit) || options.limit < 0 || options.limit > 200
    || (options.maxBytes !== undefined && (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1))
    || (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1))) {
    throw new GrepSearchError("invalid_input", "Invalid search pattern, limit, or budget.");
  }
  if (options.signal?.aborted) throw new GrepSearchError("interrupted", "Search interrupted.");
}

/** The same cancellation signal covers metadata, traversal, regex evaluation and child processes. */
export async function withGrepDeadline(
  options: EnvironmentGrepOptions,
  search: (options: EnvironmentGrepOptions) => Promise<EnvironmentGrepResult>,
): Promise<EnvironmentGrepResult> {
  if (options.signal?.aborted) throw new GrepSearchError("interrupted", "Search interrupted.");
  const controller = new AbortController();
  let rejectFailure!: (error: Error) => void;
  const failure = new Promise<never>((_, reject) => { rejectFailure = reject; });
  const fail = (kind: "timeout" | "interrupted") => {
    rejectFailure(new GrepSearchError(kind, kind === "timeout" ? "Search timed out." : "Search interrupted."));
    controller.abort();
  };
  const abort = () => fail("interrupted");
  const timer = setTimeout(() => fail("timeout"), Math.min(options.timeoutMs ?? 30_000, 30_000));
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  try { return await Promise.race([search({ ...options, signal: controller.signal }), failure]); }
  finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }
}

function utf8Prefix(text: string, maxBytes: number): string {
  let size = 0;
  let end = 0;
  for (const { segment, index } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)) {
    const bytes = Buffer.byteLength(segment);
    if (size + bytes > maxBytes) break;
    size += bytes;
    end = index + segment.length;
  }
  return text.slice(0, end);
}

export class GrepCollector {
  readonly result: EnvironmentGrepResult = { matches: [], truncated: false };
  private bytes = 0;
  private readonly maxBytes: number;
  constructor(private readonly options: EnvironmentGrepOptions) {
    this.maxBytes = Math.min(options.maxBytes ?? GREP_OUTPUT_BYTES, GREP_OUTPUT_BYTES);
  }
  private accepts(line: string): boolean {
    const location = /^(.*?):\d+:/.exec(line);
    return !this.options.include || !location
      || matchesGlob(location[1]!.replaceAll("\\", "/"), this.options.include);
  }
  skipOversized(rawLine: string): void {
    if (this.accepts(rawLine.replace(/^\.[\\/]/, ""))) this.result.truncated = true;
  }
  /** False means the process can stop; exactly reaching limit does not prove truncation. */
  add(rawLine: string): boolean {
    const line = rawLine.replace(/\r$/, "").replace(/^\.[\\/]/, "");
    if (!line) return true;
    if (!this.accepts(line)) return true;
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) { this.result.truncated = true; return true; }
    if (this.result.matches.length >= this.options.limit) { this.result.truncated = true; return false; }
    const separator = this.result.matches.length ? 1 : 0;
    const available = this.maxBytes - this.bytes - separator;
    if (Buffer.byteLength(line) > available) {
      const snippet = utf8Prefix(line, available - 3);
      if (snippet) this.result.matches.push(`${snippet}…`);
      this.result.truncated = true;
      return false;
    }
    this.result.matches.push(line);
    this.bytes += separator + Buffer.byteLength(line);
    return true;
  }
}

/** Keeps at most one bounded line, including when a pipe chunk splits UTF-8 or CRLF. */
class GrepLineReader {
  private readonly decoder = new StringDecoder("utf8");
  private pending = "";
  private oversized = false;
  constructor(private readonly collector: GrepCollector) {}
  feed(chunk: Uint8Array): boolean { return this.consume(this.decoder.write(Buffer.from(chunk))); }
  finish(): void { if (this.consume(this.decoder.end()) && this.pending) this.collector.add(this.pending); }
  private consume(text: string): boolean {
    const parts = text.split("\n");
    for (let i = 0; i < parts.length; i++) {
      if (!this.oversized) {
        this.pending += parts[i]!;
        if (Buffer.byteLength(this.pending) > MAX_LINE_BYTES) {
          this.collector.skipOversized(this.pending);
          this.pending = "";
          this.oversized = true;
        }
      }
      if (i < parts.length - 1) {
        if (!this.oversized && !this.collector.add(this.pending)) return false;
        this.pending = "";
        this.oversized = false;
      }
    }
    return true;
  }
}

export async function consumeGrepProcess(
  start: (signal: AbortSignal) => EnvironmentProcess | Promise<EnvironmentProcess>,
  options: EnvironmentGrepOptions,
): Promise<EnvironmentGrepResult> {
  if (options.signal?.aborted) throw new GrepSearchError("interrupted", "Search interrupted.");
  const controller = new AbortController();
  let process: EnvironmentProcess | undefined;
  let failureReason: Error | undefined;
  const collector = new GrepCollector(options);
  const reader = new GrepLineReader(collector);
  const errorDecoder = new StringDecoder("utf8");
  let stopped = false;
  let stderr = "";
  let stop: (() => void) | undefined;
  let stopErrors: (() => void) | undefined;
  let rejectFailure!: (error: Error) => void;
  const failure = new Promise<never>((_, reject) => { rejectFailure = reject; });
  let terminationScheduled = false;
  const terminate = () => {
    controller.abort();
    if (!process || terminationScheduled) return;
    terminationScheduled = true;
    const child = process;
    // Let WSL's cancellation supervisor stop the Linux process before killing its transport.
    const fallback = setTimeout(() => { void child.signal("terminate").catch(() => {}); }, 250);
    fallback.unref?.();
    void child.wait().then(() => clearTimeout(fallback), () => clearTimeout(fallback));
  };
  const fail = (kind: "interrupted" | "timeout") => {
    failureReason = new GrepSearchError(kind, kind === "timeout" ? "Search timed out." : "Search interrupted.");
    controller.abort();
    terminate();
    rejectFailure(failureReason);
  };
  const abort = () => fail("interrupted");
  const timer = setTimeout(() => {
    fail("timeout");
  }, options.timeoutMs ?? 30_000);
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  try {
    const startup = Promise.resolve().then(() => {
      if (failureReason) throw failureReason;
      return start(controller.signal);
    });
    // A transport can finish launching after timeout/cancellation. Reap that process too.
    void startup.then((child) => {
      process = child;
      if (failureReason) terminate();
    }, () => {});
    process = await Promise.race([startup, failure]);
    if (failureReason) throw failureReason;
    stop = process.onOutput((chunk) => {
      if (!stopped && !reader.feed(chunk)) { stopped = true; terminate(); }
    });
    stopErrors = process.onErrorOutput?.((chunk) => {
      stderr = utf8Prefix(stderr + errorDecoder.write(Buffer.from(chunk)), 4096);
    });
    process.end();
    const result = await Promise.race([process.wait(), failure]);
    if (!stopped) reader.finish();
    if (stopped || result.exitCode === 0 || result.exitCode === 1) return collector.result;
    if (result.exitCode === 127) {
      const error = new Error("ripgrep is unavailable.") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    }
    const kind = /regex (?:parse|syntax) error:|error parsing (?:regex|glob)/i.test(stderr) ? "invalid_input" : "unknown_outcome";
    throw new GrepSearchError(kind, stderr.trim() || `Search failed with exit code ${result.exitCode}.`);
  } catch (error) {
    terminate();
    if (stopped && !failureReason) return collector.result;
    throw failureReason ?? error;
  } finally {
    clearTimeout(timer);
    stop?.(); stopErrors?.();
    options.signal?.removeEventListener("abort", abort);
  }
}
