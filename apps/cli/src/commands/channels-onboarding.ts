import { createInterface } from "node:readline/promises";

import type { Settings } from "@openharness/core";
import type {
  FeishuRegistrationCredentials,
  FeishuRegistrationStatus,
  VerifiedFeishuBot,
} from "@openharness/channels";

/**
 * `ohs channels add feishu` / `ohs channels allow` 的向导逻辑。
 *
 * 所有会产生副作用或需要交互的能力都通过 deps 注入：
 * 真实运行用动态 import 拼默认实现，测试注入假对象即可全程不碰网络/终端。
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

export interface RegistrationLike {
  start(options?: { domain?: FeishuDomain }): FeishuRegistrationStatus;
  status(): FeishuRegistrationStatus;
  cancel(): FeishuRegistrationStatus;
}

export interface CredentialStoreLike {
  get(appId: string): Promise<string | undefined>;
  set(appId: string, secret: string): Promise<void>;
  delete(appId: string): Promise<boolean>;
}

export interface ChannelsOnboardingDeps {
  promptSelect(
    message: string,
    choices: readonly { value: string; label: string }[],
  ): Promise<string>;
  promptText(question: string, options?: { defaultValue?: string }): Promise<string>;
  promptSecret(question: string): Promise<string>;
  promptConfirm(question: string): Promise<boolean>;
  createRegistration(
    onCredentials: (credentials: FeishuRegistrationCredentials) => Promise<void>,
  ): RegistrationLike | Promise<RegistrationLike>;
  createCredentials(): CredentialStoreLike | Promise<CredentialStoreLike>;
  verify(input: { appId: string; appSecret: string; domain: FeishuDomain }): Promise<VerifiedFeishuBot>;
  loadSettings(): Promise<Settings>;
  saveSettings(settings: Settings): Promise<void>;
  renderQr(url: string): void | Promise<void>;
  log(message: string): void;
}

export interface ChannelsAllowDeps {
  loadSettings(): Promise<Settings>;
  saveSettings(settings: Settings): Promise<void>;
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

function missingConfigLog(extra = ""): string {
  return `尚未配置飞书通道，请先运行 ohs channels add feishu。${extra}`;
}

/** 真实环境默认依赖：交互用 readline，其余能力延迟 import，测试不触发。 */
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
    createRegistration: async (onCredentials) => {
      const { FeishuRegistration } = await import("@openharness/channels");
      return new FeishuRegistration({ onCredentials });
    },
    createCredentials: async () => {
      const { ChannelCredentialStore } = await import("@openharness/auth");
      return new ChannelCredentialStore();
    },
    verify: async (input) => {
      const { verifyFeishuCredentials } = await import("@openharness/channels");
      return verifyFeishuCredentials(input);
    },
    loadSettings: async () => {
      const { loadSettings } = await import("@openharness/core");
      return loadSettings();
    },
    saveSettings: async (settings) => {
      const { saveSettings } = await import("@openharness/core");
      await saveSettings(settings);
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
    loadSettings: async () => {
      const { loadSettings } = await import("@openharness/core");
      return loadSettings();
    },
    saveSettings: async (settings) => {
      const { saveSettings } = await import("@openharness/core");
      await saveSettings(settings);
    },
    log: (message) => console.log(message),
  };
}

async function runScan(
  deps: ChannelsOnboardingDeps,
): Promise<FeishuRegistrationCredentials | undefined> {
  let scanned: FeishuRegistrationCredentials | undefined;
  const registration = await deps.createRegistration(async (credentials) => {
    scanned = credentials;
  });

  const onSigint = () => registration.cancel();
  process.on("SIGINT", onSigint);
  try {
    const deadline = Date.now() + 10 * 60_000;
    let lastRendered: string | undefined;
    let snapshot = registration.start({ domain: "feishu" });

    const renderIfNeeded = async (url: string | undefined): Promise<void> => {
      if (!url || url === lastRendered) return;
      lastRendered = url;
      deps.log("请用飞书扫码，或打开下面的链接完成授权：");
      deps.log(url);
      await deps.renderQr(url);
    };

    await renderIfNeeded(snapshot.qrUrl);

    for (;;) {
      const current = registration.status();
      if (current.state === "succeeded") break;

      if (current.state === "expired") {
        const refresh = await deps.promptConfirm("二维码已过期，是否重新生成？");
        if (!refresh) {
          registration.cancel();
          deps.log("已取消飞书接入。");
          return undefined;
        }
        snapshot = registration.start({ domain: current.domain });
        await renderIfNeeded(snapshot.qrUrl);
        continue;
      }

      if (current.state === "error" || current.state === "cancelled") {
        deps.log(`飞书接入失败：${current.error?.message ?? "未知错误"}`);
        return undefined;
      }

      await renderIfNeeded(current.qrUrl);

      if (Date.now() > deadline) {
        registration.cancel();
        deps.log("等待扫码超时，已取消。请重新运行 ohs channels add feishu。");
        return undefined;
      }
      await sleep(current.pollIntervalMs ?? 1000);
    }
  } finally {
    process.off("SIGINT", onSigint);
  }

  if (!scanned) {
    deps.log("扫码流程结束，但没有拿到应用凭据。");
    return undefined;
  }
  return scanned;
}

