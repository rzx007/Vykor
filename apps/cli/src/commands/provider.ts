import { Command } from "commander";
import { CODEX_DEFAULT_MODEL, detectProvider } from "@vykor/api";
import type { ProviderSpec } from "@vykor/api";
import type { Settings } from "@vykor/core";

export type KeySource = "credentials" | "env" | "external" | "none";

/**
 * 判定某个 provider 的 API key 来源：
 * - credentials.json 里存了 → "credentials"
 * - 否则该 provider 的 envKey 在环境变量里有值 → "env"
 * - 否则 → "none"
 *
 * 纯函数，方便单测。
 */
export function resolveKeySource(
  name: string,
  storedProviders: string[],
  env: NodeJS.ProcessEnv,
  spec?: Pick<ProviderSpec, "envKey">
): KeySource {
  if (storedProviders.includes(name)) return "credentials";
  if (spec?.envKey && env[spec.envKey]) return "env";
  return "none";
}

export interface ApplyProviderConfigInput {
  name: string;
  model?: string;
  baseUrl?: string;
  setActive?: boolean;
}

/**
 * 把 provider 配置应用到 settings，返回一份新的 settings（不改原对象，不落盘）。
 * 调用方负责持久化。供 use/add 以及后续 setup 复用。
 */
export function applyProviderConfig(settings: Settings, input: ApplyProviderConfigInput): Settings {
  const next: Settings = { ...settings };
  const previousProvider = settings.provider;
  if (input.setActive) next.provider = input.name;
  if (input.model !== undefined) next.model = input.model;
  else if (input.setActive && input.name === "codex") next.model = CODEX_DEFAULT_MODEL;
  if (input.baseUrl !== undefined) {
    next.baseUrl = input.baseUrl;
  } else if (input.setActive && previousProvider !== input.name) {
    next.baseUrl = resolveScopedBaseUrl(settings.baseUrl, input.name);
  }
  return next;
}

function resolveScopedBaseUrl(baseUrl: string | undefined, providerName: string): string | undefined {
  if (!baseUrl) return baseUrl;
  const detected = detectProvider("", undefined, baseUrl);
  if (detected && detected.name !== providerName) return undefined;
  return baseUrl;
}

