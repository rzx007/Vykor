import { createInterface } from "node:readline/promises";

import type {
  FeishuChannelSnapshot,
  FeishuRegistrationSnapshot,
} from "@openharness/client";

/**
 * `ohs channels add feishu` / `ohs channels allow` 的向导逻辑。
 *
 * 配置与接入都由 daemon 负责（唯一写入者），这里只做终端交互与编排：
 * 通过注入的 client 调 daemon 的 `/channels/feishu/*` 接口。
 */

type FeishuDomain = "feishu" | "lark";

export interface ChannelsOnboardingResult {
  ok: boolean;
  appId?: string;
  domain?: FeishuDomain;
  name?: string;
}

export interface ChannelsAllowResult {
  ok: boolean;
}

/** daemon 渠道接口的最小客户端面（便于测试注入）。 */
export interface ChannelsClientLike {
  channels: {
    startFeishuRegistration(input?: {
      domain?: FeishuDomain;
    }): Promise<FeishuRegistrationSnapshot>;
    feishuRegistrationStatus(): Promise<FeishuRegistrationSnapshot>;
    cancelFeishuRegistration(): Promise<FeishuRegistrationSnapshot>;
    getFeishu(): Promise<FeishuChannelSnapshot>;
    connectFeishu(input: {
      appId: string;
      appSecret: string;
      domain?: FeishuDomain;
    }): Promise<{ feishu: FeishuChannelSnapshot }>;
    addFeishuAllow(input: { id: string; name?: string }): Promise<FeishuChannelSnapshot>;
  };
}

export interface ChannelsOnboardingDeps {
  promptSelect(
    message: string,
    choices: readonly { value: string; label: string }[],
  ): Promise<string>;
  promptText(question: string, options?: { defaultValue?: string }): Promise<string>;
  promptSecret(question: string): Promise<string>;
  promptConfirm(question: string): Promise<boolean>;
  createClient(): Promise<ChannelsClientLike>;
  renderQr(url: string): void | Promise<void>;
  log(message: string): void;
}

export interface ChannelsAllowDeps {
  createClient(): Promise<ChannelsClientLike>;
  log(message: string): void;
}

type QrModule = { generate(input: string, opts?: { small: boolean }): void };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ask(question: string): Promise<string> {
  const reader = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await reader.question(question);
  } finally {
    reader.close();
  }
}

/** 读取敏感输入：终端下关掉回显，非 TTY 退化为普通输入（测试不会走到这里）。 */
async function askSecret(question: string): Promise<string> {
  if (!process.stdin.isTTY) return ask(question);
  process.stdout.write(question);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  return new Promise<string>((resolve) => {
    let value = "";
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.off("data", onData);
          process.stdout.write("\n");
          resolve(value);
          return;
        }
        if (ch === "\u0003") {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.off("data", onData);
          process.stdout.write("\n");
          process.exit(130);
        }
        if (ch === "\u007f" || ch === "\b") {
          value = value.slice(0, -1);
        } else {
          value += ch;
        }
      }
    };
    process.stdin.on("data", onData);
  });
}

