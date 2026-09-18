import { loadSettings, type Settings } from "@openharness/core";
import type { ToolDefinition } from "@openharness/core";
import { ChannelCredentialStore } from "@openharness/auth";
import { createToolAbortScope } from "../abort.js";

let _settingsCache: Settings | undefined;
async function getCachedSettings(): Promise<Settings> {
  if (!_settingsCache) _settingsCache = await loadSettings();
  return _settingsCache;
}

type FeishuDomain = "feishu" | "lark";

/** 飞书/Lark 开放平台 API 基址；lark 地区走 open.larksuite.com。 */
export function feishuApiBase(domain: FeishuDomain | undefined): string {
  return domain === "lark" ? "https://open.larksuite.com" : "https://open.feishu.cn";
}

export async function getTenantToken(
  appId: string,
  appSecret: string,
  signal: AbortSignal,
  base: string,
): Promise<string> {
  const res = await fetch(
    `${base}/open-apis/auth/v3/tenant_access_token/internal`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      signal,
    },
  );
  const data = (await res.json()) as { tenant_access_token?: string; msg?: string };
  if (!data.tenant_access_token) {
    throw new Error(`获取 tenant_access_token 失败: ${data.msg ?? "unknown"}`);
  }
  return data.tenant_access_token;
}

export async function sendToChat(
  token: string,
  chatId: string,
  text: string,
  signal: AbortSignal,
  base: string,
): Promise<void> {
  const res = await fetch(
    `${base}/open-apis/im/v1/messages?receive_id_type=chat_id`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        receive_id: chatId,
        msg_type: "text",
        content: JSON.stringify({ text }),
      }),
      signal,
    },
  );
  const data = (await res.json()) as { code?: number; msg?: string };
  if (data.code !== 0) {
    throw new Error(`发送失败: ${data.msg ?? "unknown"} (code: ${data.code})`);
  }
}

export const feishuPushTool: ToolDefinition = {
  name: "FeishuPush",
  description:
    "Push a text message to a Feishu (Lark) chat. " +
    "Reads the app id and target mapping from settings.channels.feishu, and the app secret from the channel credential store. " +
    "Use target names defined in allowFrom (e.g. '个人', '工作群').",
  inputSchema: {
    type: "object",
    properties: {
      target: {
        type: "string",
        description:
          "Target name as defined in settings.channels.feishu.allowFrom (e.g. '个人' or '工作群').",
      },
      message: {
        type: "string",
        description: "Plain-text message to send.",
      },
    },
    required: ["target", "message"],
  },
  async execute(input, context) {
    const target = input.target as string;
    const message = input.message as string;

    const settings = await getCachedSettings();
    const feishu = settings.channels?.feishu;
    if (!feishu?.appId) {
      return { content: [{ type: "text" as const, text: "Error: channels.feishu 未配置 appId" }], isError: true };
    }

    const allowFrom = feishu.allowFrom ?? {};
    const chatId = allowFrom[target];
    if (!chatId) {
      const available = Object.keys(allowFrom).join("、") || "（未配置）";
      return {
        content: [{ type: "text" as const, text: `Error: 目标「${target}」不存在。可用目标：${available}` }],
        isError: true,
      };
    }

    const abortScope = createToolAbortScope(context.abortSignal, 20_000);
    try {
      const appSecret = await new ChannelCredentialStore().get(feishu.appId);
      if (!appSecret) {
        return {
          content: [{ type: "text" as const, text: "Error: channels.feishu 缺少凭据，请先运行 ohs channels add feishu" }],
          isError: true,
        };
      }

      const base = feishuApiBase(feishu.domain);
      const token = await getTenantToken(feishu.appId, appSecret, abortScope.signal, base);
      await sendToChat(token, chatId, message, abortScope.signal, base);
      return { content: [{ type: "text" as const, text: `已发送到「${target}」` }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }], isError: true };
    } finally {
      abortScope.dispose();
    }
  },
};
