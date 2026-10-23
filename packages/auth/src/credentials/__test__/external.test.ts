import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  describeCodexAuthState,
  getCodexAuthPath,
  loadCodexCredential,
} from "../external";

function jwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.sig`;
}

describe("Codex external auth", () => {
  it("resolves CODEX_HOME/auth.json", () => {
    expect(getCodexAuthPath({ CODEX_HOME: "C:\\tmp\\codex-home" }).replace(/\\/g, "/")).toContain(
      "C:/tmp/codex-home/auth.json",
    );
  });

  it("loads a Codex access token from auth.json", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oh-codex-auth-"));
    try {
      mkdirSync(dir, { recursive: true });
      const token = jwt({
        exp: Math.floor(Date.now() / 1000) + 3600,
        "https://api.openai.com/profile": { email: "me@example.com" },
        "https://api.openai.com/auth": { chatgpt_account_id: "acct_123" },
      });
      writeFileSync(join(dir, "auth.json"), JSON.stringify({
        tokens: { access_token: token, refresh_token: "refresh" },
      }));

      const credential = await loadCodexCredential({ CODEX_HOME: dir });
      expect(credential.value).toBe(token);
      expect(credential.profileLabel).toBe("me@example.com");
      expect(credential.refreshToken).toBe("refresh");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("describes a missing Codex auth source", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oh-codex-missing-"));
    try {
      const state = await describeCodexAuthState({ CODEX_HOME: dir });
      expect(state.configured).toBe(false);
      expect(state.state).toBe("missing");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
