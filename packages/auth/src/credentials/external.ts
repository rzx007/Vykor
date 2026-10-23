import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const CODEX_PROVIDER = "codex";
export const CODEX_AUTH_SOURCE = "codex_subscription";

export interface ExternalAuthCredential {
  provider: string;
  value: string;
  authKind: "auth_token" | "api_key";
  sourcePath: string;
  managedBy: string;
  profileLabel?: string;
  refreshToken?: string;
  expiresAtMs?: number;
}

export interface ExternalAuthState {
  configured: boolean;
  state: "configured" | "missing" | "invalid" | "expired";
  source: string;
  detail?: string;
  profileLabel?: string;
}

export function getCodexAuthPath(env: NodeJS.ProcessEnv = process.env): string {
  const codexHome = env.CODEX_HOME?.trim() || join(homedir(), ".codex");
  return resolve(codexHome, "auth.json");
}

export async function loadCodexCredential(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ExternalAuthCredential> {
  const sourcePath = getCodexAuthPath(env);
  const raw = await readFile(sourcePath, "utf-8");
  const payload = JSON.parse(raw) as Record<string, unknown>;
  const tokens = payload.tokens;
  let accessToken = "";
  let refreshToken = "";

  if (isRecord(tokens)) {
    accessToken = stringValue(tokens.access_token);
    refreshToken = stringValue(tokens.refresh_token);
  }
  if (!accessToken) {
    accessToken = stringValue(payload.OPENAI_API_KEY);
  }
  if (!accessToken) {
    throw new Error("Codex auth source does not contain an access token.");
  }

  const profileLabel =
    stringValue(decodeJwtClaim(accessToken, ["https://api.openai.com/profile", "email"])) ||
    "Codex CLI";
  const expiresAtMs = decodeJwtExpiry(accessToken);

  return {
    provider: CODEX_PROVIDER,
    value: accessToken,
    authKind: "auth_token",
    sourcePath,
    managedBy: "codex-cli",
    profileLabel,
    refreshToken: refreshToken || undefined,
    expiresAtMs,
  };
}

export async function describeCodexAuthState(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ExternalAuthState> {
  const sourcePath = getCodexAuthPath(env);
  if (!existsSync(sourcePath)) {
    return {
      configured: false,
      state: "missing",
      source: sourcePath,
      detail: "Run Codex login first so auth.json exists.",
    };
  }

  try {
    const credential = await loadCodexCredential(env);
    if (isCredentialExpired(credential)) {
      return {
        configured: false,
        state: "expired",
        source: sourcePath,
        detail: "Codex access token is expired. Re-run Codex login.",
        profileLabel: credential.profileLabel,
      };
    }
    return {
      configured: true,
      state: "configured",
      source: sourcePath,
      detail: credential.profileLabel,
      profileLabel: credential.profileLabel,
    };
  } catch (error) {
    return {
      configured: false,
      state: "invalid",
      source: sourcePath,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export function isCredentialExpired(
  credential: Pick<ExternalAuthCredential, "expiresAtMs">,
  nowMs = Date.now(),
): boolean {
  return typeof credential.expiresAtMs === "number" && credential.expiresAtMs <= nowMs;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function decodeJwtExpiry(token: string): number | undefined {
  const exp = decodeJwtClaim(token, ["exp"]);
  if (typeof exp === "number") return exp * 1000;
  if (typeof exp === "string") {
    const parsed = Number(exp);
    return Number.isFinite(parsed) ? parsed * 1000 : undefined;
  }
  return undefined;
}

function decodeJwtClaim(token: string, path: string[]): unknown {
  const payload = decodeJwtPayload(token);
  if (!payload) return undefined;

  let current: unknown = payload;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const padded = parts[1]!.padEnd(parts[1]!.length + ((4 - parts[1]!.length % 4) % 4), "=");
    const raw = Buffer.from(padded, "base64url").toString("utf-8");
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}
