import { Command } from "commander";

export function createAuthCommand(): Command {
  const cmd = new Command("auth").description("Manage auth sources");

  cmd
    .command("login")
    .description("Authenticate with a provider or auth workflow")
    .argument("[target]", "Provider or auth workflow name")
    .argument("[credential]", "API key for API-key providers")
    .option("-k, --api-key <key>", "API key")
    .option("-p, --provider <provider>", "Provider name")
    .action(async (target?: string, credential?: string, opts?: { apiKey?: string; provider?: string }) => {
      const chalk = (await import("chalk")).default;
      const { CredentialStorage } = await import("@vykor/auth");

      const normalizedTarget = normalizeAuthTarget(opts?.provider ?? target);
      if (normalizedTarget === "codex") {
        await reportCodexLogin(chalk);
        return;
      }

      const apiKey = opts?.apiKey ?? credential;
      if (!apiKey) {
        console.error(chalk.red("Usage: vk auth login <provider> <api-key>"));
        console.log(chalk.gray("Example: vk auth login deepseek sk-..."));
        console.log(chalk.gray("Codex subscription: vk auth login codex"));
        process.exitCode = 1;
        return;
      }

      const provider = normalizedTarget ?? guessProviderFromKey(apiKey);
      const storage = new CredentialStorage();
      await storage.storeApiKey(provider, apiKey);
      console.log(chalk.green(`Stored API key for ${provider} (${maskKey(apiKey)})`));
      console.log(chalk.gray(`Use 'vk provider use ${provider}' to make it active.`));
    });

  cmd
    .command("status")
    .description("Show authentication status")
    .action(async () => {
      const chalk = (await import("chalk")).default;
      const { CredentialStorage, describeCodexAuthState } = await import("@vykor/auth");
      const { PROVIDERS } = await import("@vykor/api");
      const storage = new CredentialStorage();
      const stored = new Set(await storage.listStoredProviders());
      const codexState = await describeCodexAuthState();

      let anyConfigured = false;
      for (const provider of PROVIDERS) {
        if (provider.name === "codex") {
          anyConfigured ||= codexState.configured;
          const color = codexState.configured ? chalk.green : chalk.gray;
          const detail = codexState.configured
            ? `ready (${codexState.profileLabel ?? codexState.source})`
            : `${codexState.state} (${codexState.source})`;
          console.log(color(`  ${provider.displayName}: ${detail}`));
          continue;
        }

        const hasStored = stored.has(provider.name);
        const hasEnv = Boolean(provider.envKey && process.env[provider.envKey]);
        anyConfigured ||= hasStored || hasEnv;
        if (hasStored) {
          console.log(chalk.green(`  ${provider.displayName}: configured (credentials.json)`));
        } else if (hasEnv) {
          console.log(chalk.green(`  ${provider.displayName}: configured (${provider.envKey})`));
        } else if (!provider.isLocal) {
          console.log(chalk.gray(`  ${provider.displayName}: not set${provider.envKey ? ` (${provider.envKey})` : ""}`));
        }
      }

      if (!anyConfigured) {
        console.log(chalk.yellow("\nNo authentication configured."));
        console.log(chalk.gray("  API key: vk auth login <provider> <api-key>"));
        console.log(chalk.gray("  Codex:   vk auth login codex"));
      }
    });

  cmd
    .command("logout")
    .description("Clear stored credentials for a provider")
    .argument("[provider]", "Provider name")
    .action(async (provider?: string) => {
      const chalk = (await import("chalk")).default;
      const { CredentialStorage } = await import("@vykor/auth");
      if (!provider) {
        console.error(chalk.red("Usage: vk auth logout <provider>"));
        console.log(chalk.gray("For Codex, this only clears Vykor state; Codex CLI login remains managed by Codex."));
        process.exitCode = 1;
        return;
      }
      const storage = new CredentialStorage();
      await storage.clearProviderCredentials(provider);
      console.log(chalk.green(`Credentials cleared for ${provider}.`));
      if (provider === "codex") {
        console.log(chalk.gray("Codex CLI auth.json was not removed."));
      }
    });

  return cmd;
}

async function reportCodexLogin(chalk: typeof import("chalk").default): Promise<void> {
  const { describeCodexAuthState } = await import("@vykor/auth");
  const state = await describeCodexAuthState();
  if (state.configured) {
    console.log(chalk.green("Codex Subscription: ready"));
    console.log(chalk.gray(`  source: ${state.source}`));
    if (state.profileLabel) console.log(chalk.gray(`  account: ${state.profileLabel}`));
    console.log(chalk.gray("Use 'vk provider use codex' to make it active."));
    return;
  }

  console.error(chalk.red(`Codex Subscription: ${state.state}`));
  console.error(chalk.gray(`  source: ${state.source}`));
  if (state.detail) console.error(chalk.gray(`  ${state.detail}`));
  console.error(chalk.gray("Log in with the Codex CLI first, then re-run this command."));
  process.exitCode = 1;
}

function normalizeAuthTarget(target?: string): string | undefined {
  const normalized = target?.trim().toLowerCase().replace(/_/g, "-");
  if (!normalized) return undefined;
  if (
    normalized === "codex" ||
    normalized === "openai-codex" ||
    normalized === "codex-subscription"
  ) {
    return "codex";
  }
  return normalized;
}

function guessProviderFromKey(key: string): string {
  if (key.startsWith("sk-ant-")) return "anthropic";
  if (key.startsWith("sk-or-")) return "openrouter";
  if (key.startsWith("sk-")) return "openai";
  return "unknown";
}

function maskKey(key: string): string {
  return key.length <= 8 ? `${key}...` : `${key.slice(0, 8)}...`;
}
