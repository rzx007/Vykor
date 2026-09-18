import { describe, expect, it } from "vitest";
import { createOAuthCallback } from "./callback.js";

describe("OAuth callback", () => {
  it("validates state and issuer and consumes a failed callback", async () => {
    const callback = await createOAuthCallback({ expectedState: "s1", expectedIssuer: "https://auth.test", requireIssuer: true, deadlineMs: 1_000 });
    const waiting = callback.wait();
    await expect(callback.accept(new URL(`${callback.redirectUri}?code=c&state=s1&iss=${encodeURIComponent("https://evil.test")}`)))
      .rejects.toMatchObject({ code: "oauth-issuer-mismatch" });
    await expect(waiting).rejects.toMatchObject({ code: "oauth-issuer-mismatch" });
    await expect(callback.accept(new URL(`${callback.redirectUri}?code=c&state=s1&iss=${encodeURIComponent("https://auth.test")}`)))
      .rejects.toMatchObject({ code: "oauth-callback-consumed" });
  });
});
