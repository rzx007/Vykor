import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateNativePlugin } from "../manifest/validate.js";
import { loadNativeMcpServers } from "./mcp.js";
import { mkdtemp, cp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPluginDataDir } from "@vykor/host-config";

const fixture = fileURLToPath(new URL("../../fixtures/native-v1/agents-hooks-mcp", import.meta.url));

describe("loadNativeMcpServers", () => {
  it("requires and loads explicit Native transports", async () => {
    const validation = await validateNativePlugin(fixture);
    const result = await loadNativeMcpServers(validation.plugin!);
    expect(result.status).toBe("loaded");
    expect(result.value).toEqual(expect.objectContaining({
      local: expect.objectContaining({ type: "stdio" }),
      remote: expect.objectContaining({ type: "http" }),
    }));
    expect(result.value?.local).not.toHaveProperty("cwd");
  });
  it("binds only explicit whole-value installation and data directory markers", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcp-markers-"));
    try {
      await cp(fixture, root, { recursive: true });
      const path = join(root, "mcp/servers.json"), config = JSON.parse(await readFile(path, "utf8"));
      config.servers.local.cwd = "${VYKOR_PLUGIN_ROOT}";
      config.servers.local.env = { DATA: "${VYKOR_PLUGIN_DATA_DIR}", LITERAL: "prefix/${VYKOR_PLUGIN_ROOT}", SESSION: "${VYKOR_SESSION_ID}" };
      await writeFile(path, JSON.stringify(config));
      const validated = await validateNativePlugin(root), result = await loadNativeMcpServers(validated.plugin!);
      expect(result.status).toBe("loaded");
      expect(result.value?.local).toMatchObject({ cwd: root, env: { DATA: join(getPluginDataDir(), "dev.vykor.full"), LITERAL: "prefix/${VYKOR_PLUGIN_ROOT}", SESSION: "${VYKOR_SESSION_ID}" } });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
