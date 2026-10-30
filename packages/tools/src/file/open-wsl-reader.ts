import type { EnvironmentFileReader, ExecutionEnvironmentHandle } from "@vykor/environment";

// Metadata is emitted before stdin grants the read. All later bytes come from this same held fd.
const OPEN_SCRIPT = `if [ ! -e "$1" ]; then exit 3; fi
if [ ! -f "$1" ]; then exit 4; fi
exec 3< "$1" || exit 13
if [ ! -f /proc/$$/fd/3 ]; then exit 4; fi
/usr/bin/readlink -z -- /proc/$$/fd/3 || exit 6
/usr/bin/stat -L --printf '%s\\t%Y\\0' -- /proc/$$/fd/3 || exit 6
IFS= read -r count || exit 0
case "$count" in ''|*[!0-9]*) exit 6;; esac
exec /usr/bin/head -c "$count" <&3`;

function fileError(code: string, message: string): Error & {code:string} { return Object.assign(new Error(message), {code}); }
function exitError(code: number | null): Error {
  return code === 3 ? fileError("ENOENT", "File not found")
    : code === 4 ? fileError("EFTYPE", "Expected a regular file")
    : code === 13 ? fileError("EACCES", "Cannot open file")
    : fileError("ENOTSUP", "The environment cannot identify the opened file");
}

export async function openWslFileReader(environment: ExecutionEnvironmentHandle, path: string, signal?: AbortSignal): Promise<EnvironmentFileReader> {
  signal?.throwIfAborted();
  const process = await environment.process.execProcess(["/bin/sh", "-c", OPEN_SCRIPT, "vk-open-read", path], {
    cwd: environment.workspace.executionRoot, signal,
  });
  let resolveHeader!: (value: Buffer) => void, rejectHeader!: (error: unknown) => void;
  const ready = new Promise<Buffer>((resolve, reject) => { resolveHeader = resolve; rejectHeader = reject; });
  let header = Buffer.alloc(0), complete = false, failure: unknown, maximum = 0, received = 0, started = false, closed = false;
  const chunks: Buffer[] = [];
  const fail = (error: unknown) => {
    failure ??= error; rejectHeader(error);
    void process.signal("terminate").catch(() => {});
  };
  const stop = process.onOutput(chunk => {
    if (!complete) {
      header = Buffer.concat([header, chunk]);
      const first = header.indexOf(0), second = first < 0 ? -1 : header.indexOf(0, first + 1);
      if (header.length > 16 * 1024) { fail(fileError("ENOTSUP", "Opened file metadata exceeded its limit")); return; }
      if (second < 0) return;
      // The fixed script cannot emit content until readBytes sends the limit.
      if (second + 1 !== header.length) { fail(fileError("ENOTSUP", "Unexpected data before file authorization")); return; }
      complete = true; resolveHeader(header.subarray(0, second)); header = Buffer.alloc(0);
      return;
    }
    received += chunk.byteLength;
    if (!started || received > maximum) { fail(fileError("ENOTSUP", "Opened file exceeded the authorized read limit")); return; }
    chunks.push(Buffer.from(chunk));
  });
  const exit = process.wait();
  void exit.then(result => { if (!complete) rejectHeader(exitError(result.exitCode)); }, rejectHeader);
  let closing:Promise<void>|undefined;
  const close = ():Promise<void> => {
    if (closing) return closing;
    closed = true;
    return closing=(async()=>{
      process.end();
      try { await exit.catch(() => {}); } finally { stop(); }
    })();
  };
  try {
    const metadata = await ready;
    signal?.throwIfAborted();
    const separator = metadata.indexOf(0);
    const canonicalPath = new TextDecoder("utf-8", {fatal:true}).decode(metadata.subarray(0, separator));
    const [size, seconds] = metadata.subarray(separator + 1).toString("ascii").trim().split("\t").map(Number);
    if (!canonicalPath.startsWith("/") || canonicalPath.endsWith(" (deleted)") || !Number.isSafeInteger(size) || size! < 0 || !Number.isFinite(seconds)) {
      throw fileError("ENOTSUP", "Opened file metadata could not be verified");
    }
    return {
      canonicalPath, stat: {isFile:true,isDirectory:false,sizeBytes:size,modifiedAt:seconds! * 1000},
      async readBytes(options) {
        signal?.throwIfAborted(); options.signal?.throwIfAborted();
        if (started || closed) throw new Error("Opened file reader has already been consumed or closed");
        if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0) throw new RangeError("maxBytes must be a non-negative safe integer");
        started = true; maximum = options.maxBytes;
        const abort = () => { void process.signal("terminate").catch(() => {}); };
        options.signal?.addEventListener("abort", abort, {once:true});
        try {
          process.write(`${maximum}\n`); process.end();
          const result = await exit;
          signal?.throwIfAborted(); options.signal?.throwIfAborted();
          if (failure) throw failure;
          if (result.exitCode !== 0) throw exitError(result.exitCode);
          return Buffer.concat(chunks);
        } finally { options.signal?.removeEventListener("abort", abort); }
      },
      close,
    };
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
}
