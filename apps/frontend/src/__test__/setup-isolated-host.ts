import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Bun shares modules between test files. Install the empty host before importing UI.
const directory = mkdtempSync(join(tmpdir(), "vykor-bun-test-host-"));
for (const leaf of ["home", "config", "appdata", "localappdata", "codex"]) mkdirSync(join(directory, leaf));
Object.assign(process.env, {
  HOME: join(directory, "home"), USERPROFILE: join(directory, "home"),
  APPDATA: join(directory, "appdata"), LOCALAPPDATA: join(directory, "localappdata"),
  CODEX_HOME: join(directory, "codex"), VYKOR_CONFIG_DIR: join(directory, "config"),
});
delete process.env.VYKOR_DATA_DIR;
delete process.env.VYKOR_CHANNELS_DIR;
delete process.env.VYKOR_IMAGE_ATTACHMENT_CACHE_DIR;

// The process is ending; keep its environment isolated through every exit callback.
process.once("exit", () => rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
