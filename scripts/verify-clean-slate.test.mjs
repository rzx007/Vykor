import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { verifyCleanSlate } from "./verify-clean-slate.mjs";

function write(root, path, content) {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, "utf8");
}

test("aggregates every clean-slate violation with category, file and line", async () => {
  const root = mkdtempSync(join(tmpdir(), "verify-clean-slate-"));
  try {
    write(root, "scripts/forbidden-compatibility-surfaces.json", JSON.stringify({
      version: 1,
      clientMethods: ["oldMethod"], runtimeExports: [], httpRoutes: [], cliCommands: [],
      cliOptions: ["--bare"], environmentVariables: [], configFields: ["compatibility"],
      enumValues: [], schemaNames: ["legacyShellDescriptor"],
    }));
    write(root, "packages/client/src/bad.ts", "client.oldMethod();\nconst option = '--bare';\n");
    write(root, "docs/current.md", "Use `client.oldMethod()` here.\n");
    write(root, "package.json", JSON.stringify({ scripts: { old: "tool --bare" } }));
    write(root, "packages/skills/src/bad.ts", "const location = '.claude/skills';\n");
    write(root, "packages/plugins/src/bad.ts", "const manifest = { compatibility: true };\n");
    write(root, "packages/environment/src/bad.ts", "const legacyShellDescriptor = {};\n");
    write(root, "packages/services/src/session-runtime/migrations/0000_current_schema.sql", "select 1;\n");
    write(root, "packages/services/src/session-runtime/migrations/0001_old.sql", "select 2;\n");
    write(root, "packages/services/src/session-runtime/migrations/meta/_journal.json", JSON.stringify({ entries: [] }));
    write(root, "packages/protocol/src/capabilities.ts", "export const CURRENT_PROTOCOL_VERSION = 3;\nexport const PROTOCOL_VERSION_HEADER = 'wrong';\n");
    write(root, "packages/client/src/transport/http-transport.ts", "const nope = true;\n");
    write(root, "packages/server/src/http/protocol-middleware.ts", "const nope = true;\n");
    write(root, ".github/workflows/tag-release.yml", "jobs:\n  publish-release:\n  create-tag:\n");
    write(root, "apps/cli/build.ts", "// no migration copy\n");
    write(root, "apps/desktop/electron.vite.config.ts", "// no migration copy\n");
    write(root, "scripts/client-public-api-contract.json", JSON.stringify({ version: 1, entries: [] }));
    write(root, "packages/client/src/transport/http-client.ts", "export class OpenHarnessClient { readonly sessions: unknown; }\n");

    const problems = await verifyCleanSlate({ root, forceFallbackScanner: true, requireBuildArtifacts: true });
    const output = problems.map((problem) => `${problem.category} ${problem.file}:${problem.line} ${problem.message}`).join("\n");
    for (const expected of [
      "forbidden", "contract", "migration", "protocol", "workflow", "bundle-inventory",
      "oldMethod", "--bare", ".claude/skills", "compatibility", "legacyShellDescriptor", "0001_old.sql",
      "docs/current.md", "package.json",
    ]) assert.match(output, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
    assert.ok(problems.length >= 12, output);
    assert.ok(problems.every((problem) => problem.file && Number.isInteger(problem.line)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reports missing bundle outputs as skipped normally and failures in strict mode", async () => {
  const root = mkdtempSync(join(tmpdir(), "verify-clean-slate-bundles-"));
  try {
    write(root, "apps/cli/build.ts", "cpSync('session-runtime/migrations', 'dist/migrations');\n");
    write(root, "apps/desktop/electron.vite.config.ts", "// copy-session-migrations session-runtime/migrations\n");
    const ordinary = await verifyCleanSlate({ root });
    assert.ok(ordinary.skipped.some((item) => item.file === "apps/cli/dist/migrations"));
    assert.ok(ordinary.skipped.some((item) => item.file === "apps/desktop/out/session-runtime/migrations"));
    assert.ok(!ordinary.some((item) => item.message.includes("built migration directory")));

    const strict = await verifyCleanSlate({ root, requireBuildArtifacts: true });
    assert.ok(strict.some((item) => item.file === "apps/cli/dist/migrations"));
    assert.ok(strict.some((item) => item.file === "apps/desktop/out/session-runtime/migrations"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
