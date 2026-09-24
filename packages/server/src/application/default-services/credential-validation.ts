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
    });
  } catch (error) {
    throw validationNetworkError(input.providerDisplayName, error);
  }
  await assertValidationResponse(
    input.providerDisplayName,
    response,
    "OpenAI 兼容 /models",
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
    });
  } catch (error) {
    throw validationNetworkError(input.providerDisplayName, error);
  }
  await assertValidationResponse(
    input.providerDisplayName,
    response,
    "Gemini 原生 /models",
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
    });
  } catch (error) {
    throw validationNetworkError(input.providerDisplayName, error);
  }
  await assertValidationResponse(
    input.providerDisplayName,
    response,
    "Anthropic /models",
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
): Promise<void> {
  if (response.ok) return;
  const detail = await safeValidationErrorDetail(response);
  if (response.status === 401 || response.status === 403) {
    throw new Error(
      `${providerDisplayName} API 密钥无效，或当前密钥没有访问权限。` +
        (detail ? ` ${detail}` : ""),
    );
  }
  if (response.status === 404) {
    throw new Error(
      `${providerDisplayName} 凭证校验失败：验证接口 ${endpointLabel} 不可用，请检查 Base URL 或上游兼容性。` +
        (detail ? ` ${detail}` : ""),
    );
  }
  throw new Error(
    `${providerDisplayName} 凭证校验失败（HTTP ${response.status}）。` +
      (detail ? ` ${detail}` : ""),
  );
}

async function safeValidationErrorDetail(response: Response): Promise<string> {
  try {
    const text = (await response.text()).replace(/\s+/g, " ").trim();
    if (!text) return "";
    return text.length > 180 ? `${text.slice(0, 180)}...` : text;
  } catch {
    return "";
  }
}

function validationNetworkError(
  providerDisplayName: string,
  error: unknown,
): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(
    `无法连接 ${providerDisplayName} 的校验接口，请检查网络、Base URL 或代理设置。${message ? ` ${message}` : ""}`,
  );
}
