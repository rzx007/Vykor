import { join, resolve } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { OpenHarnessClient, type PluginInfo } from "@openharness/client";
import {
  requestedPluginPermissions,
  validateNativePlugin,
} from "@openharness/plugins";
import { createBuiltinConverterRegistry, type ConversionPlan } from "@openharness/plugin-converters";
import { Command } from "commander";
import { ensureLocalDaemon } from "../ensure-daemon.js";

async function client(): Promise<OpenHarnessClient> {
  const daemon = await ensureLocalDaemon();
  return new OpenHarnessClient({ baseUrl: daemon.url, token: daemon.token });
}
const collect = (value: string, previous: string[]) => [...previous, value];

function formatConversionPlan(plan: ConversionPlan): string {
  return plan.items.map(item => [
    `${item.fidelity.padEnd(11)} ${item.id}`,
    ...(item.reason ? [`  ${item.reason}`] : []),
    ...(item.requiredApprovals ?? []).map(approval => `  --approve ${JSON.stringify(approval)}`),
  ].join("\n")).join("\n");
}

type PluginListResult = { plugins: PluginInfo[]; warnings: string[] };

const activationLabels: Record<PluginInfo["activation"], string> = {
  inactive: "inactive",
  active: "active",
  partial: "partial",
  "reload-required": "reload required",
};

function table(rows: string[][]): string {
  const widths = rows[0]!.map((_, column) =>
    Math.max(...rows.map((row) => displayWidth(row[column] ?? ""))),
  );
  return rows
    .map((row, rowIndex) =>
      row
        .map((value, column) =>
          column === row.length - 1
            ? value
            : `${value}${" ".repeat(widths[column]! - displayWidth(value))}`,
        )
        .join("  "),
    )
    .map((line, index) =>
      index === 0
        ? `${line}\n${widths.map((width) => "─".repeat(width)).join("  ")}`
        : line,
    )
    .join("\n");
}

function displayWidth(value: string): number {
  return [...value].reduce((width, character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return width + (codePoint >= 0x1100 ? 2 : 1);
  }, 0);
}

export function formatPluginList(
  result: PluginListResult,
  verbose = false,
): string {
  if (!result.plugins.length) return "No Native Plugins installed.";
  const rows = [
    ["PLUGIN", "VERSION", "SCOPE", "STATUS", "ACTIVATION", "TOOLS"],
    ...result.plugins.map((plugin) => [
      plugin.identity.displayName ?? plugin.identity.name ?? plugin.identity.id,
      plugin.identity.version,
      plugin.scope,
      plugin.enabled ? "enabled" : "disabled",
      activationLabels[plugin.activation],
      plugin.toolRuntime
        ? `${plugin.toolRuntime.registeredToolCount}/${plugin.toolRuntime.declaredEntries}`
        : String(plugin.inventory.tools ?? 0),
    ]),
  ];
  const sections = [table(rows)];
  if (verbose) {
    sections.push(
      result.plugins
        .map((plugin) => {
          const runtime = plugin.toolRuntime;
          const details = [
            `${plugin.identity.id}@${plugin.identity.version}`,
            `  origin       ${plugin.origin}${plugin.sourceFormat ? ` (${plugin.sourceFormat})` : ""}`,
            `  installation ${plugin.installation}`,
            `  permissions  ${plugin.permissions.approved.length}/${plugin.permissions.requested.length} approved`,
            `  contributions ${
              Object.entries(plugin.inventory)
                .map(([name, count]) => `${name}=${count}`)
                .join(", ") || "none"
            }`,
          ];
          if (runtime) {
            details.push(
              `  tool runtime ${runtime.state}; hosts=${runtime.hostCount}; registered=${runtime.registeredToolCount}`,
            );
          }
          if (plugin.permissions.missing.length) {
            details.push(
              `  missing       ${plugin.permissions.missing.join(", ")}`,
            );
          }
          for (const diagnostic of plugin.diagnostics) {
            details.push(
              `  ${diagnostic.severity.padEnd(13)} ${diagnostic.code}: ${diagnostic.message}`,
            );
          }
          return details.join("\n");
        })
        .join("\n\n"),
    );
  }
  if (result.warnings.length) {
    sections.push(
      result.warnings.map((warning) => `warning: ${warning}`).join("\n"),
    );
  }
  return sections.join("\n\n");
}

