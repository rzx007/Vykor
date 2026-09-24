import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { createBuiltinConverterRegistry } from "../packages/plugin-converters/src/index.ts";
import {
  installLocalNativePlugin,
  loadNativePlugin,
  readInstalledPluginStore,
  requestedPluginPermissions,
  validateNativePlugin,
} from "../packages/plugins/src/index.ts";
import { discoverVykorExtensions } from "../packages/agent-runtime/src/extensions.ts";

function parseArgs(argv) {
  const inputs = [];
  let cwd = process.cwd();
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--cwd") {
      cwd = resolve(argv[++index]);
    } else {
      inputs.push(resolve(value));
    }
  }
  if (!inputs.length) throw new Error("Usage: node --import tsx scripts/claude-real-plugin-regression.mjs [--cwd <path>] <plugin-dir>...");
  return { cwd, inputs };
}

function countInventory(inventory) {
  return Object.fromEntries(Object.entries(inventory).map(([kind, values]) => [kind, values.length]));
}

function countPlanItems(items) {
  const counts = {};
  for (const item of items) counts[item.fidelity] = (counts[item.fidelity] ?? 0) + 1;
  return counts;
}

const { cwd, inputs } = parseArgs(process.argv.slice(2));
const runRoot = await mkdtemp(join(tmpdir(), "vk-claude-real-regression-"));
process.env.VYKOR_CONFIG_DIR = join(runRoot, "config");
const outputRoot = join(runRoot, "converted");
const cacheDir = join(runRoot, "cache");
const storePath = join(runRoot, "config", "plugins", "installed.json");
const results = [];

try {
  const registry = createBuiltinConverterRegistry();
  for (const sourcePath of inputs) {
    const sample = basename(sourcePath);
    const output = join(outputRoot, sample);
    const record = {
      sample,
      sourcePath,
      output,
      status: "unknown",
    };
    try {
      const detected = await registry.detect(sourcePath, "claude-code");
      const inspection = await detected.converter.inspect(sourcePath);
      const plan = await detected.converter.plan(inspection, {});
      const report = await detected.converter.convert({ inspection, plan, output, approvals: [] });
      const validation = await validateNativePlugin(output);
      if (!validation.plugin) throw new Error(validation.diagnostics.map((item) => item.message).join("; "));
      const loaded = await loadNativePlugin(validation.plugin);
      const requestedPermissions = requestedPluginPermissions(validation.plugin.manifest);
      const installed = await installLocalNativePlugin({
        sourcePath: output,
        scope: "project",
        cwd,
        approvedPermissions: requestedPermissions,
        cacheDir,
        storePath,
      });
      if (installed.status !== "installed") throw new Error(installed.diagnostics.map((item) => item.message).join("; "));
      const discovery = await discoverVykorExtensions(cwd, { model: "regression-model", apiFormat: "anthropic", maxTurns: 1, permission: { mode: "default" } }, { pluginsEnabled: true });
      record.status = "passed";
      record.identity = inspection.identity;
      record.detection = detected.detection;
      record.inventory = countInventory(inspection.inventory);
      record.plan = countPlanItems(plan.items);
      record.reportStatus = report.status;
      record.native = {
        id: validation.plugin.manifest.id,
        version: validation.plugin.manifest.version,
        components: Object.fromEntries(Object.entries(validation.plugin.manifest.components).map(([kind, values]) => [kind, values.length])),
        diagnostics: [...validation.diagnostics, ...loaded.diagnostics].map(({ severity, phase, code, message }) => ({ severity, phase, code, message })),
      };
      record.installed = {
        key: Object.keys((await readInstalledPluginStore(storePath)).plugins).find((key) => key.endsWith(`:${validation.plugin.manifest.id}`)),
        requestedPermissions,
      };
      record.discovery = {
        pluginCount: discovery.plugins.length,
        pluginIds: discovery.plugins.map((plugin) => plugin.manifest.id).sort(),
        warnings: discovery.warnings,
      };
    } catch (error) {
      record.status = "failed";
      record.error = error instanceof Error ? error.message : String(error);
    }
    results.push(record);
  }
  const failed = results.filter((result) => result.status !== "passed");
  console.log(JSON.stringify({ runRoot, cwd, results }, null, 2));
  if (failed.length) process.exitCode = 1;
} finally {
  if (!process.env.VYKOR_KEEP_REAL_PLUGIN_REGRESSION) await rm(runRoot, { recursive: true, force: true });
}
