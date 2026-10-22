import { describe, expect, it } from "vitest";

import {
  CleanupStack,
  cleanupAfterInitializationFailure,
} from "./cleanup-stack.js";

describe("CleanupStack", () => {
  it("runs unique cleanups once in reverse registration order", async () => {
    const calls: string[] = [];
    const sharedIdentity = {};
    const stack = new CleanupStack();

    stack.add(() => {
      calls.push("first");
    });
    stack.add(() => {
      calls.push("shared");
    }, sharedIdentity);
    stack.add(() => {
      calls.push("duplicate");
    }, sharedIdentity);

    await stack.close();

    expect(calls).toEqual(["shared", "first"]);
  });

  it("returns one close promise and does not run cleanup again", async () => {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const stack = new CleanupStack();
    stack.add(async () => {
      calls += 1;
      await waiting;
    });

    const first = stack.close();
    const concurrent = stack.close();
    expect(concurrent).toBe(first);

    let settled = false;
    void first.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toBe(1);
    expect(settled).toBe(false);

    release();
    await first;

    expect(stack.close()).toBe(first);
    expect(calls).toBe(1);
  });

  it("rejects cleanup registration after close starts", async () => {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stack = new CleanupStack();
    stack.add(() => waiting);

    const closing = stack.close();

    expect(() => stack.add(() => {})).toThrow(
      "Cannot add cleanup after closing has started.",
    );
    release();
    await closing;
  });

  it("throws one cleanup failure unchanged", async () => {
    const failure = new Error("cleanup failed");
    const stack = new CleanupStack();
    stack.add(() => {
      throw failure;
    });

    await expect(stack.close()).rejects.toBe(failure);
  });

  it("preserves a user AggregateError thrown by one cleanup", async () => {
    const failure = new AggregateError([], "user cleanup failed", {
      cause: new Error("user cause"),
    });
    const stack = new CleanupStack();
    stack.add(() => {
      throw failure;
    });

    await expect(stack.close()).rejects.toBe(failure);
  });

  it("runs every cleanup and aggregates multiple failures in execution order", async () => {
    const firstFailure = new Error("first failed");
    const lastFailure = new Error("last failed");
    const calls: string[] = [];
    const stack = new CleanupStack();
    stack.add(() => {
      calls.push("first");
      throw firstFailure;
    });
    stack.add(async () => {
      calls.push("middle");
    });
    stack.add(() => {
      calls.push("last");
      throw lastFailure;
    });

    const failure = await stack.close().catch((error: unknown) => error);

    expect(calls).toEqual(["last", "middle", "first"]);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([
      lastFailure,
      firstFailure,
    ]);
  });
});

describe("cleanupAfterInitializationFailure", () => {
  it("throws the initialization failure unchanged when cleanup succeeds", async () => {
    const initializationFailure = new Error("initialization failed");
    const stack = new CleanupStack();
    stack.add(() => {});

    await expect(cleanupAfterInitializationFailure(
      stack,
      initializationFailure,
    )).rejects.toBe(initializationFailure);
  });

  it("combines the initialization failure with one cleanup failure", async () => {
    const initializationFailure = new Error("initialization failed");
    const cleanupFailure = new Error("cleanup failed");
    const stack = new CleanupStack();
    stack.add(() => {
      throw cleanupFailure;
    });

    const failure = await cleanupAfterInitializationFailure(
      stack,
      initializationFailure,
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([
      initializationFailure,
      cleanupFailure,
    ]);
  });

  it("keeps one user AggregateError as one cleanup failure", async () => {
    const initializationFailure = new Error("initialization failed");
    const userAggregate = new AggregateError([], "user cleanup failed", {
      cause: new Error("user cause"),
    });
    const stack = new CleanupStack();
    stack.add(() => {
      throw userAggregate;
    });

    const failure = await cleanupAfterInitializationFailure(
      stack,
      initializationFailure,
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([
      initializationFailure,
      userAggregate,
    ]);
  });

  it("puts the initialization failure before every cleanup failure", async () => {
    const initializationFailure = new Error("initialization failed");
    const firstCleanupFailure = new Error("first cleanup failed");
    const lastCleanupFailure = new Error("last cleanup failed");
    const stack = new CleanupStack();
    stack.add(() => {
      throw firstCleanupFailure;
    });
    stack.add(() => {
      throw lastCleanupFailure;
    });

    const failure = await cleanupAfterInitializationFailure(
      stack,
      initializationFailure,
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([
      initializationFailure,
      lastCleanupFailure,
      firstCleanupFailure,
    ]);
  });

  it("keeps a user AggregateError nested among multiple cleanup failures", async () => {
    const initializationFailure = new Error("initialization failed");
    const userAggregate = new AggregateError(
      [new Error("nested user failure")],
      "user cleanup failed",
    );
    const lastCleanupFailure = new Error("last cleanup failed");
    const stack = new CleanupStack();
    stack.add(() => {
      throw userAggregate;
    });
    stack.add(() => {
      throw lastCleanupFailure;
    });

    const failure = await cleanupAfterInitializationFailure(
      stack,
      initializationFailure,
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([
      initializationFailure,
      lastCleanupFailure,
      userAggregate,
    ]);
  });
});
