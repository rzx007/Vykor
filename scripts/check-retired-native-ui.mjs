import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { referenceScanSource } from "./reference-inventory.mjs";

// Entries approve one exact line, never an entire historical directory.
export const legacyPattern = /VykorPluginUi|createPluginUiClient|plugin-ui|pluginUi|PluginUi|components\.ui|metadata\.ui\b|ui-sdk|ui-styles|RunPluginUiBinding|loadNativeUiMetadata|\buiAction\b|uiInventory|plugin_ui_|NativeUi|native-ui|PLUGIN_UI/;
export function verifyReferences(files, entries) {
  const approved = new Set(entries.map(entry => JSON.stringify([entry.path, entry.line, entry.text])));
  const seen = new Set();
  const errors = [];
  for (const { path, source } of files) {
    source.split(/\r?\n/).forEach((text, index) => {
      if (!legacyPattern.test(text)) return;
      const key = JSON.stringify([path, index + 1, text]);
      seen.add(key);
      if (!approved.has(key)) errors.push(`Unreviewed legacy reference: ${path}:${index + 1}`);
    });
  }
  for (const entry of entries) {
    if (!entry.reason?.trim()) errors.push(`Missing reason: ${entry.path}:${entry.line}`);
    if (!seen.has(JSON.stringify([entry.path, entry.line, entry.text]))) errors.push(`Stale approval: ${entry.path}:${entry.line}`);
  }
  return errors;
}

export function checkRetirement(root) {
  const manifestPath = "scripts/retired-native-ui-allowlist.json";
  const manifest = JSON.parse(readFileSync(resolve(root, manifestPath), "utf8"));
  const paths = [...new Set(execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8" }).trim().split(/\r?\n/))];
  const extensions = new Set([".ts", ".tsx", ".mjs", ".json", ".md", ".html", ".css", ".yaml", ".yml"]);
  const files = paths.filter(path => path !== manifestPath && extensions.has(extname(path)) && existsSync(resolve(root, path)))
    .map(path => ({ path, source: referenceScanSource(path, readFileSync(resolve(root, path), "utf8")) }));
  const errors = verifyReferences(files, manifest.entries);
  const pureImports = {
    "packages/protocol/src/plugin-ui-history.ts": ["@vykor/domain-contracts/plugin-apps/history", "./json.js", "./requests.js", "./domain-validation.js"],
    "packages/domain-contracts/src/plugin-apps/history.ts": ["@vykor/json-data/json", "../validation-error.js"],
    "packages/server/src/application/session/plugin-ui-history-service.ts": ["node:crypto", "@vykor/domain-contracts/sessions", "@vykor/domain-contracts/plugin-apps/history", "@vykor/json-data/json", "@vykor/services", "../../shared/application-error.js"],
    "packages/client/src/resources/plugin-ui-history-resource.ts": ["@vykor/protocol", "../transport/http-transport.js"],
  };
  for (const [path, allowed] of Object.entries(pureImports)) {
    const source = readFileSync(resolve(root, path), "utf8");
    for (const match of source.matchAll(/\b(?:from\s*|import\s*\(?\s*|require\s*\(\s*)["']([^"']+)["']/g)) {
      if (!allowed.includes(match[1])) errors.push(`Non-history dependency: ${path} -> ${match[1]}`);
    }
  }
  for (const path of manifest.removedPaths) if (existsSync(resolve(root, path))) errors.push(`Retired implementation exists: ${path}`);
  const exports = JSON.parse(readFileSync(resolve(root, "packages/plugins/package.json"), "utf8")).exports;
  if (Object.keys(exports).some(key => /ui-sdk|ui-styles/.test(key))) errors.push("Retired SDK remains exported");
  for (const path of ["packages/plugins/dist", "tests/browser-plugin-ui-sdk/dist"]) {
    const directory = resolve(root, path);
    if (!existsSync(directory)) continue;
    for (const name of readdirSync(directory, { recursive: true })) {
      if (/ui-sdk|ui-styles/.test(name) || path.startsWith("tests/") && /\.(?:js|html)$/.test(name)) errors.push(`Retired generated artifact: ${path}/${name}`);
    }
  }
  return { errors, files: files.length, references: manifest.entries.length, removed: manifest.removedPaths.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = checkRetirement(fileURLToPath(new URL("..", import.meta.url)));
  for (const error of result.errors) console.error(error);
  console.log(JSON.stringify(result));
  process.exitCode = result.errors.length ? 1 : 0;
}