export function createProviderCommand(): Command {
  const cmd = new Command("provider").description("Manage API providers and keys");

  cmd
    .command("list")
    .description("List known providers, their key source and active status")
    .action(async () => {
      const chalk = (await import("chalk")).default;
      const { PROVIDERS } = await import("@vykor/api");
      const { CredentialStorage, describeCodexAuthState } = await import("@vykor/auth");
      const { loadSettings } = await import("@vykor/core");

      const settings = await loadSettings();
      const storage = new CredentialStorage();
      const storedProviders = await storage.listStoredProviders();

      // PROVIDERS 的 name 集合 + credentials 里有但不在 PROVIDERS 里的 name
      const specByName = new Map(PROVIDERS.map((p) => [p.name, p] as const));
      const names = [...PROVIDERS.map((p) => p.name)];
      for (const stored of storedProviders) {
        if (!specByName.has(stored)) names.push(stored);
      }

      const codexState = await describeCodexAuthState();
      const rows = names.map((name) => {
        const spec = specByName.get(name);
        const source =
          name === "codex" && codexState.configured
            ? "external"
            : resolveKeySource(name, storedProviders, process.env, spec);
        return {
          name,
          active: settings.provider === name,
          source,
          displayName: spec?.displayName ?? "(unknown)",
          baseURL: spec?.defaultBaseURL ?? "",
        };
      });

      const nameWidth = Math.max(...rows.map((r) => r.name.length), 4);
      const displayWidth = Math.max(...rows.map((r) => r.displayName.length), 7);

      for (const r of rows) {
        const marker = r.active ? chalk.green("*") : " ";
        const namePad = r.name.padEnd(nameWidth);
        const nameColored = r.active ? chalk.green.bold(namePad) : chalk.bold(namePad);
        const sourceColored =
          r.source === "credentials"
            ? chalk.cyan("credentials")
            : r.source === "env"
              ? chalk.blue("env")
              : r.source === "external"
                ? chalk.magenta("external")
              : chalk.gray("none");
        const display = r.displayName.padEnd(displayWidth);
        const base = r.baseURL ? chalk.gray(r.baseURL) : chalk.gray("(provider default)");
        console.log(
          `${marker} ${nameColored}  ${sourceColored.padEnd(11)}  ${chalk.white(display)}  ${base}`
        );
      }
    });

  cmd
    .command("use")
    .description("Set the active provider")
    .argument("<name>", "Provider name")
    .option("-m, --model <model>", "Also set the model")
    .action(async (name: string, opts: { model?: string }) => {
      const chalk = (await import("chalk")).default;
      const { findByName } = await import("@vykor/api");
      const { updateSettings } = await import("@vykor/core");

      if (!findByName(name)) {
        await warnUnknownProvider(chalk, name);
      }

      const next = await updateSettings((settings) =>
        applyProviderConfig(settings, {
          name,
          model: opts.model,
          setActive: true,
        }),
      );

      console.log(chalk.green(`Active provider set to ${name}`));
      if (next.model) console.log(chalk.gray(`  model: ${next.model}`));
    });

  cmd
    .command("add")
    .description("Store an API key for a provider and optionally configure it")
    .argument("<name>", "Provider name")
    .requiredOption("-k, --api-key <key>", "API key to store")
    .option("-m, --model <model>", "Set the model")
    .option("-b, --base-url <url>", "Set the base URL")
    .option("--use", "Also make this the active provider")
    .action(
      async (
        name: string,
        opts: { apiKey: string; model?: string; baseUrl?: string; use?: boolean }
      ) => {
        const chalk = (await import("chalk")).default;
        const { findByName } = await import("@vykor/api");
        const { CredentialStorage } = await import("@vykor/auth");
        const { updateSettings } = await import("@vykor/core");

        if (!findByName(name)) {
          await warnUnknownProvider(chalk, name);
        }

        const storage = new CredentialStorage();
        await storage.storeCredential(name, "api_key", opts.apiKey);

        const hasSettingsChange =
          opts.model !== undefined || opts.baseUrl !== undefined || opts.use === true;
        if (hasSettingsChange) {
          await updateSettings((settings) =>
            applyProviderConfig(settings, {
              name,
              model: opts.model,
              baseUrl: opts.baseUrl,
              setActive: opts.use,
            }),
          );
        }

        console.log(chalk.green(`Stored API key for ${name} (${maskKey(opts.apiKey)})`));
        if (opts.use) console.log(chalk.gray(`  active provider: ${name}`));
        if (opts.model) console.log(chalk.gray(`  model: ${opts.model}`));
        if (opts.baseUrl) console.log(chalk.gray(`  baseUrl: ${opts.baseUrl}`));
      }
    );

  cmd
    .command("edit")
    .description("Update an existing provider's key or settings")
    .argument("<name>", "Provider name")
    .option("-k, --api-key <key>", "Replace the stored API key")
    .option("-m, --model <model>", "Set the model")
    .option("-b, --base-url <url>", "Set the base URL")
    .action(
      async (name: string, opts: { apiKey?: string; model?: string; baseUrl?: string }) => {
        const chalk = (await import("chalk")).default;
        const { CredentialStorage } = await import("@vykor/auth");
        const { updateSettings } = await import("@vykor/core");

        if (
          opts.apiKey === undefined &&
          opts.model === undefined &&
          opts.baseUrl === undefined
        ) {
          console.error(
            chalk.red("Nothing to edit. Provide at least one of --api-key, --model, --base-url.")
          );
          process.exitCode = 1;
          return;
        }

        if (opts.apiKey !== undefined) {
          const storage = new CredentialStorage();
          await storage.storeCredential(name, "api_key", opts.apiKey);
        }

        const hasSettingsChange = opts.model !== undefined || opts.baseUrl !== undefined;
        if (hasSettingsChange) {
          await updateSettings((settings) =>
            applyProviderConfig(settings, {
              name,
              model: opts.model,
              baseUrl: opts.baseUrl,
            }),
          );
        }

        console.log(chalk.green(`Updated ${name}`));
        if (opts.apiKey !== undefined)
          console.log(chalk.gray(`  api key: ${maskKey(opts.apiKey)}`));
        if (opts.model) console.log(chalk.gray(`  model: ${opts.model}`));
        if (opts.baseUrl) console.log(chalk.gray(`  baseUrl: ${opts.baseUrl}`));
      }
    );

  cmd
    .command("remove")
    .description("Remove a provider's stored credentials")
    .argument("<name>", "Provider name")
    .action(async (name: string) => {
      const chalk = (await import("chalk")).default;
      const { CredentialStorage } = await import("@vykor/auth");
      const { loadSettings } = await import("@vykor/core");

      const storage = new CredentialStorage();
      await storage.clearProviderCredentials(name);
      console.log(chalk.green(`Removed stored credentials for ${name}`));

      const settings = await loadSettings();
      if (settings.provider === name) {
        console.log(
          chalk.yellow(
            `Note: ${name} is the current active provider. settings.provider was not changed; ` +
              `use 'vk provider use <name>' to switch.`
          )
        );
      }
    });

  return cmd;
}

async function warnUnknownProvider(
  chalk: typeof import("chalk").default,
  name: string
): Promise<void> {
  const { PROVIDERS } = await import("@vykor/api");
  console.log(
    chalk.yellow(`Warning: '${name}' is not a known provider. Setting it anyway.`)
  );
  console.log(chalk.gray(`  Known providers: ${PROVIDERS.map((p) => p.name).join(", ")}`));
}

function maskKey(key: string): string {
  return key.length <= 8 ? `${key}...` : `${key.slice(0, 8)}...`;
}
