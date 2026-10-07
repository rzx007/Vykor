import {
  VYKOR_USER_AGENT,
  expandRequestHeaderTemplates,
  findByName,
  resolveProviderScopedBaseUrl,
  type BackendType,
} from "@vykor/api";

const VALIDATION_USER_AGENT = "vykor/credential-validation";
const VALIDATION_HEADER_CONTEXT = {
  sessionId: "vykor-credential-validation",
  userAgent: VYKOR_USER_AGENT,
};
const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com/v1";
const DEFAULT_GEMINI_BASE_URL =
  "https://generativelanguage.googleapis.com/v1beta";

export interface CredentialValidationInput {
  providerName: string;
  providerDisplayName: string;
  backendType: Extract<BackendType, "anthropic" | "openai_compat">;
  apiKey: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  model?: string;
  signal?: AbortSignal;
}

export async function validateProviderCredential(
  input: CredentialValidationInput,
): Promise<void> {
  try {
    if (input.providerName === "gemini") {
      await validateGeminiCredential(input);
      return;
    }
    if (input.backendType === "anthropic") {
      await validateAnthropicCredential(input);
      return;
    }
    await validateOpenAICompatibleCredential(input);
  } catch (error) {
    if (error instanceof Error) throw error;
    throw new Error(`无法验证 ${input.providerDisplayName} API 密钥。`);
  }
}

async function validateOpenAICompatibleCredential(
  input: CredentialValidationInput,
): Promise<void> {
  const baseUrl = requireValidationBaseUrl(
    input.providerName,
    input.baseUrl,
    input.backendType,
  );
  const expandedHeaders = expandRequestHeaderTemplates(
    input.headers,
    VALIDATION_HEADER_CONTEXT,
  );
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/models`, {
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        "User-Agent": VALIDATION_USER_AGENT,
        ...(expandedHeaders ?? {}),
      },
      signal: input.signal ?? AbortSignal.timeout(15000),
    });
  } catch (error) {
    throw validationNetworkError(input.providerDisplayName, error);
  }
  await assertValidationResponse(
    input.providerDisplayName,
    response,
    "OpenAI 兼容 /models",
    input.model,
  );
}

async function validateGeminiCredential(
  input: CredentialValidationInput,
): Promise<void> {
  const baseUrl = requireGeminiValidationBaseUrl(
    input.providerName,
    input.baseUrl,
  );
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/models`, {
      headers: {
        "x-goog-api-key": input.apiKey,
        "User-Agent": VALIDATION_USER_AGENT,
      },
      signal: input.signal ?? AbortSignal.timeout(15000),
    });
  } catch (error) {
    throw validationNetworkError(input.providerDisplayName, error);
  }
  await assertValidationResponse(
    input.providerDisplayName,
    response,
    "Gemini 原生 /models",
    input.model,
  );
}

async function validateAnthropicCredential(
  input: CredentialValidationInput,
): Promise<void> {
  const baseUrl = requireValidationBaseUrl(
    input.providerName,
    input.baseUrl,
    input.backendType,
  );
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/models`, {
      headers: {
        "x-api-key": input.apiKey,
        "anthropic-version": "2023-06-01",
        "User-Agent": VALIDATION_USER_AGENT,
      },
      signal: input.signal ?? AbortSignal.timeout(15000),
    });
  } catch (error) {
    throw validationNetworkError(input.providerDisplayName, error);
  }
  await assertValidationResponse(
    input.providerDisplayName,
    response,
    "Anthropic /models",
    input.model,
  );
}

function requireValidationBaseUrl(
  providerName: string,
  baseUrl: string | undefined,
  backendType: Extract<BackendType, "anthropic" | "openai_compat">,
): string {
  const provider = findByName(providerName);
  const scopedBaseUrl = resolveProviderScopedBaseUrl(
    baseUrl?.trim(),
    providerName,
  )?.trim();
  const resolved =
    scopedBaseUrl ||
    provider?.defaultBaseURL?.trim() ||
    (backendType === "anthropic"
      ? DEFAULT_ANTHROPIC_BASE_URL
      : DEFAULT_OPENAI_BASE_URL);
  return resolved.replace(/\/+$/, "");
}

function requireGeminiValidationBaseUrl(
  providerName: string,
  baseUrl: string | undefined,
): string {
  const scopedBaseUrl = resolveProviderScopedBaseUrl(
    baseUrl?.trim(),
    providerName,
  )?.trim();
  const resolved = scopedBaseUrl
    ? scopedBaseUrl.replace(/\/openai\/?$/i, "")
    : DEFAULT_GEMINI_BASE_URL;
  return resolved.replace(/\/+$/, "");
}

async function assertValidationResponse(
  providerDisplayName: string,
  response: Response,
  endpointLabel: string,
  model?: string,
): Promise<void> {
  if (response.ok) {
    if (model) {
      const body = await response.json().catch(() => null) as { data?: Array<{ id?: string }>; models?: Array<{ name?: string }> } | null;
      const listed = body?.data?.map((item) => item.id) ?? body?.models?.map((item) => item.name?.replace(/^models\//, ""));
      if (!listed?.includes(model)) throw new Error("模型不支持：所选模型未在服务返回的模型列表中，或服务没有返回可识别的列表。");
    }
    return;
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error(
      `${providerDisplayName} API 密钥无效，或当前密钥没有访问权限。`,
    );
  }
  if (response.status === 404) {
    throw new Error(
      `${providerDisplayName} 凭证校验失败：验证接口 ${endpointLabel} 不可用，请检查 Base URL 或上游兼容性。`,
    );
  }
  throw new Error(
    `${providerDisplayName} 凭证校验失败（HTTP ${response.status}）。`,
  );
}

function validationNetworkError(
  providerDisplayName: string,
  error: unknown,
): Error {
  const timeout = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
  return new Error(
    `无法连接 ${providerDisplayName} 的校验接口，请检查网络、Base URL 或代理设置。${timeout ? "请求已超时或取消。" : ""}`,
  );
}
