import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import ts from "typescript";
import * as clientModule from "../index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../../../");
const contractPath = resolve(repoRoot, "scripts/client-public-api-contract.json");
const contractData = JSON.parse(readFileSync(contractPath, "utf8"));
const contractEntries = Array.isArray(contractData) ? contractData : contractData.entries;
const allowedClassifications = new Set([
  "long-term",
  "advanced",
  "compatibility",
  "retained-unclassified",
]);

function expectReleaseEvidence(value: unknown): void {
  if (value === null || value === "pending") return;
  expect(value).toEqual(expect.objectContaining({
    carrier: expect.any(String),
    version: expect.any(String),
    date: expect.any(String),
    channel: expect.any(String),
  }));
  const evidence = value as { releaseNoteUrl?: string; commit?: string };
  expect(Boolean(evidence.releaseNoteUrl || evidence.commit)).toBe(true);
}

describe("Public API Contract Verification", () => {
  it("validates classifications, compatibility metadata, release evidence and summary", () => {
    expect(existsSync(resolve(repoRoot, "scripts/client-public-api-contract.schema.json"))).toBe(true);
    expect(new Set(contractEntries.map((entry) => `${entry.kind}:${entry.name}`)).size).toBe(
      contractEntries.length,
    );
    for (const entry of contractEntries) {
      expect(allowedClassifications.has(entry.classification)).toBe(true);
      if (entry.classification === "compatibility") {
        expect(entry.kind).toBe("client-method");
        expect(entry.replacement).toMatch(/^[a-z][A-Za-z]+\.[a-z][A-Za-z]+$/);
        expect(entry.deprecatedSince).toBe("stage-7");
        expect(entry.removeIn).toBe("stage-8-after-release-gate");
        expectReleaseEvidence(entry.deprecatedCarrierRelease);
        expectReleaseEvidence(entry.retentionCarrierRelease);
      }
    }
    expect(contractData.summary).toEqual({
      runtimeExports: contractEntries.filter((entry) => entry.kind === "runtime-export").length,
      typeExports: contractEntries.filter((entry) => entry.kind === "type-export").length,
      clientMembers: contractEntries.filter((entry) => entry.kind.startsWith("client-")).length,
      totalEntries: contractEntries.length,
    });
    expect(contractData.carrier).toEqual(expect.objectContaining({
      defaultCarrier: "@rzx/ohs",
      evidenceFields: ["carrier", "version", "date", "channel", "releaseNoteUrl|commit"],
      commitRule: expect.stringContaining("commit"),
    }));
  });

  it("keeps facade forwarding, deprecation docs and migration table aligned with the contract", () => {
    const sourcePath = resolve(repoRoot, "packages/client/src/transport/http-client.ts");
    const sourceText = readFileSync(sourcePath, "utf8");
    const sourceFile = ts.createSourceFile(sourcePath, sourceText, ts.ScriptTarget.Latest, true);
    const clientClass = sourceFile.statements.find(
      (statement): statement is ts.ClassDeclaration =>
        ts.isClassDeclaration(statement) && statement.name?.text === "OpenHarnessClient",
    );
    expect(clientClass).toBeDefined();
    const methods = new Map(
      clientClass!.members
        .filter((member): member is ts.MethodDeclaration =>
          ts.isMethodDeclaration(member) && ts.isIdentifier(member.name),
        )
        .map((method) => [(method.name as ts.Identifier).text, method]),
    );
    const compatibilityEntries = contractEntries.filter(
      (entry) => entry.kind === "client-method" && entry.classification === "compatibility",
    );
    for (const entry of compatibilityEntries) {
      const method = methods.get(entry.name);
      expect(method, `missing facade method ${entry.name}`).toBeDefined();
      expect(method!.getFullText(sourceFile)).toContain(
        `@deprecated Use client.${entry.replacement}() instead.`,
      );
      expect(method!.body?.getText(sourceFile)).toContain(`this.${entry.replacement}(`);
    }

    const migration = readFileSync(resolve(repoRoot, "docs/client-public-api-migration.md"), "utf8");
    const rows = new Map(
      [...migration.matchAll(/^\| `client\.([A-Za-z0-9_]+)\(\)` \| `client\.([A-Za-z0-9_.]+)\(\)` \| ([^|]+) \|/gm)]
        .map((match) => [match[1], { replacement: match[2], parameterDifference: match[3].trim() }]),
    );
    expect(rows.size).toBe(compatibilityEntries.length);
    for (const entry of compatibilityEntries) {
      expect(rows.get(entry.name)).toEqual({ replacement: entry.replacement, parameterDifference: "无" });
    }
  });
  it("matches all runtime exports against contract json", () => {
    const runtimeExportEntries = contractEntries
      .filter((e) => e.kind === "runtime-export")
      .map((e) => e.name)
      .sort();

    const actualRuntimeExports = Object.keys(clientModule).sort();

    expect(actualRuntimeExports).toEqual(runtimeExportEntries);
  });

  it("matches all OpenHarnessClient prototype members against contract json", () => {
    const proto = clientModule.OpenHarnessClient.prototype;
    const protoDescs = Object.getOwnPropertyDescriptors(proto);

    const contractMethods = contractEntries
      .filter((e) => e.kind === "client-method")
      .map((e) => e.name)
      .sort();

    const contractGetters = contractEntries
      .filter((e) => e.kind === "client-getter")
      .map((e) => e.name)
      .sort();

    const actualMethods = Object.entries(protoDescs)
      .filter(([name, desc]) => name !== "constructor" && typeof desc.value === "function")
      .map(([name]) => name)
      .sort();

    const actualGetters = Object.entries(protoDescs)
      .filter(([_, desc]) => typeof desc.get === "function")
      .map(([name]) => name)
      .sort();

    expect(actualMethods).toEqual(contractMethods);
    expect(actualGetters).toEqual(contractGetters);
  });

  it("matches all OpenHarnessClient instance properties against contract json", () => {
    const dummyFetch = async () => new Response();
    const client = new clientModule.OpenHarnessClient({
      baseUrl: "http://127.0.0.1:4000",
      fetchImpl: dummyFetch as any,
    });

    const contractProperties = contractEntries
      .filter((e) => e.kind === "client-property")
      .map((e) => e.name)
      .sort();

    const actualProperties = Object.keys(client).sort();

    expect(actualProperties).toEqual(contractProperties);
  });

  it("uses TypeChecker to verify all module exports and classifications match contract", () => {
    const clientTsconfig = resolve(repoRoot, "packages/client/tsconfig.json");
    const configFile = ts.readConfigFile(clientTsconfig, ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(
      configFile.config,
      ts.sys,
      dirname(clientTsconfig),
    );
    const program = ts.createProgram(parsed.fileNames, parsed.options);
    const checker = program.getTypeChecker();

    const indexPath = resolve(repoRoot, "packages/client/src/index.ts");
    const sourceFile = program.getSourceFile(indexPath);
    expect(sourceFile).toBeDefined();

    const moduleSymbol = checker.getSymbolAtLocation(sourceFile!);
    expect(moduleSymbol).toBeDefined();

    const exports = checker.getExportsOfModule(moduleSymbol!);

    const contractRuntimeNames = new Set(
      contractEntries.filter((e) => e.kind === "runtime-export").map((e) => e.name),
    );
    const contractTypeNames = new Set(
      contractEntries.filter((e) => e.kind === "type-export").map((e) => e.name),
    );

    const actualRuntimeNames = new Set<string>();
    const actualTypeNames = new Set<string>();

    for (const exp of exports) {
      let sym = exp;
      if (sym.flags & ts.SymbolFlags.Alias) {
        sym = checker.getAliasedSymbol(sym);
      }
      const isValue = (sym.flags & ts.SymbolFlags.Value) !== 0;
      if (isValue) {
        actualRuntimeNames.add(exp.name);
      } else {
        actualTypeNames.add(exp.name);
      }
    }

    expect([...actualRuntimeNames].sort()).toEqual([...contractRuntimeNames].sort());
    expect([...actualTypeNames].sort()).toEqual([...contractTypeNames].sort());
  });
});
