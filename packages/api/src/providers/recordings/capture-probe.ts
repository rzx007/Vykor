/** Manual, opt-in observations only. Tests isolate initialization with synthetic files and blocked fetch. */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCodexHeaders, CodexSubscriptionClient } from "../codex.js";
import { captureHttpExchange } from "./http-recording.js";

const route = process.argv[2];
try {
  if (route !== "openai" && route !== "codex") throw new Error("Explicit route openai or codex required");
  const configDir = process.env.VYKOR_CONFIG_DIR ?? join(homedir(), ".vykor");
  const prompt = "Call Echo once with value public-probe. Do not write prose.";
  const schema = { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false };
  let url: string;
  let headers: Record<string, string>;
  let body: Record<string, unknown>;
  let secrets: string[];
  let codex: CodexSubscriptionClient | undefined;
  if (route === "openai") {
    const settings = JSON.parse(await readFile(join(configDir, "settings.json"), "utf8"));
    const credentials = JSON.parse(await readFile(join(configDir, "credentials.json"), "utf8"));
    const provider = settings.customProviders?.find((item: { id: string }) => item.id === "tokenharbor");
    const key = credentials.tokenharbor?.api_key;
    if (!provider?.baseUrl || provider.apiFormat !== "openai" || !key || !provider.models.some((item: { id: string }) => item.id === "mimo-v2.5:free")) throw new Error("Approved route unavailable");
    url = `${provider.baseUrl.replace(/\/$/, "")}/chat/completions`;
    headers = { ...provider.headers, Authorization: `Bearer ${key}`, "content-type": "application/json" };
    secrets = [key, ...Object.values(provider.headers ?? {}) as string[]];
    body = { model: "mimo-v2.5:free", messages: [{ role: "user", content: prompt }], max_tokens: 128,
      stream: true, stream_options: { include_usage: true }, tools: [{ type: "function", function: { name: "Echo", description: "Return the public probe", parameters: schema } }] };
  } else {
    const auth = JSON.parse(await readFile(join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json"), "utf8"));
    const token = auth.tokens?.access_token;
    if (!token) throw new Error("Approved Codex authentication unavailable");
    headers = buildCodexHeaders(token);
    secrets = [token, ...Object.values(headers).filter(value => value !== "application/json" && value !== "text/event-stream")];
    url = "https://chatgpt.com/backend-api/codex/responses";
    body = {};
    codex = new CodexSubscriptionClient({ apiKey: token });
  }
  const networkFetch = globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45_000);
  const boundedFetch: typeof fetch = async (input, init) => {
    const response = await networkFetch(input, { ...init, signal: controller.signal });
    let bytes = 0;
    const body = response.body?.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, writer) {
      bytes += chunk.length;
      if (bytes > 64 * 1024) { controller.abort(); throw new Error("Observation byte budget exhausted"); }
      writer.enqueue(chunk);
    } }));
    return new Response(body, { status: response.status, headers: response.headers });
  };
  const options = {
    route, description: route === "openai" ? "tokenharbor / mimo-v2.5:free; one public tool probe; output cap 128; billing not independently verified"
      : "CodexSubscriptionClient / gpt-5.6-sol; one public short-text probe; 45s and 64KiB transport budgets; client sends no output-token cap", redactions: secrets,
  } as const;
  let recording;
  try {
    if (codex) {
      globalThis.fetch = async (input, init) => {
        recording = await captureHttpExchange(boundedFetch, String(input), init ?? {}, options);
        return new Response(recording.response.chunks.join(""), { status: recording.response.status, headers: recording.response.headers });
      };
      try {
        for await (const _event of codex.streamMessage({ model: "gpt-5.6-sol", messages: [{ type: "user", content: "Return exactly public-probe. No reasoning or explanation." }], requestTimeoutMs: 45_000 })) { /* real decoder */ }
      } catch { /* Keep an observed provider error response too, if available. */ }
      finally { globalThis.fetch = networkFetch; }
      if (!recording) throw new Error("No observed response");
    } else recording = await captureHttpExchange(boundedFetch, url, { method: "POST", headers, body: JSON.stringify(body), signal: controller.signal }, options);
  } finally { clearTimeout(timer); }
  const directory = fileURLToPath(new URL("./__test__/fixtures/", import.meta.url));
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${route}.observed.json`), JSON.stringify(recording, null, 2) + "\n");
  console.log(JSON.stringify({ route, status: recording.response.status, bytes: recording.response.chunks.join("").length }));
} catch (error) {
  // Network/SDK diagnostics can contain request details. Never print their message or stack.
  console.error(JSON.stringify({ route, failed: true, type: error instanceof Error ? error.name : "unknown" }));
  process.exitCode = 1;
}