export function createPluginCommand(): Command {
  const cmd = new Command("plugin").description("Manage Native Plugins");
  cmd
    .command("list")
    .option("--cwd <path>")
    .option(
      "--verbose",
      "show permissions, contributions, runtime, and diagnostics",
    )
    .option("--json", "print the complete machine-readable response")
    .action(async (options) => {
      const c = await client();
      const result = await c.plugins.list({ cwd: resolve(options.cwd ?? process.cwd()) });
      console.log(
        options.json
          ? JSON.stringify(result, null, 2)
          : formatPluginList(result, options.verbose),
      );
    });
  cmd.command("validate").argument("<path>").action(async (path) => {
    const result = await validateNativePlugin(resolve(path));
    if (result.status === "valid") console.log(`Valid Native Plugin: ${result.plugin!.manifest.id}@${result.plugin!.manifest.version}`);
    else { for (const item of result.diagnostics) console.error(`${item.code}: ${item.message}`); process.exitCode = 1; }
  });
  for (const [name, link] of [["install-local", false], ["link", true]] as const) {
    cmd.command(name).argument("<path>")
      .option("--cwd <path>").option("--approve <permission>", "approve a requested permission", collect, [])
      .action(async (path, options) => {
        const sourcePath = resolve(path);
        const validation = await validateNativePlugin(sourcePath);
        if (!validation.plugin) throw new Error(validation.diagnostics.map((item) => item.message).join("; "));
        const requested = requestedPluginPermissions(validation.plugin.manifest);
        const approved = options.approve as string[];
        const missing = requested.filter((item) => !approved.includes(item));
        if (missing.length) throw new Error(`Explicit approval required: ${missing.join(", ")}`);
        const c = await client();
        const result = await c.plugins.installLocal({
          cwd: resolve(options.cwd ?? process.cwd()), sourcePath, scope: "user",
          approvedPermissions: approved, link,
        });
        console.log(result.message);
      });
  }
  for (const action of ["enable", "disable"] as const) cmd.command(action).argument("<id>").option("--cwd <path>").action(async (id, options) => {
    const c = await client(); const input = { cwd: resolve(options.cwd ?? process.cwd()) };
    console.log((action === "enable" ? await c.plugins.enable(id, input) : await c.plugins.disable(id, input)).message);
  });
  cmd.command("uninstall").argument("<id>").option("--cwd <path>").action(async (id, options) => {
    const c = await client();
    console.log((await c.plugins.uninstall(id, { cwd: resolve(options.cwd ?? process.cwd()) })).message);
  });
  cmd.command("details").argument("<id>").option("--cwd <path>").action(async (id, options) => {
    const c = await client();
    const listed = await c.plugins.list({ cwd: resolve(options.cwd ?? process.cwd()) });
    const plugin = listed.plugins.find((item) => item.identity.id === id);
    if (!plugin) throw new Error(`Plugin not found: ${id}`);
    console.log(JSON.stringify(plugin, null, 2));
  });
  cmd.command("install").argument("<source>").requiredOption("--from <converter>", "source converter: claude-code or codex")
    .option("--cwd <path>").option("--approve <item>", "approve conversion item or permission", collect, [])
    .action(async (source, options) => {
      const temporaryRoot = await mkdtemp(join(tmpdir(), "ohs-plugin-import-"));
      const output = join(temporaryRoot, "native");
      try {
        const { converter } = await createBuiltinConverterRegistry().detect(resolve(source), options.from);
        const inspection = await converter.inspect(resolve(source));
        const plan = await converter.plan(inspection, {});
        await converter.convert({ inspection, plan, output, approvals: options.approve });
        const validation = await validateNativePlugin(output);
        if (!validation.plugin) throw new Error(validation.diagnostics.map((item) => item.message).join("; "));
        const requested = requestedPluginPermissions(validation.plugin.manifest);
        const missing = requested.filter((item) => !(options.approve as string[]).includes(item));
        if (missing.length) throw new Error(`Explicit permission approval required: ${missing.join(", ")}`);
        const c = await client();
        const result = await c.plugins.installLocal({
          cwd: resolve(options.cwd ?? process.cwd()), sourcePath: output, scope: "user",
          approvedPermissions: requested,
        });
        console.log(result.message);
      } finally { await rm(temporaryRoot, { recursive: true, force: true }); }
    });
  cmd.command("convert").argument("<source>")
    .option("--from <converter>", "source converter: claude-code or codex").option("--output <path>").option("--dry-run").option("--json")
    .option("--approve <item>", "approve a conversion change, omitted component, or permission shown in the plan", collect, [])
    .action(async (source, options) => {
      const registry = createBuiltinConverterRegistry();
      const { converter, detection } = await registry.detect(resolve(source), options.from);
      const inspection = await converter.inspect(resolve(source));
      const plan = await converter.plan(inspection, {});
      if (options.dryRun) {
        console.log(options.json ? JSON.stringify({ detection, inspection, plan }, null, 2) : formatConversionPlan(plan));
        return;
      }
      if (!options.output) throw new Error("--output is required unless --dry-run is used");
      const report = await converter.convert({ inspection, plan, output: resolve(options.output), approvals: options.approve });
      console.log(options.json ? JSON.stringify(report, null, 2) : `Converted ${inspection.identity.id}: ${report.status}`);
    });
  return cmd;
}
