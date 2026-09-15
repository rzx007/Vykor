import { describe, expect, it } from "vitest";
import { createDefaultAuthService } from "./auth-service.js";
import { settingsPatchRuntimeImpact } from "./settings-service.js";

describe("default-services contracts", () => {
  it("auth login rejects missing provider or missing apiKey", async () => {
    const auth = createDefaultAuthService();

    await expect(auth.login({ provider: "", apiKey: "key" })).rejects.toThrow(
      "Usage: /auth login <provider> <api-key> or /auth login codex",
    );
    await expect(auth.login({ provider: "anthropic", apiKey: "" })).rejects.toThrow(
      "Usage: /auth login <provider> <api-key>",
    );
    await expect(auth.login({ provider: "non-existent-provider-xyz", apiKey: "key" })).rejects.toThrow(
      "Unknown provider: non-existent-provider-xyz",
    );
  });

  it("auth logout rejects empty provider", async () => {
    const auth = createDefaultAuthService();
    await expect(auth.logout({ provider: "   " })).rejects.toThrow(
      "Usage: /auth logout <provider>",
    );
  });

  it("settingsPatchRuntimeImpact classifies restart vs invalidate vs none", () => {
    expect(settingsPatchRuntimeImpact({ provider: "anthropic" })).toBe("restart");
    expect(settingsPatchRuntimeImpact({ maxTurns: 10 })).toBe("invalidate");
    expect(settingsPatchRuntimeImpact({ unknownKey: 123 })).toBe("none");
  });
});
