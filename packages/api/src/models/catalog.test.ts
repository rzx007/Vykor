import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function createConfigDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "vykor-model-catalog-"));
  temporaryDirectories.push(directory);
  vi.stubEnv("VYKOR_CONFIG_DIR", directory);
  return directory;
}

describe("ModelCatalogService sources", () => {
  it("uses models.dev as the authority for regular online providers", async () => {
    await createConfigDirectory();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            remote: {
              id: "remote",
              name: "Remote Provider",
              models: { online: { id: "online", name: "Online Model" } },
            },
          }),
          { status: 200 },
        ),
      ),
    );

    const { createModelCatalogService } = await import("./catalog");
    const catalog = await createModelCatalogService().load();

    expect(Object.keys(catalog).sort()).toEqual(["codex", "remote"]);
    expect(catalog.remote?.models?.online?.name).toBe("Online Model");
    expect(catalog.codex?.name).toBe("Codex Subscription");
  });

  it("uses the bundled api.json snapshot when online fetching is disabled", async () => {
    await createConfigDirectory();
    vi.stubEnv("VYKOR_DISABLE_MODELS_FETCH", "1");

    const { createModelCatalogService } = await import("./catalog");
    const catalog = await createModelCatalogService().load();

    expect(catalog.google?.name).toBe("Google");
    expect(Object.keys(catalog.google?.models ?? {})).not.toHaveLength(0);
    expect(catalog.codex?.name).toBe("Codex Subscription");
  });

  it("prefers the latest successful cache when an online refresh fails", async () => {
    const configDirectory = await createConfigDirectory();
    const cacheDirectory = join(configDirectory, "cache");
    await mkdir(cacheDirectory, { recursive: true });
    await writeFile(
      join(cacheDirectory, "models-dev.json"),
      JSON.stringify({
        cached: {
          id: "cached",
          name: "Cached Provider",
          models: { cached: { id: "cached", name: "Cached Model" } },
        },
      }),
      "utf8",
    );
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));

    const { createModelCatalogService } = await import("./catalog");
    const catalog = await createModelCatalogService().load();

    expect(Object.keys(catalog).sort()).toEqual(["cached", "codex"]);
    expect(catalog.cached?.models?.cached?.name).toBe("Cached Model");
  });

  it("injects special providers into an explicitly configured catalog", async () => {
    const configDirectory = await createConfigDirectory();
    const configuredPath = join(configDirectory, "configured-models.json");
    await writeFile(
      configuredPath,
      JSON.stringify({
        custom: { id: "custom", name: "Custom Catalog Provider" },
      }),
      "utf8",
    );
    vi.stubEnv("VYKOR_MODELS_PATH", configuredPath);

    const { createModelCatalogService } = await import("./catalog");
    const catalog = await createModelCatalogService().load();

    expect(Object.keys(catalog).sort()).toEqual(["codex", "custom"]);
  });
});
