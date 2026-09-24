import type { SkillDefinition } from "./index.js";

/**
 * 构造一个内置（bundled）技能定义，统一默认值：
 * source="bundled"、path=""（标识为内嵌，无文件路径）、
 * userInvocable=true、disableModelInvocation=false。
 */
function bundled(
  name: string,
  description: string,
  content: string
): SkillDefinition {
  return {
    name,
    description,
    content: content.trim() + "\n",
    path: "",
    source: "bundled",
    userInvocable: true,
    disableModelInvocation: false,
  };
}

const COMMIT = `
# commit

Write a clean, conventional git commit for the staged (or specified) changes.

## When to use
After finishing a coherent unit of work and the user asks to commit, or you are
about to record changes. Prefer many small atomic commits over one large one.

## Method
1. Inspect what changed: \`git status\` and \`git diff --staged\` (or \`git diff\`).
   Understand the *intent* of the change, not just the lines.
2. Decide scope. One commit should represent one logical change. If the diff mixes
   unrelated concerns (a refactor + a bugfix), split them with \`git add -p\`.
3. Write the message as **Conventional Commits**:
   \`<type>(<scope>): <subject>\`
   - types: feat, fix, refactor, docs, test, chore, perf, build, ci
   - subject: imperative mood, lower-case, no trailing period, <= 72 chars
   - scope: optional, the affected area (e.g. \`auth\`, \`parser\`)
4. Add a body only when the *why* is non-obvious. Wrap at ~72 cols. Explain the
   motivation and contrast with previous behavior — not the *what* (the diff shows that).
5. Reference issues in a footer (\`Closes #123\`) when relevant.

## Good vs bad
- bad:  \`fix stuff\`
- good: \`fix(parser): handle empty frontmatter without throwing\`

## Checklist before committing
- [ ] Diff contains only related changes
- [ ] No debug prints, secrets, or commented-out code
- [ ] Subject is imperative and scoped
- [ ] Tests pass if the project has a fast test command
`;

const REVIEW = `
# review

Review a set of changes for correctness bugs first, then reuse/simplification.

## When to use
The user asks to review a diff, a PR, or the current working tree before merging.

## Method
1. Establish the diff under review: \`git diff\`, \`git diff main...HEAD\`, or the
   files the user named. Read enough surrounding code to understand intent.
2. **Pass 1 — correctness.** Hunt for real bugs, ranked by severity:
   - logic errors, off-by-one, wrong operator, inverted condition
   - unhandled errors, missing await, race conditions, resource leaks
   - boundary cases: empty input, null/undefined, large input, concurrency
   - security: injection, path traversal, unvalidated input, leaked secrets
3. **Pass 2 — reuse & simplification.** Only after correctness:
   - duplicated logic that an existing helper already covers
   - needless complexity that can be flattened
   - dead code, unused params, redundant branches
4. Skip style nits the formatter/linter already enforces.

## Output
Group findings by severity: **Critical / High / Medium / Low / Nit**.
For each: file:line, what's wrong, why it matters, and a concrete fix.
If the change is clean, say so plainly — do not invent problems to look thorough.
`;

const TEST = `
# test

Add or run tests that meaningfully cover the change.

## When to use
After (or while) implementing a feature/fix, or when the user asks for test coverage.

## Method
1. Find the project's test setup: framework, test command, and where tests live.
   Match the existing style and naming conventions.
2. Prefer **TDD** when adding new behavior: write a failing test that pins the
   desired behavior, watch it fail, implement, watch it pass.
3. Cover the **critical paths first**:
   - the happy path the feature exists for
   - the boundary/edge cases (empty, null, max, concurrent)
   - the error path (does it fail the way it should?)
   - one regression test per bug you fix
4. Keep tests deterministic and isolated — no real network, clocks, or shared
   mutable state. Mock at the boundary, not the internals.
5. **Run them** and read the output. A test you didn't run is a guess.

## Anti-patterns
- Asserting on implementation details instead of observable behavior.
- Tests that pass even when the code is broken (no real assertion).
- Giant tests covering ten things — one behavior per test.

## Finish
Report what is now covered and what is intentionally not, then run the suite.
`;

