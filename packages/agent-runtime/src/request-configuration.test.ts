import { describe, expect, it } from "vitest";

import {
  createMemoryRequestConfigurationStore,
} from "./request-configuration.js";

describe("memory request configuration store", () => {
  it("rejects invalid live request options before accepting a revision", async () => {
    const store = createMemoryRequestConfigurationStore(
      { model: "model-a", maxTurns: 3 },
      async (next) => next,
    );
    await expect(store.update({ maxTurns: 0 })).rejects.toThrow(/maxTurns/);
    await expect(store.update({ fastMode: "yes" } as never)).rejects.toThrow(/fastMode/);
    await expect(store.update({ workStyle: "turbo" } as never)).rejects.toThrow(/workStyle/);
    await expect(store.update({ systemPrompt: 42 } as never)).rejects.toThrow(/systemPrompt/);
    expect(await store.read()).toEqual({
      revision: 0, configuration: { model: "model-a", maxTurns: 3 },
    });
  });

  it("serializes concurrent patches and does not restore over a newer selection", async () => {
    const store = createMemoryRequestConfigurationStore(
      { model: "model-a", effort: "low" },
      async (next) => next,
    );

    const original = await store.read();
    const modelUpdate = store.update({ model: "model-b" });
    const effortUpdate = store.update({ effort: "high" });
    const [modelSnapshot, effortSnapshot] = await Promise.all([
      modelUpdate,
      effortUpdate,
    ]);

    expect(modelSnapshot).toEqual({
      revision: 1,
      configuration: { model: "model-b", effort: "low" },
    });
    expect(effortSnapshot).toEqual({
      revision: 2,
      configuration: { model: "model-b", effort: "high" },
    });
    expect(
      await store.restoreIfCurrent(
        modelSnapshot.revision,
        original.configuration,
      ),
    ).toBeUndefined();
    expect(await store.read()).toEqual(effortSnapshot);
  });

  it("does not commit a rejected update and lets a later update continue", async () => {
    const store = createMemoryRequestConfigurationStore(
      { model: "model-a" },
      async (next) => {
        if (next.model === "forbidden") throw new Error("model is forbidden");
        return next;
      },
    );

    await expect(store.update({ model: "forbidden" })).rejects.toThrow(
      "model is forbidden",
    );
    await expect(store.read()).resolves.toEqual({
      revision: 0,
      configuration: { model: "model-a" },
    });
    await expect(store.update({ model: "model-b" })).resolves.toEqual({
      revision: 1,
      configuration: { model: "model-b" },
    });
  });

  it("does not expose mutable configuration references or advance identical updates", async () => {
    const store = createMemoryRequestConfigurationStore(
      { model: "model-a", effort: "low" },
      async (next) => next,
    );

    const first = await store.read();
    (first.configuration as { model: string }).model = "mutated";
    const unchanged = await store.update({ model: "model-a" });

    expect(unchanged).toEqual({
      revision: 0,
      configuration: { model: "model-a", effort: "low" },
    });
    expect(await store.read()).toEqual(unchanged);
  });

  it("restores the previous configuration only when the failed revision remains current", async () => {
    const store = createMemoryRequestConfigurationStore(
      { model: "model-a", effort: "low" },
      async (next) => next,
    );

    const before = await store.read();
    const failed = await store.update({ model: "model-b", effort: "high" });
    const restored = await store.restoreIfCurrent(
      failed.revision,
      before.configuration,
    );

    expect(restored).toEqual({
      revision: 2,
      configuration: { model: "model-a", effort: "low" },
    });
  });

  it("updates an idle in-memory selection synchronously for legacy callers", async () => {
    const store = createMemoryRequestConfigurationStore(
      { model: "model-a" },
      async (next) => next,
    );

    expect(store.replaceSynchronously({ model: "model-b" })).toEqual({
      revision: 1,
      configuration: { model: "model-b" },
    });
    expect(await store.read()).toEqual({
      revision: 1,
      configuration: { model: "model-b" },
    });
  });
});
