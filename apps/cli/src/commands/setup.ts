import { Command } from "commander";
import * as readline from "node:readline";
import { CODEX_DEFAULT_MODEL, type ProviderSpec } from "@vykor/api";
import type { Settings } from "@vykor/core";
import { applyProviderConfig } from "./provider";

export interface SetupChoice {
  providerName: string;
  apiKey?: string;
  /** Empty string means "leave model unset". */
  model: string;
}

export interface SetupConfig {
  /** 入参给 applyProviderConfig 的 patch（外加 apiFormat，单独处理）。 */
  settingsPatch: {
    provider: string;
    model?: string;
    apiFormat: Settings["apiFormat"];
  };
  credential?: {
    provider: string;
    type: "api_key";
    value: string;
  };
}

/**
 * 把"用户在向导里的选择"映射成可落盘的配置（纯函数，便于单测）。
 *
 * - apiFormat 由该 provider 的 backendType 决定：anthropic→"anthropic"、
 *   openai_compat→"openai"（未知 spec 回退 "openai"）。
 * - model 为空串时不写入 settings.model（保留现有值）。
 * - 交互层只负责收集 SetupChoice，写入逻辑（applyProviderConfig + storeCredential）
 *   由调用方按本函数的输出执行。
 */
export function buildSetupConfig(
  choice: SetupChoice,
  spec: Pick<ProviderSpec, "backendType"> | undefined,
): SetupConfig {
  const apiFormat: Settings["apiFormat"] = spec?.backendType === "anthropic" ? "anthropic" : "openai";
  const isCodex = spec?.backendType === "codex" || choice.providerName === "codex";
  const trimmedModel = choice.model.trim() || (isCodex ? CODEX_DEFAULT_MODEL : "");
  return {
    settingsPatch: {
      provider: choice.providerName,
      ...(trimmedModel ? { model: trimmedModel } : {}),
      apiFormat,
    },
    ...(isCodex
      ? {}
      : {
          credential: {
            provider: choice.providerName,
            type: "api_key" as const,
            value: choice.apiKey ?? "",
          },
        }),
  };
}

function maskKey(key: string): string {
  if (!key) return "(empty)";
  return key.length <= 8 ? `${key.slice(0, 2)}...` : `${key.slice(0, 6)}...${key.slice(-2)}`;
}

export function createSetupCommand(): Command {
  return new Command("setup")
    .description("Interactive first-time setup wizard")
    .action(async () => {
      const chalk = (await import("chalk")).default;
      const { PROVIDERS } = await import("@vykor/api");
      const { CredentialStorage, describeCodexAuthState } = await import("@vykor/auth");
      const { loadSettings, updateSettings } = await import("@vykor/core");

      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const ask = (q: string): Promise<string> =>
        new Promise((resolve) => rl.question(q, (a) => resolve(a)));

      try {
        // 已有 settings 时提醒会覆盖 provider/model。
        const existing = await loadSettings();
        if (existing.provider || existing.model) {
          console.log(
            chalk.yellow(
              `Existing config detected (provider: ${existing.provider ?? "auto"}, model: ${existing.model ?? "unset"}).`,
            ),
          );
          console.log(chalk.yellow("Setup will overwrite the active provider and model."));
          const proceed = (await ask(chalk.gray("Continue? [y/N] "))).trim().toLowerCase();
          if (proceed !== "y" && proceed !== "yes") {
            console.log(chalk.gray("Cancelled."));
            return;
          }
        }

        // ① 列出已知 provider 让用户选编号。
        console.log(chalk.cyan.bold("\nChoose a provider:"));
        PROVIDERS.forEach((p, i) => {
          const base = p.defaultBaseURL ? chalk.gray(p.defaultBaseURL) : chalk.gray("(provider default)");
          console.log(`  ${chalk.bold(String(i + 1).padStart(2))}. ${chalk.white(p.displayName.padEnd(14))} ${base}`);
        });

        let spec: ProviderSpec | undefined;
        while (!spec) {
          const ans = (await ask(chalk.gray(`\nProvider number [1-${PROVIDERS.length}]: `))).trim();
          const idx = Number.parseInt(ans, 10);
          if (Number.isInteger(idx) && idx >= 1 && idx <= PROVIDERS.length) {
            spec = PROVIDERS[idx - 1];
          } else {
            console.log(chalk.red("  Invalid choice, try again."));
          }
        }

        // ② 输 API key（最小版不做隐藏输入）。
        let apiKey = "";
        if (spec.name === "codex") {
          const codexState = await describeCodexAuthState();
          if (!codexState.configured) {
            console.log(chalk.red(`\nCodex Subscription is ${codexState.state}.`));
            console.log(chalk.gray(`  source: ${codexState.source}`));
            if (codexState.detail) console.log(chalk.gray(`  ${codexState.detail}`));
            console.log(chalk.gray("Log in with the Codex CLI first, then re-run setup."));
            return;
          }
          console.log(chalk.green("\nCodex Subscription ready."));
          console.log(chalk.gray(`  source: ${codexState.source}`));
          if (codexState.profileLabel) console.log(chalk.gray(`  account: ${codexState.profileLabel}`));
        } else {
          console.log(chalk.gray("\nNote: the key will be echoed as you type (no hidden input)."));
          apiKey = (await ask(chalk.gray(`API key for ${spec.displayName}: `))).trim();
        }

        // ③ 输 model（无内置默认，留空让用户填）。
        const model = (await ask(chalk.gray("Model (leave empty to set later): "))).trim();

        // ④ 确认。
        const config = buildSetupConfig(
          { providerName: spec.name, apiKey, model },
          spec,
        );
        console.log(chalk.cyan.bold("\nAbout to write:"));
        console.log(`  provider:  ${chalk.white(config.settingsPatch.provider)}`);
        console.log(`  model:     ${chalk.white(config.settingsPatch.model || "(unset)")}`);
        console.log(`  apiFormat: ${chalk.white(config.settingsPatch.apiFormat)}`);
        console.log(`  api key:   ${chalk.white(config.credential ? maskKey(apiKey) : "(external Codex login)")}`);
        const confirm = (await ask(chalk.gray("\nSave this configuration? [y/N] "))).trim().toLowerCase();
        if (confirm !== "y" && confirm !== "yes") {
          console.log(chalk.gray("Cancelled. Nothing was written."));
          return;
        }

        // 确认后落盘：存 credential + 写 settings（复用 applyProviderConfig）。
        if (config.credential) {
          const storage = new CredentialStorage();
          await storage.storeCredential(
            config.credential.provider,
            config.credential.type,
            config.credential.value,
          );
        }

        await updateSettings((settings) => {
          const next = applyProviderConfig(settings, {
            name: config.settingsPatch.provider,
            model: config.settingsPatch.model,
            setActive: true,
          });
          next.apiFormat = config.settingsPatch.apiFormat;
          return next;
        });

        console.log(chalk.green(`\nDone. Active provider set to ${spec.displayName} (${spec.name}).`));
        console.log(chalk.gray("Verify with:"));
        console.log(chalk.gray("  vk doctor"));
        console.log(chalk.gray('  vk "hello"'));
      } finally {
        rl.close();
      }
    });
}
