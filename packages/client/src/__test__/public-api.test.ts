import { readFileSync } from "node:fs";
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

describe("Public API Contract Verification", () => {
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
