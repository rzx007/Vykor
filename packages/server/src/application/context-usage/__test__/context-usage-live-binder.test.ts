import { afterEach, describe, expect, it } from "vitest";

import {
  bindContextUsageLiveAssembler,
  getBoundContextUsageLiveAssembler,
  type ContextUsageLiveAssembler,
} from "../context-usage-live-binder.js";

const releases: Array<() => void> = [];
function bind(assembler: ContextUsageLiveAssembler) {
  const release = bindContextUsageLiveAssembler(assembler);
  releases.push(release);
  return release;
}

afterEach(() => {
  for (const release of releases.splice(0)) {
    if (typeof release === "function") release();
  }
});

describe("context usage live binding ownership", () => {
  it("keeps the newer binding when the older binding is released", () => {
    const releaseA = bind(async () => null);
    const assemblerB: ContextUsageLiveAssembler = async () => null;
    bind(assemblerB);

    expect(releaseA).toBeTypeOf("function");
    releaseA();
    expect(getBoundContextUsageLiveAssembler()).toBe(assemblerB);
  });

  it("gives each binding its own identity even when callbacks are equal", () => {
    const assembler: ContextUsageLiveAssembler = async () => null;
    const releaseA = bind(assembler);
    const releaseB = bind(assembler);

    expect(releaseA).toBeTypeOf("function");
    releaseA();
    expect(getBoundContextUsageLiveAssembler()).toBe(assembler);
    releaseB();
    expect(getBoundContextUsageLiveAssembler()).toBeUndefined();
  });

  it("makes the current assembler unavailable after release", () => {
    const assembler: ContextUsageLiveAssembler = async () => null;
    const release = bind(assembler);
    expect(getBoundContextUsageLiveAssembler()).toBe(assembler);

    expect(release).toBeTypeOf("function");
    release();
    expect(getBoundContextUsageLiveAssembler()).toBeUndefined();
  });

  it("allows repeated release without clearing a later binding", () => {
    const releaseA = bind(async () => null);
    expect(releaseA).toBeTypeOf("function");
    releaseA();
    releaseA();
    expect(getBoundContextUsageLiveAssembler()).toBeUndefined();

    const assemblerB: ContextUsageLiveAssembler = async () => null;
    bind(assemblerB);
    releaseA();
    expect(getBoundContextUsageLiveAssembler()).toBe(assemblerB);
  });
});
