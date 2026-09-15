/**
 * HttpTransport: OpenHarness HTTP 传输内核。
 *
 * 负责：
 * - Base URL 规范化
 * - Bearer Token 鉴权头
 * - fetch 注入与执行
 * - URL query 拼接
 * - 请求体序列化与错误转换 (OpenHarnessApiError)
 * - 基础响应解析与流式透传
 *
 * 约束：不感知任何业务 Resource 领域逻辑。
 */

import { ProtocolDataError } from "@openharness/protocol";

export interface HttpTransportOptions {
  baseUrl: string;
  token?: string;
  fetch?: typeof fetch;
}

export interface HttpRequestOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  query?: Record<string, unknown>;
  signal?: AbortSignal;
  auth?: boolean;
}

export interface RawRequestOptions extends RequestInit {
  duplex?: "half";
  query?: Record<string, unknown>;
  auth?: boolean;
}

/** HTTP API 非 2xx 时抛出；携带 status 与原始响应体。 */
export class OpenHarnessApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "OpenHarnessApiError";
  }
}

export function responseField(value: unknown, field: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProtocolDataError("Response body must be an object");
  }
  if (!(field in value)) {
    throw new ProtocolDataError(`Response body is missing ${field}`, field);
  }
  return (value as Record<string, unknown>)[field];
}

export function responseArray<T>(
  value: unknown,
  field: string,
  decode: (item: unknown) => T,
): T[] {
  const items = responseField(value, field);
  if (!Array.isArray(items)) {
    throw new ProtocolDataError(`Response ${field} must be an array`, field);
  }
  return items.map(decode);
}

/** Normalize a daemon base URL without accepting credentials or request fragments. */
export function normalizeDaemonBaseUrl(value: string): string {
  const raw = value.trim();
  if (!raw) throw new Error("Daemon URL is required");

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Daemon URL must be an absolute http or https URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Daemon URL must use http or https");
  }
  if (url.username || url.password) {
    throw new Error(
      "Daemon URL must not contain credentials; use a bearer token instead",
    );
  }
  if (url.search || url.hash) {
    throw new Error(
      "Daemon URL must not contain query parameters or a fragment",
    );
  }

  const pathname = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${pathname === "/" ? "" : pathname}`;
}

export function isReadableStream(value: unknown): value is ReadableStream<Uint8Array> {
  return (
    typeof ReadableStream !== "undefined" && value instanceof ReadableStream
  );
}

export interface AttachmentRangeOptions {
  start?: number;
  end?: number;
  suffixBytes?: number;
}

export function attachmentRangeHeader(
  range: AttachmentRangeOptions | undefined,
): string | undefined {
  if (!range) return undefined;
  const { start, end, suffixBytes } = range;
  if (suffixBytes !== undefined) {
    if (start !== undefined || end !== undefined) {
      throw new Error("suffixBytes cannot be combined with start or end");
    }
    assertPositiveSafeInteger(suffixBytes, "suffixBytes");
    return `bytes=-${suffixBytes}`;
  }
  if (start === undefined && end === undefined) return undefined;
  if (start === undefined) {
    throw new Error("range start is required when end is provided");
  }
  assertNonNegativeSafeInteger(start, "start");
  if (end === undefined) return `bytes=${start}-`;
  assertNonNegativeSafeInteger(end, "end");
  if (end < start) throw new Error("range end must not be less than start");
  return `bytes=${start}-${end}`;
}

function assertNonNegativeSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
}

function assertPositiveSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${field} must be a positive safe integer`);
  }
}

export async function throwResponseError(response: Response): Promise<never> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = await response.text().catch(() => "");
  }
  const message =
    body &&
    typeof body === "object" &&
    "error" in body &&
    typeof body.error === "string"
      ? body.error
      : body &&
          typeof body === "object" &&
          "message" in body &&
          typeof body.message === "string"
        ? body.message
        : `OpenHarness API request failed with ${response.status}`;
  throw new OpenHarnessApiError(message, response.status, body);
}

