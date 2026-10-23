import { join, dirname } from "node:path";
import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createDocumentStore } from "#excalidraw/adapters/store.ts";
import { createExcalidrawServer } from "#excalidraw/adapters/server.ts";

const dataRoot = process.env.VYKOR_EXCALIDRAW_DATA_DIR;
const session = process.env.VYKOR_EXCALIDRAW_SESSION;
const workspace = process.env.VYKOR_EXCALIDRAW_WORKSPACE;
if (!dataRoot || !session || !/^[a-f0-9]{64}$/.test(session) || !workspace || workspace.includes("${")) throw new Error("Excalidraw requires the host-bound data directory, session and workspace");
const workspaceRoot = await realpath(workspace);
const root = join(dataRoot, "sessions", session);
const store = createDocumentStore(root);
const server = createExcalidrawServer({
  store,
  workspaceRoot,
  assetRoot: join(dirname(fileURLToPath(import.meta.url)), "ui"),
});
let stopping = false;
async function close() {
  if (stopping) return;
  stopping = true;
  await server.close();
  await store.close();
}
process.once("SIGTERM", () => {
  void close();
});
process.once("SIGINT", () => {
  void close();
});
process.stdin.once("end", () => {
  void close();
});
await server.connect(new StdioServerTransport());
