import { afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Each test file gets an empty host, so default Agents cannot discover a developer's plugins/MCP.
const directory = mkdtempSync(join(tmpdir(), "vykor-test-host-"));
const previousHome = process.env.HOME;
const previousUserProfile = process.env.USERPROFILE;
process.env.HOME = directory;
process.env.USERPROFILE = directory;
const previousConfig = process.env.VYKOR_CONFIG_DIR;
const previousData = process.env.VYKOR_DATA_DIR;
process.env.VYKOR_CONFIG_DIR = directory;
process.env.VYKOR_DATA_DIR = join(directory, "data");

afterAll(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = previousUserProfile;
  if (previousConfig === undefined) delete process.env.VYKOR_CONFIG_DIR;
  else process.env.VYKOR_CONFIG_DIR = previousConfig;
  if (previousData === undefined) delete process.env.VYKOR_DATA_DIR;
  else process.env.VYKOR_DATA_DIR = previousData;
  rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});
