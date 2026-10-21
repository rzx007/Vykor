import { cp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { installLocalNativePlugin } from "@vykor/plugins";
import { getPluginDataDir } from "@vykor/core";
import { createHash } from "node:crypto";
export async function installNotesAppFixture(
  root: string,
  modelOnly = false,
  source = fileURLToPath(
    new URL("../../../examples/plugins/notes-app", import.meta.url),
  ),
  sessionId = "app-session",
) {
  const sourcePath = join(root, "notes-app"),
    noteFile = join(
      getPluginDataDir(),
      "example.notes-app",
      "sessions",
      createHash("sha256").update(sessionId).digest("hex"),
      "welcome.json",
    );
  await cp(source, sourcePath, {
    recursive: true,
    filter: (path) => !path.split(/[\\/]/).includes("node_modules"),
  });
  if (modelOnly) {
    // A fixture alteration to an actual server tool definition, never to its result metadata.
    const path = join(sourcePath, "server.mjs");
    const code = await readFile(path, "utf8");
    await writeFile(
      path,
      code.replace('visibility: ["model", "app"]', 'visibility: ["model"]'),
    );
  }
  await writeFile(
    join(sourcePath, "mcp.json"),
    JSON.stringify({
      servers: {
        notes: {
          type: "stdio",
          command: process.execPath,
          cwd: "${VYKOR_PLUGIN_ROOT}",
          args: ["server.mjs"],
          env: {
            VYKOR_NOTES_DATA_DIR: "${VYKOR_PLUGIN_DATA_DIR}",
            VYKOR_NOTES_SESSION: "${VYKOR_SESSION_ID}",
          },
        },
      },
    }),
  );
  const installed = await installLocalNativePlugin({
    sourcePath,
    cwd: root,
    scope: "user",
    approvedPermissions: ["ui:render", "ui:invoke-own-tools"],
  });
  if (installed.status !== "installed")
    throw new Error(JSON.stringify(installed));
  return {
    pluginId: "example.notes-app",
    toolName: "save_note_draft",
    effectFile: noteFile,
    installed: installed.record,
  };
}
