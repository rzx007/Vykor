import { Command } from "commander";
import { mainAction } from "./commands/main";
import { createAuthCommand } from "./commands/auth";
import { createMcpCommand } from "./commands/mcp";
import { createPluginCommand } from "./commands/plugin";
import { createChannelsCommand } from "./commands/channels";
import { createProviderCommand } from "./commands/provider";
import { createSetupCommand } from "./commands/setup";
import { createSandboxCommand } from "./commands/sandbox";
import { createWorkflowCommand } from "./commands/workflow";
import { createDebugCommand } from "./commands/debug";
import { createDaemonCommand, createServeCommand } from "./commands/daemon";
import { buildSettingsPatch, coerceConfigValue } from "./config-coerce";
import { reconcileDaemonAutoStart } from "./daemon-auto-start";
import { VERSION } from "./version";

const program = new Command();
program.enablePositionalOptions();

program
  .name("ohs")
  .description(
    "OpenHarness-ts - Open Source AI Agent Framework. Interactive default: TUI/daemon (requires Bun). One-shot: pass a prompt or use -p/--print.",
  )
  .version(VERSION)
  .argument(
    "[prompt]",
    "Initial prompt to send (print mode; omit for interactive TUI)",
  )
  .option("-m, --model <model>", "Model to use")
  .option(
    "-p, --print",
    "Print via daemon Session API and exit (non-interactive; requires a prompt)",
  )
  .option("-n, --name <name>", "Name the session")
  .option("--provider <provider>", "API provider")
  .option(
    "--permission-mode <mode>",
    "Permission mode (default | plan | full_auto)",
  )
  .option("--coordinator", "Start new daemon sessions in coordinator mode")
  .option("--max-turns <n>", "Maximum agentic turns", parseInt)
  .option("-s, --system-prompt <prompt>", "Override system prompt")
  .option("--api-key <key>", "API key override")
  .option("--base-url <url>", "API base URL override")
  .option("--api-format <format>", "API format (anthropic | openai)")
  .option("--theme <theme>", "Theme name")
  .option("--mcp-config <path>", "Path to MCP config JSON")
  .option("--cwd <dir>", "Working directory")
  .option("--effort <level>", "Effort level (low | medium | high)")
  .option("--verbose", "Verbose output")
  .option("-d, --debug", "Debug mode")
  .option(
    "--tui",
    "Explicitly launch TUI/daemon (default when no prompt; requires Bun)",
  )
  .option(
    "--daemon-url <url>",
    "Attach TUI to an explicit daemon URL instead of starting a local daemon",
  )
  .option("--daemon-token <token>", "Bearer token for --daemon-url")
  .option("--dangerously-skip-permissions", "Skip all permission checks")
  .option("--allowed-tools <tools>", "Comma-separated allowed tools")
  .option("--disallowed-tools <tools>", "Comma-separated disallowed tools")
  .option(
    "--output-format <format>",
    "Output format (text | json | stream-json)",
  )
  .option("--append-system-prompt <prompt>", "Append to default system prompt")
  .option("--no-plugins", "Skip all installed Native Plugin contributions for this session")
  .option("--dry-run", "预览解析后的运行时配置，不调用模型")
  .option("--session-id <id>", "预分配的 daemon session ID（内部用）")
  .action(mainAction);

program.addCommand(createAuthCommand());
program.addCommand(createMcpCommand());
program.addCommand(createPluginCommand());
program.addCommand(createChannelsCommand());
program.addCommand(createProviderCommand());
program.addCommand(createSetupCommand());
program.addCommand(createSandboxCommand());
program.addCommand(createWorkflowCommand());
program.addCommand(createDebugCommand());
program.addCommand(createServeCommand());
program.addCommand(createDaemonCommand());

program
  .command("config")
  .description("Show or edit configuration")
  .argument("[action]", "show or set", "show")
  .argument("[key]", "Config key")
  .argument("[value]", "Config value")
  .action(async (action: string, key?: string, value?: string) => {
    const { loadSettings, updateSettings } = await import("@openharness/core");
    const settings = await loadSettings();
    if (action === "show" || !key) {
      console.log(JSON.stringify(settings, null, 2));
    } else if (action === "set" && key && value !== undefined) {
      const topLevelKey = key.split(".")[0]!;
      if (!(topLevelKey in settings)) {
        console.error(`Unknown config key: ${key}`);
        process.exit(1);
        return;
      }
      const coerced = coerceConfigValue(key, value);
      if (coerced === undefined) {
        console.error(`Invalid value for ${key}: ${value}`);
        process.exit(1);
        return;
      }
      await updateSettings((current) => {
        const patch = buildSettingsPatch(
          current as unknown as Record<string, unknown>,
          key,
          coerced,
        );
        return { ...current, ...patch } as typeof current;
      });
      if (key === "daemon.autoStart") {
        const entry = process.argv[1];
        if (!entry) throw new Error("Cannot locate CLI entrypoint.");
        reconcileDaemonAutoStart(entry, coerced as boolean);
      }
      console.log(`Updated ${key}`);
    } else {
      console.error("Usage: oh config show | oh config set <key> <value>");
      process.exit(1);
    }
  });

program
  .command("version")
  .description("Show version information")
  .action(() => {
    console.log(`OpenHarness v${VERSION}`);
    console.log(`Node ${process.version}`);
    console.log(`Platform: ${process.platform} ${process.arch}`);
  });

program
  .command("doctor")
  .description("Check environment and dependencies")
  .action(async () => {
    const chalk = (await import("chalk")).default;
    console.log(chalk.cyan("OpenHarness-ts Doctor"));
    console.log();
    const checks: Array<{ label: string; ok: boolean; detail?: string }> = [];

    let settings: import("@openharness/core").Settings | undefined;
    try {
      const { loadSettings } = await import("@openharness/core");
      settings = await loadSettings();
      checks.push({
        label: "Settings loaded",
        ok: true,
        detail: `provider: ${settings.provider ?? "auto"}, model: ${settings.model}`,
      });
    } catch (err: any) {
      checks.push({ label: "Settings loaded", ok: false, detail: err.message });
    }

    if (settings) {
      const { checkApiKey } = await import("./doctor");
      const keyCheck = await checkApiKey(settings);
      checks.push({
        label: "API key",
        ok: keyCheck.ok,
        detail: keyCheck.source,
      });
    } else {
      checks.push({
        label: "API key",
        ok: false,
        detail: "settings not loaded",
      });
    }

    try {
      const { readFile } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const { homedir } = await import("node:os");
      const claudeMd = join(process.cwd(), "CLAUDE.md");
      await readFile(claudeMd, "utf-8");
      checks.push({ label: "CLAUDE.md", ok: true, detail: "found in cwd" });
    } catch {
      checks.push({
        label: "CLAUDE.md",
        ok: false,
        detail: "not found in cwd",
      });
    }

    for (const c of checks) {
      const icon = c.ok ? chalk.green("✓") : chalk.red("✗");
      console.log(
        `  ${icon} ${c.label}${c.detail ? chalk.gray(` (${c.detail})`) : ""}`,
      );
    }
  });

program.parse();