export class HttpTransport {
  readonly baseUrl: string;
  readonly token?: string;
  readonly fetchImpl: typeof fetch;

  constructor(options: HttpTransportOptions) {
    this.baseUrl = normalizeDaemonBaseUrl(options.baseUrl);
    this.token = options.token;
    this.fetchImpl = options.fetch ?? fetch;
  }

  headers(
    jsonOrOptions:
      | boolean
      | { json?: boolean; auth?: boolean; extra?: Record<string, string> } = false,
    auth = true,
  ): Record<string, string> {
    let json = false;
    let authHeader = auth;
    let extra: Record<string, string> | undefined;

    if (typeof jsonOrOptions === "object" && jsonOrOptions !== null) {
      json = jsonOrOptions.json ?? false;
      authHeader = jsonOrOptions.auth ?? true;
      extra = jsonOrOptions.extra;
    } else {
      json = Boolean(jsonOrOptions);
      authHeader = auth;
    }

    return {
      ...(authHeader && this.token ? { authorization: `Bearer ${this.token}` } : {}),
      ...(json ? { "content-type": "application/json" } : {}),
      ...(extra ?? {}),
    };
  }

  path(pathname: string, query: Record<string, unknown> = {}): string {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === false) continue;
      params.set(key, String(value));
    }
    const qs = params.toString();
    return qs ? `${pathname}?${qs}` : pathname;
  }

  resolveUrl(pathname: string, query?: Record<string, unknown>): string {
    const resolvedPath = query ? this.path(pathname, query) : pathname;
    return `${this.baseUrl}${resolvedPath}`;
  }

  async request<T>(path: string, options: HttpRequestOptions = {}): Promise<T> {
    const url = this.resolveUrl(path, options.query);
    const hasJsonBody = options.body !== undefined;
    const headers = {
      ...this.headers(hasJsonBody, options.auth ?? true),
      ...(options.headers ?? {}),
    };

    const response = await this.fetchImpl(url, {
      method: options.method ?? "GET",
      headers,
      body: hasJsonBody ? JSON.stringify(options.body) : undefined,
      signal: options.signal,
    });

    if (!response.ok) {
      await throwResponseError(response);
    }
    return (await response.json()) as T;
  }

  async requestUnknown(
    path: string,
    options: HttpRequestOptions = {},
  ): Promise<unknown> {
    return this.request<unknown>(path, options);
  }

  async requestEmpty(
    path: string,
    options: HttpRequestOptions = {},
  ): Promise<void> {
    const url = this.resolveUrl(path, options.query);
    const hasJsonBody = options.body !== undefined;
    const headers = {
      ...this.headers(hasJsonBody, options.auth ?? true),
      ...(options.headers ?? {}),
    };

    const response = await this.fetchImpl(url, {
      method: options.method ?? "GET",
      headers,
      body: hasJsonBody ? JSON.stringify(options.body) : undefined,
      signal: options.signal,
    });

    if (!response.ok) {
      await throwResponseError(response);
    }
  }

  async requestResponse(
    path: string,
    options: RawRequestOptions = {},
  ): Promise<Response> {
    const url = this.resolveUrl(path, options.query);
    const auth = options.auth ?? true;
    const defaultHeaders = this.headers(false, auth);
    const headers = {
      ...defaultHeaders,
      ...((options.headers as Record<string, string>) ?? {}),
    };

    const init: RequestInit & { duplex?: "half" } = {
      ...options,
      headers,
    };
    if (isReadableStream(init.body) && !init.duplex) {
      init.duplex = "half";
    }

    const response = await this.fetchImpl(url, init);
    if (!response.ok) {
      await throwResponseError(response);
    }
    return response;
  }

  async throwResponseError(response: Response): Promise<never> {
    return throwResponseError(response);
  }
}
