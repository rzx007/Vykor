import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateNativePlugin } from "./manifest/validate.js";
import { loadNativePlugin } from "./load-native-plugin.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeNativeUiFixture } from "./test-helpers/native-ui.js";

const fixture = (name: string) =>
  fileURLToPath(new URL(`../fixtures/native-v1/${name}`, import.meta.url));

describe("loadNativePlugin", () => {
  it("loads UI metadata and preserves Skills if UI changes after validation", async () => {
    const root = await mkdtemp(join(tmpdir(), "vk-ui-load-"));
    try {
      await writeNativeUiFixture(root);
      const validation = await validateNativePlugin(root);
      const loaded = await loadNativePlugin(validation.plugin!);
      expect(loaded.components.ui?.value).toHaveLength(1);
      expect(loaded.components.unsupported?.ui).toBeUndefined();
      await writeFile(join(root, "ui", "manifest.json"), "{");
      const changed = await loadNativePlugin(validation.plugin!);
      expect(changed.status).toBe("degraded");
      expect(changed.components.ui?.status).toBe("invalid");
      expect(changed.components.skills?.value).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("keeps independent components when one component is invalid", async () => {
    const validation = await validateNativePlugin(fixture("invalid-component"));
    const loaded = await loadNativePlugin(validation.plugin!);
    expect(loaded.status).toBe("degraded");
    expect(loaded.components.skills?.status).toBe("loaded");
    expect(loaded.components.skills?.value).toHaveLength(1);
    expect(loaded.components.hooks?.status).toBe("invalid");
  });

  it("loads tool metadata but never imports tool code", async () => {
    const validation = await validateNativePlugin(fixture("unsupported-tool"));
    const loaded = await loadNativePlugin(validation.plugin!);
    expect(loaded.components.tools?.status).toBe("loaded");
    expect(loaded.components.tools?.value?.[0]).toMatchObject({
      declaredEntry: "./tools/index.js",
      runtime: "node",
      requestedPermissions: [],
    });
  });
});
