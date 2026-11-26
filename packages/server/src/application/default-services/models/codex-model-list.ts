import { createHash } from "node:crypto";
import { buildCodexHeaders, type ModelsDevModel } from "@vykor/api";
import { isCredentialExpired, loadCodexCredential } from "@vykor/auth";

// The Codex backend uses the client version to select catalog entries.
const catalogUrl = "https://chatgpt.com/backend-api/codex/models?client_version=0.171.0";
type CatalogModel = ModelsDevModel & { id: string };

export function createCodexModelList() {
  let cached: { identity: string; models: CatalogModel[] } | undefined;
  let request = 0;

  return async (): Promise<CatalogModel[]> => {
    const revision = ++request;
    const credential = await loadCodexCredential().catch(() => undefined);
    if (revision !== request) return [];
    if (!credential || isCredentialExpired(credential)) {
      cached = undefined;
      return [];
    }

    // A new login drops the previous snapshot, even if it is for the same account.
    const identity = createHash("sha256").update(credential.sourcePath).update("\0").update(credential.value).digest("hex");
    if (cached?.identity !== identity) cached = undefined;
    let headers: Record<string, string>;
    try {
      headers = { ...buildCodexHeaders(credential.value), accept: "application/json" };
    } catch {
      cached = undefined;
      return [];
    }

    let response: Response;
    try {
      response = await fetch(catalogUrl, {
        headers,
        redirect: "manual",
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      return revision === request ? (cached?.models ?? []) : [];
    }
    if (revision !== request) return [];
    if (response.status === 401 || response.status === 403) cached = undefined;
    if (!response.ok) return [];

    const payload = await response.json().catch(() => undefined);
    if (revision !== request || !payload || typeof payload !== "object" ||
      !("models" in payload) || !Array.isArray(payload.models)) return [];
    const models: CatalogModel[] = [];
    for (const entry of payload.models) {
      if (entry?.visibility !== "list" || typeof entry.slug !== "string" || !entry.slug.trim()) continue;
      const input = Array.isArray(entry.input_modalities)
        ? entry.input_modalities.filter((item: unknown) => typeof item === "string")
        : undefined;
      models.push({
        id: entry.slug,
        name: typeof entry.display_name === "string" ? entry.display_name : entry.slug,
        ...(input ? { modalities: { input } } : {}),
        ...(typeof entry.context_window === "number" ? { limit: { context: entry.context_window } } : {}),
      });
    }
    cached = { identity, models };
    return models;
  };
}
