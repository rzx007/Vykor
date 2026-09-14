import { describe, expect, it } from "vitest";

import {
  cloneMutationBuffer,
  createMutationBuffer,
} from "./mutation-buffer.js";

describe("MutationBuffer", () => {
  it("clones every mutation set without sharing state", () => {
    const source = createMutationBuffer();
    source.sessions.add("s1");
    source.deletedInputs.add("i1");

    const copy = cloneMutationBuffer(source);
    copy.sessions.add("s2");
    copy.deletedInputs.add("i2");
    copy.parts.add("part-1");

    expect([...source.sessions]).toEqual(["s1"]);
    expect([...source.deletedInputs]).toEqual(["i1"]);
    expect(source.parts.size).toBe(0);
  });
});
