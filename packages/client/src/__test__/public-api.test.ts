import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import ts from "typescript";
import * as clientModule from "../index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../../../");
const contractPath = resolve(repoRoot, "scripts/client-public-api-contract.json");
const contract = JSON.parse(readFileSync(contractPath, "utf8"));
const entries = contract.entries;
const resourceNames = [
  "attachments", "auth", "channels", "development", "events", "jobs", "mcp",
  "permissions", "plugins", "projects", "protocol", "providers", "schedules",
  "sessions", "system", "terminals",
].sort();

describe("Public API Contract Verification", () => {
  it("contains only current export and Resource entries", () => {
    expect(existsSync(resolve(repoRoot, "scripts/client-public-api-contract.schema.json"))).toBe(true);
    expect(new Set(entries.map((entry: { kind: string; name: string }) => `${entry.kind}:${entry.name}`)).size).toBe(entries.length);
    expect(new Set(entries.map((entry: { kind: string }) => entry.kind))).toEqual(
      new Set(["runtime-export", "type-export", "client-resource"]),
    );
    for (const entry of entries) expect(Object.keys(entry).sort()).toEqual(["kind", "name"]);
    expect(entries.filter((entry: { kind: string }) => entry.kind === "client-resource").map((entry: { name: string }) => entry.name).sort()).toEqual(resourceNames);
  });

  it("matches all runtime exports against contract json", () => {
    const expected = entries.filter((entry: { kind: string }) => entry.kind === "runtime-export").map((entry: { name: string }) => entry.name).sort();
    expect(Object.keys(clientModule).sort()).toEqual(expected);
  });

  it("exposes only current Resources directly on OpenHarnessClient", () => {
    const client = new clientModule.OpenHarnessClient({
      baseUrl: "http://127.0.0.1:4000",
      fetch: async () => new Response(),
    });
    expect(Object.keys(client).sort()).toEqual(resourceNames);
    expect(Object.getOwnPropertyNames(clientModule.OpenHarnessClient.prototype)).toEqual(["constructor"]);
  });

  it("uses TypeChecker to verify module exports match contract", () => {
    const clientTsconfig = resolve(repoRoot, "packages/client/tsconfig.json");
    const configFile = ts.readConfigFile(clientTsconfig, ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, dirname(clientTsconfig));
    const program = ts.createProgram(parsed.fileNames, parsed.options);
    const checker = program.getTypeChecker();
    const sourceFile = program.getSourceFile(resolve(repoRoot, "packages/client/src/index.ts"));
    expect(sourceFile).toBeDefined();
    const moduleSymbol = checker.getSymbolAtLocation(sourceFile!);
    expect(moduleSymbol).toBeDefined();

    const actualRuntimeNames = new Set<string>();
    const actualTypeNames = new Set<string>();
    for (const exported of checker.getExportsOfModule(moduleSymbol!)) {
      const symbol = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
      ((symbol.flags & ts.SymbolFlags.Value) !== 0 ? actualRuntimeNames : actualTypeNames).add(exported.name);
    }
    const expectedRuntimeNames = entries.filter((entry: { kind: string }) => entry.kind === "runtime-export").map((entry: { name: string }) => entry.name).sort();
    const expectedTypeNames = entries.filter((entry: { kind: string }) => entry.kind === "type-export").map((entry: { name: string }) => entry.name).sort();
    expect([...actualRuntimeNames].sort()).toEqual(expectedRuntimeNames);
    expect([...actualTypeNames].sort()).toEqual(expectedTypeNames);
  });
});
