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
  it("refreshes a loaded catalog and exposes it to other consumers", async () => {
    await createConfigDirectory();
    let id = "first";
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      remote: { models: { [id]: { id, name: id } } },
    })));
    const { createModelCatalogService } = await import("./catalog");
    const firstConsumer = createModelCatalogService();
    const secondConsumer = createModelCatalogService();
    await firstConsumer.load();
    await secondConsumer.load();
    id = "second";

    const refreshed = await firstConsumer.load({ refresh: true });

    expect(Object.keys(refreshed.remote!.models!)).toEqual(["second"]);
    expect(Object.keys((await secondConsumer.load()).remote!.models!)).toEqual(["second"]);
  });

  it("coalesces concurrent refreshes and retains the last catalog when offline", async () => {
    await createConfigDirectory();
    const fetchCatalog = vi.fn(async () => Response.json({ remote: { models: { first: {} } } }));
    vi.stubGlobal("fetch", fetchCatalog);
    const { createModelCatalogService } = await import("./catalog");
    const service = createModelCatalogService();
    await service.load();
    fetchCatalog.mockImplementation(async () => Response.json({ remote: { models: { second: {} } } }));
    const [first, second] = await Promise.all([service.load({ refresh: true }), service.load({ refresh: true })]);
    expect(Object.keys(first.remote!.models!)).toEqual(["second"]);
    expect(second).toBe(first);
    expect(fetchCatalog).toHaveBeenCalledTimes(2);
    fetchCatalog.mockRejectedValue(new Error("offline"));
    expect(Object.keys((await service.load({ refresh: true })).remote!.models!)).toEqual(["second"]);
  });

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
