/**
 * 整合 dream prompt 构建（移植自 Python autodream/prompt.py，文案逐字保留）。
 */

export const MAX_ENTRYPOINT_LINES = 200;
export const ENTRYPOINT_NAME = "MEMORY.md";

export function buildConsolidationPrompt(
  memoryRoot: string,
  extra = "",
  options?: { preview?: boolean },
): string {
  const extraSection = extra.trim() ? `\n\n## Additional context\n\n${extra.trim()}` : "";
  const writeMode = options?.preview
    ? "PREVIEW MODE: do not write files; propose a concise patch plan only."
    : "APPLY MODE: update memory files directly when changes are clearly warranted.";
  const today = new Date().toISOString().slice(0, 10);

  return `# Dream: Memory Consolidation

You are performing a dream — a reflective pass over Vykor/ohmo memory files. Synthesize recent signal into durable, well-organized memories so future sessions can orient quickly.

Current date: ${today}
Memory directory: \`${memoryRoot}\`
Mode: ${writeMode}

---

## Non-negotiable memory policy

### Evidence discipline

- Do not infer user mistakes, motives, personality traits, or habits from incidental logs/config.
- Only record facts directly supported by user statements, repeated behavior, or explicit artifacts.
- Prefer neutral safety policies over accusations.
- If a secret appears in context, do not copy it. Record only a generic safety reminder if useful.
- Never preserve API keys, tokens, app secrets, verification tokens, credential-bearing URLs, or bearer strings.

### Classify every fact before writing

Use these categories:

1. **Stable Preference** — user-stated or repeatedly demonstrated durable preference.
2. **Durable Project Context** — repo paths, canonical repos, project boundaries, validation commands.
3. **Recent Snapshot** — active branches, current commits, temporary worktrees, recent test counts. Must include \`Last observed: YYYY-MM-DD\` and a reminder to verify current state.
4. **Sensitive/Private Context** — revenue, personal identity, private repos, business metrics. Must include \`Privacy: personal/private; do not share externally or in group chats unless explicitly asked.\`
5. **Operational Reminder** — short safety or workflow reminders.

### Staleness and scope

- Short-lived facts must be marked as snapshots, not permanent truths.
- Prefer updating existing files over creating new ones.
- Create at most 2 new markdown files in one dream.
- If a topic is transient, prefer \`recent_work.md\` or an existing status file over a new topic file.
- Do not move personal/business context into project memory; keep sensitive personal context in personal memory only.
- Every top-level memory file must include schema-v1 frontmatter with:
  \`schema_version\`, \`id\`, \`name\`, \`description\`, \`type\`, \`category\`, \`importance\`, \`source\`,
  \`signature\`, \`created_at\`, \`updated_at\`, \`ttl_days\`, \`disabled\`, and \`supersedes\`.

---

## Phase 1 — Orient

- List the memory directory to see what already exists.
- Read \`${ENTRYPOINT_NAME}\` if present; it is the memory index.
- Skim existing topic files so you update or merge instead of creating duplicates.

## Phase 2 — Gather recent signal

Look for information worth persisting. Sources in rough priority order:

1. Existing memory files that may need updates or contradiction fixes.
2. Durable session ids supplied in Additional context, used as evidence that enough recent work exists.
3. Focused inspection of existing memory topics; avoid unrelated project files.

Skip idle chats, failed retry noise, implementation details that only matter for the current turn, and facts that cannot be supported.

## Phase 3 — Consolidate

For each durable thing worth remembering, write or update concise top-level markdown files in the memory directory.

Focus on:
- Merging new signal into existing topic files rather than creating near-duplicates.
- Converting relative dates ("yesterday", "last week") to absolute dates.
- Correcting or deleting contradicted facts at the source.
- Keeping memories useful for future sessions, not as raw transcripts.
- Adding \`Last observed\` for snapshots and \`Privacy\` for sensitive/private context.

## Phase 4 — Prune and index

Update \`${ENTRYPOINT_NAME}\` so it stays under ${MAX_ENTRYPOINT_LINES} lines and remains an index, not a content dump.

- Each entry should be one concise line: \`- [Title](file.md): one-line hook\`.
- Remove pointers to memories that are stale, wrong, or superseded.
- For stale, wrong, or superseded memory files, set \`disabled: true\`; do not delete files.
- Treat usage-based stale candidates as review candidates, not automatic deletion instructions.
- Add pointers to newly important memories.
- Resolve contradictions if multiple files disagree.

## Required final response

Return a structured summary:

\`\`\`md
## Dream Summary
Changed:
- file.md: what changed

Confidence:
- High: directly supported facts
- Medium: recent snapshots that should be verified before use
- Low: uncertain/stale candidates not written as facts

Privacy:
- Any private/sensitive context touched and how it is marked

Stale candidates:
- Items that may need review later
\`\`\`

If nothing changed, say so and explain why.${extraSection}`;
}