export async function runChannelsAddFeishu(
  deps?: Partial<ChannelsOnboardingDeps>,
): Promise<ChannelsOnboardingResult> {
  const d: ChannelsOnboardingDeps = { ...createDefaultOnboardingDeps(), ...deps };

  const method = await d.promptSelect("选择飞书接入方式：", [
    { value: "scan", label: "扫码创建应用（推荐）" },
    { value: "manual", label: "手动输入 App ID / App Secret" },
  ]);

  let appId: string;
  let appSecret: string;
  let domain: FeishuDomain;
  let scannerOpenId: string | undefined;

  if (method === "scan") {
    const scanned = await runScan(d);
    if (!scanned) return { ok: false };
    appId = scanned.appId;
    appSecret = scanned.appSecret;
    domain = scanned.domain;
    scannerOpenId = scanned.userId;
  } else {
    appId = (await d.promptText("App ID")).trim();
    appSecret = (await d.promptSecret("App Secret")).trim();
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
  }

  let name: string | undefined;
  try {
    const verified = await d.verify({ appId, appSecret, domain });
    name = verified.name;
  } catch (error) {
    d.log(`凭据校验失败：${error instanceof Error ? error.message : String(error)}`);
    return { ok: false };
  }

  const settings = await d.loadSettings();
  const existing = settings.channels?.feishu;
  const credentials = await d.createCredentials();

  if (existing?.enabled && existing.appId) {
    let existingSecret: string | undefined;
    try {
      existingSecret = await credentials.get(appId);
    } catch (error) {
      d.log(`读取凭据失败：${error instanceof Error ? error.message : String(error)}`);
      return { ok: false };
    }
    if (existingSecret !== undefined) {
      const overwrite = await d.promptConfirm(
        `feishu 已配置（appId: ${existing.appId}），是否覆盖？`,
      );
      if (!overwrite) {
        d.log("已取消，未做任何修改。");
        return { ok: false };
      }
    }
  }

  let previousSecret: string | undefined;
  try {
    previousSecret = await credentials.get(appId);
    await credentials.set(appId, appSecret);
  } catch (error) {
    d.log(`保存凭据失败：${error instanceof Error ? error.message : String(error)}`);
    return { ok: false };
  }

  const allowFrom: Record<string, string> = { ...existing?.allowFrom };
  if (scannerOpenId) allowFrom[scannerOpenId] = scannerOpenId;

  const next: Settings = {
    ...settings,
    channels: {
      ...settings.channels,
      feishu: {
        ...existing,
        enabled: true,
        appId,
        domain,
        allowFrom,
      },
    },
  };

  try {
    await d.saveSettings(next);
  } catch (error) {
    try {
      if (previousSecret === undefined) {
        await credentials.delete(appId);
      } else {
        await credentials.set(appId, previousSecret);
      }
    } catch {
      // 回滚失败只影响残留凭据，不改变主错误；下面照常返回失败。
    }
    d.log(`保存配置失败：${error instanceof Error ? error.message : String(error)}`);
    return { ok: false };
  }

  d.log(`飞书已接入${name ? `：${name}` : ""}（${appId}）。`);
  if (scannerOpenId) d.log(`已把扫码者 ${scannerOpenId} 加入白名单。`);
  d.log("运行 ohs channels serve 开始接收和发送消息。");
  d.log("请在飞书开放平台把事件订阅方式设为「使用长连接接收事件」。");
  return { ok: true, appId, domain, ...(name ? { name } : {}) };
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

  const settings = await d.loadSettings();
  const feishu = settings.channels?.feishu;
  if (!feishu?.appId) {
    d.log(missingConfigLog());
    return { ok: false };
  }

  const allowFrom = { ...feishu.allowFrom, [name ?? id]: id };
  const next: Settings = {
    ...settings,
    channels: {
      ...settings.channels,
      feishu: { ...feishu, allowFrom },
    },
  };
  try {
    await d.saveSettings(next);
  } catch (error) {
    d.log(`保存配置失败：${error instanceof Error ? error.message : String(error)}`);
    return { ok: false };
  }

  d.log(`已放行 ${name ?? id}（${id}）。改完重启 channels serve 生效。`);
  return { ok: true };
}