const PLAN = `
# plan

Turn a request into a concrete, executable implementation plan before coding.

## When to use
The task is multi-step or touches several files, and jumping straight to code
risks rework. Plan first, then execute.

## Method
1. **Clarify the goal.** Restate what done looks like in one or two sentences.
   Note any ambiguity worth confirming before writing code.
2. **Survey the code.** Identify the key files/modules involved and how they
   connect. Find the seam where the change belongs.
3. **Break into ordered steps.** Each step should be small, independently
   verifiable, and leave the build green if possible. Sequence so dependencies
   come first.
4. For each step note: the files touched, the core change, and how to verify it.
5. **Call out risks** up front: tricky edge cases, things that could break
   downstream, places you're unsure about and want to validate early.

## Output format
- **Goal:** one-line definition of done
- **Key files:** path — role in the change
- **Steps:** numbered, each with file(s) + verification
- **Risks / open questions:** what could go wrong, what to confirm

Keep it tight. A plan is a tool to act, not a document to admire.
`;

const DEBUG = `
# debug

Systematically find and fix the root cause of a bug — reproduce before you change.

## When to use
A test fails, behavior is wrong, or something throws. Use this *before* proposing
a fix, especially when the cause isn't obvious.

## Method
1. **Reproduce reliably.** Get a deterministic, minimal repro. If you can't
   reproduce it, you can't confirm a fix. Capture exact input, environment, and output.
2. **Read the actual error.** Full stack trace, real message — not a paraphrase.
   The failing frame usually points near the cause.
3. **Localize.** Bisect the problem space: which layer, which function, which input.
   Add targeted logging or use a debugger. Form a hypothesis you can test, then test it.
4. **Find the root cause, not the symptom.** Ask why the bad state arose, not just
   how to suppress it. A null check that hides a missing initialization is a patch, not a fix.
5. **Fix the cause.** Make the smallest change that addresses the root.
6. **Verify.** Re-run the original repro and confirm it now passes. Add a
   regression test so it can't silently come back. Check you didn't break neighbors.

## Discipline
- One hypothesis at a time. Don't shotgun multiple changes and lose track of cause.
- If a fix doesn't work, revert it before trying the next idea.
- Resist the urge to "fix" code you don't yet understand.
`;

const CREATE_SKILL = `
# create-skill

Create or install a local Vykor skill by writing a \`SKILL.md\` to disk.

## When to use
The user asks to create, write, install, or add a local skill; to turn a workflow
into a reusable skill; or to put a \`SKILL.md\` somewhere this runtime will load it.

This skill only covers **local filesystem install**. It is not a marketplace or
GitHub installer.

## Ask scope first
Ask whether the skill is personal (all projects) or project-scoped (this repo).
Do not guess. Default only if the user already said so.

## Storage Locations

| Type | Path | Scope |
|------|------|-------|
| Personal | \`~/.vykor/skills/<skill-name>/\` | Available across all projects for this user |
| Project | \`<cwd>/.vykor/skills/<skill-name>/\` | Shared with the repository |

The runtime also **scans** \`.agents/skills\` (git-root to cwd). When *creating*
a skill, write to \`.vykor/skills\` unless the user explicitly asks
for the other project directory.

Load order is last-writer-wins: bundled < plugin < user < project.

## Directory layout

\`\`\`
skill-name/
├── SKILL.md                 # required
├── scripts/                 # optional
├── references/              # optional
└── assets/                  # optional
\`\`\`

The directory name must match the frontmatter \`name\`. Filename must be exactly
\`SKILL.md\`.

## SKILL.md structure

\`\`\`markdown
---
name: skill-name
description: What it does and when to use it.
---

# Skill Name

Instructions the agent should follow when this skill is invoked.
\`\`\`

Keep \`name\` lowercase with hyphens. Put the trigger phrases in \`description\`.
After writing the file, tell the user they can invoke it with \`/skill-name\` or
the \`Skill\` tool. Newly written skills are picked up on the next \`Skill\` /
\`ListSkills\` call (filesystem refresh).
`;

/**
 * 随包发布的内置技能集合。
 * 加载顺序最低优先级：bundled < user < project（同名后者覆盖）。
 */
export const BUNDLED_SKILLS: SkillDefinition[] = [
  bundled("commit", "Write a clean, conventional, atomic git commit message for the current changes.", COMMIT),
  bundled("review", "Review a diff for correctness bugs first, then reuse and simplification, with severity-graded findings.", REVIEW),
  bundled("test", "Add or run meaningful tests covering happy path, edges, and error paths; verify by running them.", TEST),
  bundled("plan", "Turn a request into an ordered, verifiable implementation plan with key files and risks.", PLAN),
  bundled("debug", "Systematically reproduce, localize, and fix the root cause of a bug, then add a regression test.", DEBUG),
  bundled(
    "create-skill",
    "Create or install a local skill by writing SKILL.md under ~/.vykor/skills or the project .vykor/skills directory. Use when the user asks to add, write, or install a skill on disk.",
    CREATE_SKILL,
  ),
];
