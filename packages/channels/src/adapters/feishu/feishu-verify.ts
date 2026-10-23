type FeishuDomain = "feishu" | "lark";

export interface VerifyFeishuCredentialsInput {
  appId: string;
  appSecret: string;
  domain: FeishuDomain;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface VerifiedFeishuBot {
  appId: string;
  name?: string;
  openId?: string;
  activated?: number;
}

function apiBase(domain: FeishuDomain): string {
  return domain === "lark" ? "https://open.larksuite.com" : "https://open.feishu.cn";
}

class FeishuHttpError extends Error {
  constructor() {
    super("feishu http error");
    this.name = "FeishuHttpError";
  }
}

class FeishuInvalidBodyError extends Error {
  constructor() {
    super("feishu invalid body");
    this.name = "FeishuInvalidBodyError";
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  if (!response.ok) {
    throw new FeishuHttpError();
  }
  const parsed: unknown = await response.json();
  if (!isPlainObject(parsed)) {
    throw new FeishuInvalidBodyError();
  }
  return parsed;
}

async function postJson(
  fetchImpl: typeof fetch,
  url: string,
  body: unknown,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return readJson(response);
}

async function getJson(
  fetchImpl: typeof fetch,
  url: string,
  token: string,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const response = await fetchImpl(url, {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  return readJson(response);
}

export async function verifyFeishuCredentials(
  input: VerifyFeishuCredentialsInput,
): Promise<VerifiedFeishuBot> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? 15000;
  const base = apiBase(input.domain);

  let tokenBody: Record<string, unknown>;
  try {
    tokenBody = await postJson(
      fetchImpl,
      `${base}/open-apis/auth/v3/tenant_access_token/internal`,
      { app_id: input.appId, app_secret: input.appSecret },
      timeoutMs,
    );
  } catch (error) {
    if (error instanceof FeishuHttpError || error instanceof FeishuInvalidBodyError) {
      throw new Error("飞书凭据校验失败：appId 或 appSecret 不正确，或地区选择不对。");
    }
    throw new Error("无法连接飞书验证凭据（网络问题）。");
  }
  if (tokenBody.code !== 0 || typeof tokenBody.tenant_access_token !== "string") {
    throw new Error("飞书凭据校验失败：appId 或 appSecret 不正确，或地区选择不对。");
  }

  try {
    const botBody = await getJson(
      fetchImpl,
      `${base}/open-apis/bot/v3/info/`,
      tokenBody.tenant_access_token,
      timeoutMs,
    );
    if (botBody.code === 0 && botBody.bot && typeof botBody.bot === "object") {
      const bot = botBody.bot as Record<string, unknown>;
      return {
        appId: input.appId,
        ...(typeof bot.app_name === "string" ? { name: bot.app_name } : {}),
        ...(typeof bot.open_id === "string" ? { openId: bot.open_id } : {}),
        ...(typeof bot.activate_status === "number" ? { activated: bot.activate_status } : {}),
      };
    }
  } catch {
    // 机器人信息只用于展示，取不到不影响“凭据有效”。
  }
  return { appId: input.appId };
}
