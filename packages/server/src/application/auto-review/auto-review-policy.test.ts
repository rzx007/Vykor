import { describe, expect, it } from "vitest";
import {
  classifyAutoReviewRisk,
  type AutoReviewChangeFile,
  type AutoReviewChangeSet,
} from "./auto-review-policy.js";

function changeSet(
  files: Array<Partial<AutoReviewChangeFile> & { path: string }>,
  extra: Partial<AutoReviewChangeSet> = {},
): AutoReviewChangeSet {
  return {
    files: files.map((file) => ({ status: "modified", lines: 0, ...file }) as AutoReviewChangeFile),
    attribution: "complete",
    patchTruncated: false,
    ...extra,
  };
}

describe("classifyAutoReviewRisk", () => {
  it("treats an empty change set as no work", () => {
    expect(classifyAutoReviewRisk(changeSet([]))).toMatchObject({
      level: "none",
      shouldReview: false,
      reasons: ["no_changes"],
    });
  });

  it("treats documentation-only changes as low risk without a review", () => {
    expect(
      classifyAutoReviewRisk(changeSet([{ path: "docs/a.md", status: "modified", lines: 20 }])),
    ).toMatchObject({ level: "low", shouldReview: false, reasons: ["low_risk_change"] });
  });

  it("treats production source changes as medium risk with the medium budget", () => {
    expect(
      classifyAutoReviewRisk(
        changeSet([{ path: "packages/server/src/a.ts", status: "modified", lines: 20 }]),
      ),
    ).toMatchObject({
      level: "medium",
      shouldReview: true,
      requestedMaxTurns: 10,
      requestedTimeoutSeconds: 120,
      reasons: ["source_change"],
    });
  });

  it("treats sensitive paths as high risk with the high budget", () => {
    expect(
      classifyAutoReviewRisk(
        changeSet([{ path: "packages/auth/src/token.ts", status: "modified", lines: 5 }]),
      ),
    ).toMatchObject({
      level: "high",
      shouldReview: true,
      requestedMaxTurns: 20,
      requestedTimeoutSeconds: 240,
    });
  });

  it.each([
    ["auth", "packages/auth/src/token.ts"],
    ["permissions", "src/permissions/check.ts"],
    ["sandbox", "packages/sandbox/runner.ts"],
    ["security", "packages/security/policy.ts"],
    ["migrations", "db/migrations/001.sql"],
    ["database", "packages/database/client.ts"],
    ["agent-runtime", "packages/agent-runtime/src/agent.ts"],
    ["core engine", "packages/core/src/engine/query-engine.ts"],
    ["github workflows", ".github/workflows/ci.yml"],
    ["root Dockerfile", "Dockerfile"],
    ["nested Dockerfile", "packages/server/Dockerfile"],
    ["docker compose", "docker-compose.dev.yml"],
    ["package.json", "package.json"],
    ["nested package.json", "packages/server/package.json"],
    ["pnpm lockfile", "pnpm-lock.yaml"],
    ["pnpm workspace", "pnpm-workspace.yaml"],
  ])("flags %s as a sensitive high-risk path", (_label, path) => {
    const decision = classifyAutoReviewRisk(changeSet([{ path, status: "modified", lines: 1 }]));
    expect(decision.level).toBe("high");
    expect(decision.reasons).toContain("sensitive_path");
  });

  it("normalizes Windows separators before matching sensitive paths", () => {
    const decision = classifyAutoReviewRisk(
      changeSet([{ path: "packages\\auth\\src\\token.ts", status: "modified", lines: 1 }]),
    );
    expect(decision.level).toBe("high");
    expect(decision.reasons).toContain("sensitive_path");
  });

  it("matches sensitive paths case-sensitively", () => {
    const decision = classifyAutoReviewRisk(
      changeSet([{ path: "Packages/Auth/src/token.ts", status: "modified", lines: 1 }]),
    );
    expect(decision.level).toBe("medium");
    expect(decision.reasons).toEqual(["source_change"]);
  });

  it("treats eight files as high risk by volume", () => {
    const files = Array.from({ length: 8 }, (_, index) => ({
      path: `packages/app/src/module-${index}.ts`,
      status: "modified" as const,
      lines: 1,
    }));
    const decision = classifyAutoReviewRisk(changeSet(files));
    expect(decision.level).toBe("high");
    expect(decision.reasons).toContain("many_files");
  });

  it("treats six hundred changed lines as high risk by volume", () => {
    const decision = classifyAutoReviewRisk(
      changeSet([{ path: "packages/app/src/a.ts", status: "modified", lines: 600 }]),
    );
    expect(decision.level).toBe("high");
    expect(decision.reasons).toContain("large_change");
  });

  it("flags production deletions and renames as high risk", () => {
    const deletion = classifyAutoReviewRisk(
      changeSet([{ path: "packages/server/src/a.ts", status: "deleted", lines: 10 }]),
    );
    expect(deletion.level).toBe("high");
    expect(deletion.reasons).toContain("production_delete_or_rename");

    const rename = classifyAutoReviewRisk(
      changeSet([
        { path: "packages/server/src/b.ts", oldPath: "packages/server/src/a.ts", status: "renamed", lines: 0 },
      ]),
    );
    expect(rename.level).toBe("high");
    expect(rename.reasons).toContain("production_delete_or_rename");
  });

  it("flags a truncated patch as high risk and keeps it reviewable", () => {
    const decision = classifyAutoReviewRisk(
      changeSet([{ path: "docs/a.md", status: "modified", lines: 10 }], {
        patchTruncated: true,
      }),
    );
    expect(decision).toMatchObject({ level: "high", shouldReview: true });
    expect(decision.reasons).toContain("patch_truncated");
  });

  it("flags a rename with a sensitive side even when the other side looks low risk", () => {
    const decision = classifyAutoReviewRisk(
      changeSet([
        {
          path: "packages/core/src/engine/query-engine.ts",
          oldPath: "docs/design.md",
          status: "renamed",
          lines: 0,
        },
      ]),
    );
    expect(decision.level).toBe("high");
    expect(decision.reasons).toContain("sensitive_path");
    expect(decision.reasons).toContain("production_delete_or_rename");
  });

  it("reports incomplete attribution as unknown without scheduling a review", () => {
    const decision = classifyAutoReviewRisk(
      changeSet([{ path: "packages/server/src/a.ts", status: "modified", lines: 5 }], {
        attribution: "incomplete",
      }),
    );
    expect(decision).toMatchObject({ level: "unknown", shouldReview: false });
    expect(decision.reasons).toEqual(["git_inspection_failed"]);
  });

  it("keeps an explicit attribution reason for incomplete change sets", () => {
    const decision = classifyAutoReviewRisk(
      changeSet([], { attribution: "incomplete", attributionReason: "non_linear_head_change" }),
    );
    expect(decision).toMatchObject({ level: "unknown", shouldReview: false });
    expect(decision.reasons).toEqual(["non_linear_head_change"]);
  });

  it("stays low risk only for a bounded, non-deleting documentation set", () => {
    const decision = classifyAutoReviewRisk(
      changeSet([
        { path: "docs/a.md", status: "modified", lines: 100 },
        { path: "packages/server/src/a.test.ts", status: "modified", lines: 100 },
        { path: "packages/server/src/__test__/b.ts", status: "added", lines: 50 },
        { path: "packages/server/src/fixtures/c.json", status: "modified", lines: 40 },
      ]),
    );
    expect(decision).toMatchObject({ level: "low", shouldReview: false });
  });

  it("escalates a documentation set that deletes a file to medium", () => {
    const decision = classifyAutoReviewRisk(
      changeSet([{ path: "docs/a.md", status: "deleted", lines: 10 }]),
    );
    expect(decision.level).toBe("medium");
  });

  it("escalates an oversized documentation set to medium", () => {
    const decision = classifyAutoReviewRisk(
      changeSet(
        Array.from({ length: 6 }, (_, index) => ({
          path: `docs/a-${index}.md`,
          status: "modified" as const,
          lines: 10,
        })),
      ),
    );
    expect(decision.level).toBe("medium");
  });
});
