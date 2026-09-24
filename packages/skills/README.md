# @vykor/skills

Markdown skill loading, parsing, and registry utilities for Vykor.

## What A Skill Is

A skill is a Markdown document plus a small frontmatter header. The Markdown body
is returned to the model as instructions; the frontmatter controls discovery,
slash command routing, and display metadata.

```markdown
---
name: code-reviewer
description: Review code for correctness bugs
user-invocable: true
disable-model-invocation: false
model: gpt-5
argument-hint: <path>
command-name: review-code
display-name: Code Reviewer
---

# code-reviewer

Review the current diff and report correctness issues first.
```

Supported frontmatter keys:

- `name`
- `description`
- `user-invocable` / `user_invocable`
- `disable-model-invocation` / `disable_model_invocation`
- `model`
- `argument-hint` / `argument_hint`
- `command-name` / `command_name`
- `display-name` / `display_name`

If no frontmatter is present, `parseSkillMarkdown()` falls back to the first
heading for `name`, the first body paragraph for `description`, and finally the
file name.

## Sources And Priority

The CLI loads skills into a single `SkillRegistry` in this order:

1. Bundled skills from `BUNDLED_SKILLS`
2. Plugin skills and plugin command projections
3. User skills from `getSkillsDir()` (`~/.vykor/skills` by default)
4. Project skills from `.vykor/skills` and `.agents/skills`, walking
   from the git root toward the current working
   directory

To **create** a local skill, write `<name>/SKILL.md` under the user or project
directory above. The bundled `create-skill` skill documents those paths for the
model; invoke it with `/create-skill` or the `Skill` tool. Do not write new
skills to `.agents/skills` unless the user asks for that layout.

Only these current directories are scanned. Other tool-specific skill directories are not Vykor project sources.

Registration is last-writer-wins, so the effective priority is:

```text
bundled < plugin < user < project
```

Loaded skills are tagged with `source` where known:

- `bundled`
- `plugin`
- `user`
- `project`

## Registry Resolution

`SkillRegistry.resolve(name)` is the shared lookup path for skill invocation. It
checks:

1. Exact `name`
2. Lowercase `name`
3. Title-case first character
4. Exact `commandName`

Both user slash invocation and the model-facing `Skill` tool should use this
resolver so `/command-name` and `Skill({ name: "command-name" })` behave
consistently.

## Invocation Paths

### Slash Invocation

User-invocable skills are exposed as slash commands:

```text
/review-code src/parser.ts
```

The CLI resolves the command with `SkillRegistry.resolve()`, verifies
`userInvocable`, builds a prompt from the skill Markdown, appends arguments when
present, and submits it as a normal model turn. If the skill specifies `model`,
the CLI temporarily uses that model for the turn.

### Model Invocation

The model sees a list built from `SkillRegistry.modelVisibleList()`, excluding
skills with `disableModelInvocation: true`. It can call the `Skill` tool to read
the full Markdown content for a selected skill.

## Tests

```bash
pnpm --filter @vykor/skills test
```
