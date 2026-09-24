#!/usr/bin/env node
/**
 * 飞书推送 MCP Server（stdio 模式）
 *
 * 暴露 send_feishu_message 工具，读取 ~/.vykor/settings.json 中的
 * channels.feishu 配置，将消息推送到指定的飞书群或个人会话。
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

interface FeishuConfig {
  appId: string;
  appSecret: string;
  allowFrom: Record<string, string>; // name → chat_id
}

async function loadConfig(): Promise<FeishuConfig> {
  const base = process.env.VYKOR_CONFIG_DIR ?? join(homedir(), ".vykor");
  const raw = JSON.parse(await readFile(join(base, "settings.json"), "utf-8")) as {
    channels?: { feishu?: Partial<FeishuConfig> };
  };
  const f = raw.channels?.feishu;
  if (!f?.appId || !f?.appSecret) {
    throw new Error("channels.feishu.appId / appSecret 未配置");
  }
  return { appId: f.appId, appSecret: f.appSecret, allowFrom: f.allowFrom ?? {} };
}

async function getTenantToken(appId: string, appSecret: string): Promise<string> {
  const res = await fetch(
    "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    },
  );
  const data = (await res.json()) as { tenant_access_token?: string; msg?: string };
  if (!data.tenant_access_token) {
    throw new Error(`获取 token 失败: ${data.msg ?? "unknown"}`);
  }
  return data.tenant_access_token;
}

async function sendToChat(token: string, chatId: string, text: string): Promise<void> {
  const res = await fetch(
    "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        receive_id: chatId,
        msg_type: "text",
        content: JSON.stringify({ text }),
      }),
    },
  );
  const data = (await res.json()) as { code?: number; msg?: string };
  if (data.code !== 0) {
    throw new Error(`发送失败: ${data.msg ?? "unknown"} (code: ${data.code})`);
  }
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new Server({ name: "feishu-push", version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const config = await loadConfig();
  const targets = Object.keys(config.allowFrom);
  return {
    tools: [
      {
        name: "send_feishu_message",
        description: `推送消息到飞书。可用目标：${targets.length > 0 ? targets.join("、") : "（未配置）"}`,
        inputSchema: {
          type: "object" as const,
          properties: {
            target: {
              type: "string",
              description: `推送目标，可选：${targets.join("、")}`,
              ...(targets.length > 0 ? { enum: targets } : {}),
            },
            message: {
              type: "string",
              description: "消息内容（纯文本）",
            },
          },
          required: ["target", "message"],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== "send_feishu_message") {
    throw new Error(`Unknown tool: ${request.params.name}`);
  }
  const { target, message } = request.params.arguments as { target: string; message: string };
  const config = await loadConfig();
  const chatId = config.allowFrom[target];
  if (!chatId) {
    const available = Object.keys(config.allowFrom).join("、") || "（未配置）";
    return {
      content: [{ type: "text" as const, text: `目标「${target}」不存在，可用：${available}` }],
      isError: true,
    };
  }
  try {
    const token = await getTenantToken(config.appId, config.appSecret);
    await sendToChat(token, chatId, message);
    return { content: [{ type: "text" as const, text: `已发送到「${target}」` }] };
  } catch (err) {
    return {
      content: [{ type: "text" as const, text: `发送失败：${(err as Error).message}` }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
