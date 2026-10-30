import { VykorClient, type SessionDirectoryResult, type SessionFileInfo, type SessionTextFileResult, type SessionFindFilesResult, type SessionSearchFilesResult } from "@rzx/client";

// A real browser consumer keeps the complete resource reachable without issuing requests.
const client = new VykorClient({ baseUrl: "http://127.0.0.1:8787" });
async function readSessionWorkspace(sessionId: string, signal?: AbortSignal) {
  const directory: SessionDirectoryResult = await client.files.list(sessionId, { signal });
  const file: SessionFileInfo = await client.files.stat(sessionId, "README.md", { signal });
  const text: SessionTextFileResult = await client.files.readText(sessionId, "README.md", { maxBytes: 4096, signal });
  const found: SessionFindFilesResult = await client.files.find(sessionId, { pattern: "**/*.ts", signal });
  const searched: SessionSearchFilesResult = await client.files.search(sessionId, { query: "literal [text]", caseSensitive: false, signal });
  return { directory, file, text, found, searched };
}
Object.assign(window, { vykorClient: client, readSessionWorkspace });
