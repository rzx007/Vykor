import filesystem from "node:fs/promises";
import type { EnvironmentDirectoryScanOptions, EnvironmentDirectoryScanResult } from "@vykor/environment";

export function checkDirectoryScanOptions({maxEntries}: EnvironmentDirectoryScanOptions): void {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 0) throw new RangeError("maxEntries must be a non-negative safe integer");
}

export async function scanHostDirectory(path: string, options: EnvironmentDirectoryScanOptions): Promise<EnvironmentDirectoryScanResult> {
  const {maxEntries,signal}=options;
  signal?.throwIfAborted();
  checkDirectoryScanOptions(options);
  // A one-entry buffer prevents opendir from prefetching an entire small directory past the budget.
  const directory=await filesystem.opendir(path,{bufferSize:1});
  try {
    const entries: EnvironmentDirectoryScanResult["entries"]=[];
    for (;;) {
      signal?.throwIfAborted();
      const entry=await directory.read();
      signal?.throwIfAborted();
      if (!entry) return {entries,truncated:false};
      if (entries.length===maxEntries) return {entries,truncated:true};
      entries.push({name:entry.name,isDirectory:entry.isDirectory()});
    }
  } finally {
    await directory.close();
    signal?.throwIfAborted();
  }
}

// ls -U -1 emits each entry as it reads it, without sorting or GNU find's FTS sibling buffering.
// Fixed script: the path and budget are positional arguments, never shell source.
export const WSL_DIRECTORY_SCAN_SCRIPT=`set -o pipefail
if ! command /usr/bin/ls --zero -d -- / >/dev/null 2>&1 || ! command /usr/bin/head -z -n 0 </dev/null >/dev/null 2>&1; then
  echo "Bounded directory scans require GNU ls --zero and head -z" >&2
  exit 95
fi
if [ ! -d "$1" ]; then echo "Cannot scan directory: $1" >&2; exit 1; fi
/usr/bin/ls -1 -A -U --zero --indicator-style=slash --quoting-style=literal --color=never -- "$1" | /usr/bin/head -z -n "$2"
statuses=("\${PIPESTATUS[@]}")
if [ "\${statuses[1]}" -ne 0 ]; then exit "\${statuses[1]}"; fi
if [ "\${statuses[0]}" -eq 0 ] || [ "\${statuses[0]}" -eq 141 ]; then exit 0; fi
exit "\${statuses[0]}"`;

export function parseDirectoryScan(bytes: Uint8Array, maxEntries: number): EnvironmentDirectoryScanResult {
  const names=new TextDecoder().decode(bytes).split("\0").filter(Boolean);
  return {
    entries:names.slice(0,maxEntries).map(name=>({name:name.endsWith("/")?name.slice(0,-1):name,isDirectory:name.endsWith("/")})),
    truncated:names.length>maxEntries,
  };
}
