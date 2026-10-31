export type RecordingRoute = "anthropic" | "openai" | "codex";
export interface HttpRecording {
  version: 1;
  route: RecordingRoute;
  source: { kind: "observed" | "synthetic"; description: string; capturedAt?: string };
  request: { method: string; path: string; body: unknown };
  response: { status: number; headers: Record<string, string>; chunks: string[] };
}
const sensitiveKey = /^(?:authorization|proxy-authorization|api[-_]?key|x-api-key|access[-_]?token|refresh[-_]?token|cookie|set-cookie|session[-_]?id|chatgpt-account-id|encrypted_content)$/i;
const unsafeText = /Bearer\s+\S+|\bsk-[\w-]{16,}|\beyJ[\w-]+\.[\w-]+\.[\w-]+|[A-Z]:[\\/]+Users[\\/]+[^\s"\\]+|\/(?:home|Users)\/[^\s"/]+/i;

/** Inspect complete JSON payloads without changing or decoding the recorded wire format. */
function assertJsonPayloads(text: string): void {
  const inspect = (payload: string): void => {
    const trimmed = payload.trimStart();
    if (!/^[{[]/.test(trimmed)) return;
    let decoded: unknown;
    try { decoded = JSON.parse(trimmed); } catch { return; }
    assertSanitized(decoded);
  };
  if (/^[{[]/.test(text.trimStart())) { inspect(text); return; }
  // SSE joins all data fields in a frame with LF. Event names and comments do
  // not identify the payload format and may appear before its first data line.
  let data: string[] = [];
  for (const line of text.split(/\r\n|\r|\n/)) {
    if (line === "") { inspect(data.join("\n")); data = []; }
    else if (line === "data") data.push("");
    else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
  }
  if (data.length) inspect(data.join("\n"));
}

/** Conservative guard, additional private prose must be supplied as explicit redactions. */
export function assertSanitized(value: unknown): void {
  if (typeof value === "string") {
    if (unsafeText.test(value)) throw new Error("Unsafe recording: credential or personal path");
    assertJsonPayloads(value);
  }
  if (Array.isArray(value)) { value.forEach(assertSanitized); return; }
  if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) {
    if (sensitiveKey.test(key) && item !== "[REDACTED]") throw new Error("Unsafe recording: sensitive field");
    if (key === "chunks" && Array.isArray(item) && item.every(chunk => typeof chunk === "string")) assertSanitized(item.join(""));
    assertSanitized(item);
  }
}

export function sanitizeRecording(recording: HttpRecording, redactions: readonly string[]): HttpRecording {
  const ordered = [...new Set(redactions.filter(Boolean).flatMap(secret => {
    const escaped = JSON.stringify(secret).slice(1, -1);
    return [secret, escaped, JSON.stringify(escaped).slice(1, -1)];
  }))].sort((a, b) => b.length - a.length);
  const scrub = (value: unknown): unknown => {
    if (typeof value === "string") return ordered.reduce((text, secret) => text.replaceAll(secret, "[REDACTED]"), value);
    if (Array.isArray(value)) return value.map(scrub);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) =>
      [key, sensitiveKey.test(key) ? "[REDACTED]" : scrub(item)]));
    return value;
  };
  // Redact across original network chunk boundaries, then use one deterministic replay chunk.
  // SSE event and JSON argument fragmentation remains intact in the wire text.
  const safe = scrub({ ...recording, response: { ...recording.response, chunks: [recording.response.chunks.join("")] } }) as HttpRecording;
  assertSanitized(safe);
  return safe;
}

/** A bounded observation helper: supplied fetch is the only network boundary. No disk writes. */
export async function captureHttpExchange(networkFetch: typeof fetch, url: string, init: RequestInit,
  options: { route: RecordingRoute; description: string; redactions: readonly string[]; maxResponseBytes?: number }): Promise<HttpRecording> {
  const maxBytes = options.maxResponseBytes ?? 256 * 1024;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("Response byte budget must be a positive safe integer");
  const response = await networkFetch(url, init);
  const recording: HttpRecording = {
    version: 1, route: options.route,
    source: { kind: "observed", description: options.description, capturedAt: new Date().toISOString() },
    request: { method: init.method ?? "GET", path: new URL(url).pathname, body: init.body ? JSON.parse(String(init.body)) : null },
    response: { status: response.status, headers: {}, chunks: [] },
  };
  for (const header of ["content-type", "retry-after"]) {
    const value = response.headers.get(header);
    if (value) recording.response.headers[header] = value;
  }
  if (response.body) {
    const decoder = new TextDecoder();
    let totalBytes = 0;
    for await (const bytes of response.body) {
      totalBytes += bytes.byteLength;
      // Throwing exits the stream iterator and cancels the remaining response body.
      if (totalBytes > maxBytes) throw new Error("Response byte budget exhausted");
      recording.response.chunks.push(decoder.decode(bytes, { stream: true }));
    }
    const tail = decoder.decode();
    if (tail) recording.response.chunks.push(tail);
  }
  return sanitizeRecording(recording, options.redactions);
}

function canonical(value: unknown): string {
  const sort = (item: unknown): unknown => Array.isArray(item) ? item.map(sort) : item && typeof item === "object"
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, sort(child)])) : item;
  return JSON.stringify(sort(value));
}

/** Closed replay: never falls through to global fetch, even after a mismatch or exhaustion. */
export function createHttpReplay(recordings: readonly HttpRecording[]): { fetch: typeof fetch; assertConsumed(): void } {
  const frozen = structuredClone(recordings);
  frozen.forEach(assertSanitized);
  let position = 0;
  return {
    fetch: async (input, init) => {
      const recording = frozen[position];
      if (!recording) throw new Error("Unexpected request: recording exhausted");
      const url = input instanceof Request ? input.url : String(input);
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      const rawBody = init?.body ?? (input instanceof Request ? await input.clone().text() : undefined);
      const request = { method, path: new URL(url).pathname, body: rawBody ? JSON.parse(String(rawBody)) : null };
      if (canonical(request) !== canonical(recording.request)) throw new Error(`Recording request mismatch at exchange ${position}`);
      position++;
      const encoder = new TextEncoder();
      let chunk = 0;
      return new Response(new ReadableStream<Uint8Array>({ pull(controller) {
        if (init?.signal?.aborted) { controller.error(init.signal.reason); return; }
        if (chunk < recording.response.chunks.length) controller.enqueue(encoder.encode(recording.response.chunks[chunk++]!));
        else controller.close();
      } }), { status: recording.response.status, headers: recording.response.headers });
    },
    assertConsumed() { if (position !== frozen.length) throw new Error(`Unconsumed recordings: ${frozen.length - position}`); },
  };
}

export function requireRecording(recordings: readonly HttpRecording[], route: RecordingRoute): HttpRecording {
  const recording = recordings.find(item => item.route === route && item.source.kind === "observed");
  if (!recording) throw new Error(`Missing required observed recording: ${route}`);
  assertSanitized(recording);
  return recording;
}
