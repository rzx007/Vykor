import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyKernelDeclarations, verifyKernelInputs } from "../kernel-boundary.mjs";

test("Kernel metafile rejects host modules, including transitive imports", () => {
  assert.throws(() => verifyKernelInputs({ inputs: { "../host-config/src/index.ts": {} } }), /host/);
  assert.doesNotThrow(() => verifyKernelInputs({ inputs: { "../core/src/engine/index.ts": {} } }));
});

for (const name of ["domain-contracts", "plugin-contracts", "json-data"]) {
  test(`Kernel metafile rejects ${name} source modules`, () => {
    for (const path of [`../${name}/src/index.ts`, `node_modules/@vykor/${name}/src/index.ts`, `..\\${name}\\src\\index.ts`]) {
      assert.throws(() => verifyKernelInputs({ inputs: { [path]: {} } }), /Kernel bundle reaches Node host modules/);
    }
  });

  test(`Kernel declarations reject ${name} package and relative paths`, async () => {
    const root = mkdtempSync(join(tmpdir(), "vykor-kernel-data-boundary-"));
    const write = (file, source) => { mkdirSync(join(root, file, ".."), { recursive: true }); writeFileSync(join(root, file), source); };
    try {
      write("dist/kernel-entry.d.ts", 'export * from "./kernel/nested.js";');
      write(`node_modules/@vykor/${name}/package.json`, JSON.stringify({ name: `@vykor/${name}`, exports: { "./data": { types: "./src/data.d.ts" } } }));
      write(`node_modules/@vykor/${name}/src/data.d.ts`, "export interface Data { value: string }");
      write(`packages/${name}/src/data.d.ts`, "export interface Data { value: string }");
      for (const source of [
        `export type Data = import("@vykor/${name}/data").Data;`,
        `export type { Data } from "../../node_modules/@vykor/${name}/src/data.js";`,
        `export type { Data } from "../../packages/${name}/src/data.js";`,
        `/// <reference path="../../packages/${name}/src/data.d.ts" />\nexport interface Data {}`,
      ]) {
        write("dist/kernel/nested.d.ts", source);
        await assert.rejects(verifyKernelDeclarations(root), error => {
          assert.match(error.message, /Kernel declaration reaches a host (?:dependency|path)/);
          assert.ok(error.message.includes(name));
          return true;
        });
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test("Kernel declarations follow relative barrels and package exports", async () => {
  const root = mkdtempSync(join(tmpdir(), "vykor-kernel-boundary-"));
  const write = (file, source) => { mkdirSync(join(root, file, ".."), { recursive: true }); writeFileSync(join(root,file),source); };
  try {
    write("dist/kernel-entry.d.ts", 'export * from "./kernel/nested.js";');
    write("dist/kernel/nested.d.ts", 'export type { Contract } from "@vykor/agent-contracts";');
    write("node_modules/@vykor/agent-contracts/package.json", JSON.stringify({name:"@vykor/agent-contracts",exports:{".":{types:"./index.d.ts"}}}));
    write("node_modules/@vykor/agent-contracts/index.d.ts", "export interface Contract { value: string }");
    await verifyKernelDeclarations(root);
    write("node_modules/@vykor/agent-contracts/index.d.ts", 'export type Contract = import("@vykor/host-config").HostValue;');
    await assert.rejects(verifyKernelDeclarations(root), /host-config/);
    write("node_modules/@vykor/agent-contracts/index.d.ts", 'export interface Contract { timer: NodeJS.Timeout }');
    await assert.rejects(verifyKernelDeclarations(root), /Node-specific/);
    write("node_modules/@vykor/agent-contracts/index.d.ts", 'export type Contract = import("./missing.js").Missing;');
    await assert.rejects(verifyKernelDeclarations(root), /resolve/);
    write("node_modules/@vykor/agent-contracts/index.d.ts", 'import host = require("@vykor/host-config"); export type Contract = host.HostValue;');
    await assert.rejects(verifyKernelDeclarations(root), /host-config/);
    write("node_modules/@vykor/agent-contracts/index.d.ts", '/// <reference types="node" />\nexport interface Contract {}');
    await assert.rejects(verifyKernelDeclarations(root), /type reference/);
    write("node_modules/@vykor/agent-contracts/index.d.ts", '/// <reference path="./hidden.d.ts" />\nexport interface Contract {}');
    write("node_modules/@vykor/agent-contracts/hidden.d.ts", 'export type Hidden = import("@vykor/host-config").HostValue;');
    await assert.rejects(verifyKernelDeclarations(root), /host-config/);
  } finally { rmSync(root,{recursive:true,force:true}); }
});
