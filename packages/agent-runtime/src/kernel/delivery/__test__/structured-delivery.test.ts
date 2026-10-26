import { describe, expect, it } from "vitest";
import type { AgentOutputContract } from "@vykor/agent-contracts";
import { createStructuredDelivery } from "../structured-delivery.js";

const schema = { type: "object", properties: { path: { type: "string", minLength: 1 } }, required: ["path"], additionalProperties: false };
const candidate = { status: "done", summary: "Created report", data: { path: "report.md" } };
function fixture(contract: AgentOutputContract = { schema }) {
  const controller = createStructuredDelivery(contract);
  const tool = controller.contribution.tools![0]!.definition;
  return { controller, tool, submit: (input: Record<string, unknown>) => tool.execute(input, { cwd: "/work" }) };
}

describe("structured delivery", () => {
  it("accepts valid structure without pretending that business verification happened", async () => {
    const f = fixture();
    expect((await f.submit(candidate)).isError).not.toBe(true);
    expect(f.controller.requireReceipt()).toEqual({ ...candidate, validation: "schema_valid", verification: "not_requested" });
  });
  it("rejects missing fields and accepts a corrected submission", async () => {
    const f = fixture();
    const invalid = await f.submit({ ...candidate, data: {} });
    expect(invalid).toMatchObject({ isError: true, executionState: "not_started", failureKind: "invalid_input" });
    expect(f.controller.getReceipt()).toBeUndefined();
    expect((await f.submit(candidate)).isError).not.toBe(true);
    expect(f.controller.requireReceipt().data).toEqual({ path: "report.md" });
  });
  it("does not accept a structurally valid delivery rejected by the host verifier", async () => {
    const f = fixture({ schema, verify: delivery => ({ ok: (delivery.data as { path: string }).path === "verified.md", reason: "Output file is missing" }) });
    expect(await f.submit(candidate)).toMatchObject({ isError: true, executionState: "not_started" });
    expect(() => f.controller.requireReceipt()).toThrow(/delivery/i);
    await f.submit({ ...candidate, data: { path: "verified.md" } });
    expect(f.controller.requireReceipt().verification).toBe("passed");
  });
  it("freezes the submitted value and does not expose a mutable accepted receipt", async () => {
    const f = fixture();
    const input = structuredClone(candidate);
    await f.submit(input);
    input.data.path = "changed.md";
    const copy = f.controller.requireReceipt();
    (copy.data as { path: string }).path = "also-changed.md";
    expect(f.controller.requireReceipt().data).toEqual({ path: "report.md" });
  });
  it("rejects unsupported schema constraints before a Run can claim validation", () => {
    expect(() => fixture({ schema: { type: "string", pattern: "^ok$" } })).toThrow(/schema|constraint/i);
    expect(() => fixture({ schema: { $ref: "https://unavailable.example/schema" } })).toThrow(/schema|constraint/i);
  });
  it("does not replace the first accepted delivery with a second value", async () => {
    const f = fixture();
    await f.submit(candidate);
    expect(await f.submit({ ...candidate, data: { path: "other.md" } })).toMatchObject({ isError: true });
    expect(f.controller.requireReceipt().data).toEqual({ path: "report.md" });
  });
  it("rejects non-JSON values rather than dropping them during serialization", async () => {
    const f = fixture({ schema: { type: "object" } });
    expect(await f.submit({ ...candidate, data: { value: () => true } })).toMatchObject({ isError: true });
    expect(f.controller.getReceipt()).toBeUndefined();
  });
  it.each(["extra", "01", "-1"])("rejects a sparse array whose missing index is masked by property %s", async key => {
    const f = fixture({ schema: { type: "array", items: { type: "string" } } });
    const data = Object.assign(new Array<string>(1), { [key]: "silently lost" });
    expect(await f.submit({ ...candidate, data })).toMatchObject({
      isError: true, executionState: "not_started", failureKind: "invalid_input",
    });
    expect(f.controller.getReceipt()).toBeUndefined();
    expect((await f.submit({ ...candidate, data: ["kept"] })).isError).not.toBe(true);
    expect(f.controller.requireReceipt().data).toEqual(["kept"]);
  });
  it("rejects extra properties on a dense array", async () => {
    const f = fixture({ schema: { type: "array", items: { type: "string" } } });
    const data = Object.assign(["kept"], { extra: "silently lost" });
    expect(await f.submit({ ...candidate, data })).toMatchObject({ isError: true });
    expect(f.controller.getReceipt()).toBeUndefined();
  });
  it("does not admit a second submission while verification is still pending", async () => {
    let finish!: () => void;
    const waiting = new Promise<void>(resolve => { finish = resolve; });
    const f = fixture({ schema, verify: async () => { await waiting; return { ok: true }; } });
    const first = f.submit(candidate);
    expect(await f.submit({ ...candidate, data: { path: "other.md" } })).toMatchObject({ isError: true });
    finish(); await first;
    expect(f.controller.requireReceipt().data).toEqual({ path: "report.md" });
  });
});