function parseDomain(value: string): FeishuDomain | undefined {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return "feishu";
  return normalized === "feishu" || normalized === "lark" ? normalized : undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function missingConfigLog(): string {
  return "尚未配置飞书通道，请先运行 ohs channels add feishu。";
}

function tailLog(): string[] {
  return [
    "运行 ohs channels serve 开始接收和发送消息。",
    "请在飞书开放平台把事件订阅方式设为「使用长连接接收事件」。",
  ];
}

/** 真实环境默认依赖：交互用 readline，client 延迟 import，测试不触发。 */
export function createDefaultOnboardingDeps(): ChannelsOnboardingDeps {
  return {
    promptSelect: async (message, choices) => {
      console.log(message);
      choices.forEach((choice, index) => console.log(`  ${index + 1}) ${choice.label}`));
      for (;;) {
        const answer = (await ask("> ")).trim();
        const index = Number.parseInt(answer, 10);
        if (Number.isInteger(index) && index >= 1 && index <= choices.length) {
          return choices[index - 1]!.value;
        }
        const byValue = choices.find((choice) => choice.value === answer);
        if (byValue) return byValue.value;
        console.log("无效选择，请重试。");
      }
    },
    promptText: async (question, options) => {
      const suffix = options?.defaultValue ? `（默认 ${options.defaultValue}）` : "";
      const answer = (await ask(`${question}${suffix}: `)).trim();
      return answer || options?.defaultValue || "";
    },
    promptSecret: (question) => askSecret(`${question}: `),
    promptConfirm: async (question) => {
      const answer = (await ask(`${question} [y/N] `)).trim().toLowerCase();
      return answer === "y" || answer === "yes";
    },
    createClient: async () => {
      const { ensureLocalDaemon } = await import("../ensure-daemon.js");
      const daemon = await ensureLocalDaemon();
      const { OpenHarnessClient } = await import("@openharness/client");
      return new OpenHarnessClient({ baseUrl: daemon.url, token: daemon.token });
    },
    renderQr: async (url) => {
      if (!process.stdout.isTTY) return;
      const mod = (await import("qrcode-terminal")) as unknown as QrModule & {
        default?: QrModule;
      };
      const qrcode = mod.default ?? mod;
      qrcode.generate(url, { small: true });
    },
    log: (message) => console.log(message),
  };
}

export function createDefaultAllowDeps(): ChannelsAllowDeps {
  return {
    createClient: async () => {
      const { ensureLocalDaemon } = await import("../ensure-daemon.js");
      const daemon = await ensureLocalDaemon();
      const { OpenHarnessClient } = await import("@openharness/client");
      return new OpenHarnessClient({ baseUrl: daemon.url, token: daemon.token });
    },
    log: (message) => console.log(message),
  };
}

async function runScan(
  deps: ChannelsOnboardingDeps,
  client: ChannelsClientLike,
): Promise<{ appId?: string; warning?: string } | undefined> {
  const deadline = Date.now() + 10 * 60_000;
  let lastRendered: string | undefined;

  const renderIfNeeded = async (snapshot: FeishuRegistrationSnapshot): Promise<void> => {
    const url = snapshot.qrUrl;
    if (!url || url === lastRendered) return;
    lastRendered = url;
    deps.log("请用飞书扫码，或打开下面的链接完成授权：");
    deps.log(url);
    await deps.renderQr(url);
  };

  const onSigint = () => {
    void client.channels.cancelFeishuRegistration().catch(() => undefined);
  };
  process.on("SIGINT", onSigint);
  try {
    await renderIfNeeded(
      await client.channels.startFeishuRegistration({ domain: "feishu" }),
    );

    for (;;) {
      const current = await client.channels.feishuRegistrationStatus();
      if (current.state === "succeeded") {
        const feishu = await client.channels.getFeishu();
        return {
          ...(feishu.appId ? { appId: feishu.appId } : {}),
          ...(current.warning ? { warning: current.warning } : {}),
        };
      }

      if (current.state === "expired") {
        const refresh = await deps.promptConfirm("二维码已过期，是否重新生成？");
        if (!refresh) {
          await client.channels.cancelFeishuRegistration();
          deps.log("已取消飞书接入。");
          return undefined;
        }
        await renderIfNeeded(
          await client.channels.startFeishuRegistration({ domain: current.domain }),
        );
        continue;
      }

      if (current.state === "error" || current.state === "cancelled") {
        deps.log(`飞书接入失败：${current.error?.message ?? "未知错误"}`);
        return undefined;
      }

      await renderIfNeeded(current);

      if (Date.now() > deadline) {
        await client.channels.cancelFeishuRegistration();
        deps.log("等待扫码超时，已取消。请重新运行 ohs channels add feishu。");
        return undefined;
      }
      await sleep(current.pollIntervalMs ?? 1000);
    }
  } finally {
    process.off("SIGINT", onSigint);
  }
}

export async function runChannelsAddFeishu(
  deps?: Partial<ChannelsOnboardingDeps>,
): Promise<ChannelsOnboardingResult> {
  const d: ChannelsOnboardingDeps = { ...createDefaultOnboardingDeps(), ...deps };

  const method = await d.promptSelect("选择飞书接入方式：", [
    { value: "scan", label: "扫码创建应用（推荐）" },
    { value: "manual", label: "手动输入 App ID / App Secret" },
  ]);

  let client: ChannelsClientLike;
  try {
    client = await d.createClient();
  } catch (error) {
    d.log(`连接 daemon 失败：${messageOf(error)}`);
    return { ok: false };
  }

  if (method === "scan") {
    const scanned = await runScan(d, client);
    if (!scanned) return { ok: false };
    d.log(`飞书已接入${scanned.appId ? `（${scanned.appId}）` : ""}。`);
    if (scanned.warning) d.log(`注意：${scanned.warning}`);
    for (const line of tailLog()) d.log(line);
    return {
      ok: true,
      ...(scanned.appId ? { appId: scanned.appId } : {}),
      domain: "feishu",
    };
  }

  const appId = (await d.promptText("App ID")).trim();
  const appSecret = (await d.promptSecret("App Secret")).trim();
  let domain: FeishuDomain;
  for (;;) {
    const domainAnswer = await d.promptText("开放平台地区（feishu 国内 / lark 国际）", {
      defaultValue: "feishu",
    });
    const parsed = parseDomain(domainAnswer);
    if (parsed) {
      domain = parsed;
      break;
    }
    d.log(`无法识别的地区「${domainAnswer.trim()}」，请输入 feishu 或 lark。`);
  }
  if (!appId || !appSecret) {
    d.log("App ID 与 App Secret 都不能为空。");
    return { ok: false };
  }

  let existing: FeishuChannelSnapshot;
  try {
    existing = await client.channels.getFeishu();
  } catch (error) {
    d.log(`读取渠道配置失败：${messageOf(error)}`);
    return { ok: false };
  }
  if (existing.configured && existing.appId) {
    const overwrite = await d.promptConfirm(
      `feishu 已配置（appId: ${existing.appId}），是否覆盖？`,
    );
    if (!overwrite) {
      d.log("已取消，未做任何修改。");
      return { ok: false };
    }
  }

  try {
    const { feishu } = await client.channels.connectFeishu({ appId, appSecret, domain });
    d.log(`飞书已接入（${feishu.appId ?? appId}）。`);
    for (const line of tailLog()) d.log(line);
    return { ok: true, appId: feishu.appId ?? appId, domain };
  } catch (error) {
    d.log(`凭据校验失败：${messageOf(error)}`);
    return { ok: false };
  }
}

export async function runChannelsAllow(
  id: string,
  name?: string,
  deps?: Partial<ChannelsAllowDeps>,
): Promise<ChannelsAllowResult> {
  const d: ChannelsAllowDeps = { ...createDefaultAllowDeps(), ...deps };

  if (!/^(ou_|oc_)/.test(id)) {
    d.log(`无效的飞书 ID：${id}（应以 ou_ 或 oc_ 开头）。`);
    return { ok: false };
  }

  let client: ChannelsClientLike;
  try {
    client = await d.createClient();
  } catch (error) {
    d.log(`连接 daemon 失败：${messageOf(error)}`);
    return { ok: false };
  }

  let feishu: FeishuChannelSnapshot;
  try {
    feishu = await client.channels.getFeishu();
  } catch (error) {
    d.log(`读取渠道配置失败：${messageOf(error)}`);
    return { ok: false };
  }
  if (!feishu.configured) {
    d.log(missingConfigLog());
    return { ok: false };
  }

  try {
    await client.channels.addFeishuAllow({ id, ...(name ? { name } : {}) });
  } catch (error) {
    d.log(`保存配置失败：${messageOf(error)}`);
    return { ok: false };
  }

  d.log(`已放行 ${name ?? id}（${id}），即时生效。`);
  return { ok: true };
}
