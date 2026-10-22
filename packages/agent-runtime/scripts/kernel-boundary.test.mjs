import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyKernelDeclarations, verifyKernelInputs } from "./kernel-boundary.mjs";

test("Kernel metafile rejects host modules, including transitive imports", () => {
  assert.throws(() => verifyKernelInputs({ inputs: { "../host-config/src/index.ts": {} } }), /host/);
  assert.doesNotThrow(() => verifyKernelInputs({ inputs: { "../core/src/engine/index.ts": {} } }));
});

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
