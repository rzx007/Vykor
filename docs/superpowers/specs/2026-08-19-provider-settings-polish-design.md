# Provider Settings Polish Design

## Goal

Refine the desktop provider settings page so feedback is temporary, development-tool subscriptions appear as ordinary providers, and the page has the same restrained card hierarchy as the general settings page.

## Data behavior

- Keep the existing renderer -> typed IPC -> Electron main -> `@vykor/client` -> daemon flow.
- Never invoke or parse `vk auth` or `vk provider` commands.
- Remove the fixed Codex, Claude Code, and Qoder subscription cards.
- Treat an externally detected subscription as a provider whose `credentialSource` is `subscription`.
- Only display subscription providers that the existing service actually detects. The current daemon contract detects Codex; future providers can join the same list without a dedicated UI section.

## Feedback behavior

- A success notice closes automatically after 4 seconds.
- An error notice closes automatically after 6 seconds.
- Both notices have a compact manual close action.
- Starting a refresh or mutation clears the previous notice.

## Visual design

- Retain the current-provider summary, but give it a clearer icon treatment, border/ring, subtle shadow, and restrained typography.
- Use one `供应商` section for detected/connected and available providers.
- Put a tooltip-backed refresh icon button in the section heading.
- Keep provider rows spacious, separated, and responsive; use semantic theme colors, badges, existing shadcn cards/buttons/alerts/tooltips, and no fixed color literals.
- Preserve the custom-provider placeholder as the last row/card because its backend persistence remains out of scope.

## Verification

- Add regression coverage for notice dismissal and for the absence of fixed subscription records.
- Run the focused desktop tests, touched-file lint, and desktop type checks. Report unrelated pre-existing type-check blockers separately.
