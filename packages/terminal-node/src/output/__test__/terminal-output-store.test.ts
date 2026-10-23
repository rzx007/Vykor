import { describe, expect, it } from "vitest";

import { TerminalOutputStore } from "../terminal-output-store";

describe("TerminalOutputStore", () => {
  it("reads only output after a sequence cursor", () => {
    const store = new TerminalOutputStore();
    store.append("terminal-1", "first");
    store.append("terminal-1", "second");

    expect(store.read("terminal-1", { after: 1 })).toEqual({
      terminalId: "terminal-1",
      data: "second",
      sequence: 2,
      truncated: false,
    });
  });

  it("reports truncation when retained output no longer covers the cursor", () => {
    const store = new TerminalOutputStore(6);
    store.append("terminal-1", "abcd");
    store.append("terminal-1", "efgh");

    expect(store.read("terminal-1", { after: 0 })).toMatchObject({
      data: "cdefgh",
      sequence: 2,
      truncated: true,
    });
    expect(store.read("terminal-1", { after: 1 })).toMatchObject({
      data: "efgh",
      truncated: false,
    });
  });

  it("applies a per-read output limit without changing retained output", () => {
    const store = new TerminalOutputStore();
    store.append("terminal-1", "123456");

    expect(store.read("terminal-1", { maxChars: 3 })).toMatchObject({ data: "456", truncated: true });
    expect(store.read("terminal-1")).toMatchObject({ data: "123456", truncated: false });
  });
});
