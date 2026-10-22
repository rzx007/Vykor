import { describe, expect, it } from "vitest";

import { createCompactContextProvider } from "./compact-context.js";

const supplementalSections = [{
  heading: "Business Context",
  content: "- ticket: OPS-42",
}];

describe("createCompactContextProvider", () => {
  it("combines supplemental sections and session memory", async () => {
    const provider = createCompactContextProvider({
      supplementalSections: async () => supplementalSections,
      sessionMemory: async () => "goal: finish phase two",
    });

    await expect(provider()).resolves.toEqual({
      supplementalSections,
      sessionMemory: "goal: finish phase two",
    });
  });

  it("omits each source when it is not configured", async () => {
    const supplementalOnly = createCompactContextProvider({
      supplementalSections: () => supplementalSections,
    });
    const memoryOnly = createCompactContextProvider({
      sessionMemory: () => "goal: finish phase two",
    });

    await expect(supplementalOnly()).resolves.toEqual({ supplementalSections });
    await expect(memoryOnly()).resolves.toEqual({
      sessionMemory: "goal: finish phase two",
    });
  });

  it("omits sources that return an empty value", async () => {
    const emptyMemory = createCompactContextProvider({
      supplementalSections: () => undefined,
      sessionMemory: () => "",
    });

    await expect(emptyMemory()).resolves.toEqual({});
  });

  it("rejects with the original source error", async () => {
    const sourceError = new Error("session memory unavailable");
    const provider = createCompactContextProvider({
      sessionMemory: async () => {
        throw sourceError;
      },
    });

    await expect(provider()).rejects.toBe(sourceError);
  });
});
