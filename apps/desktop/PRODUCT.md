# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Vykor Desktop is for developers who work with an AI coding agent across projects and long-running conversations. They need to move quickly between workspaces, keep the current task readable, and open supporting tools without losing the conversation context.

## Product Purpose

Provide a focused desktop workspace for running Vykor sessions. Success means the user can navigate projects, follow an agent's work, compose the next instruction, and reveal supporting tools from one predictable application shell.

## Brand Personality

Quiet, capable, and precise. The interface should feel familiar to users of strong developer tools, with calm density and restrained feedback instead of decorative spectacle.

## Operating Context

An Electron desktop shell presents the web-based conversation UI alongside project navigation and supporting tools. Developers inspect agent tool calls, file changes, and failures while working in local project directories.

## Capabilities and Constraints

- Tool activities expose original parameters and results separately; summaries must not imply that failed operations succeeded.
- Temporary model connection failures have bounded, cancellable recovery. Already completed tools are not rerun by that recovery; process restart recovery is outside its scope.
- Updating source code does not update an already running service. Builds and service restarts are separate operations.

## Evidence on Hand

Current behavior is documented in [message rendering](../../docs/desktop-agent-message-rendering.md) and [model recovery](../../docs/model-network-retry-design.md). These describe implemented behavior and test boundaries, not a guarantee of uninterrupted upstream service.

## Anti-references

Avoid marketing-page composition, oversized dashboard cards, saturated gradients, decorative glass effects, and playful controls that obscure standard desktop behavior. Do not turn the shell into a generic admin dashboard.

## Design Principles

1. Keep the current conversation visually dominant.
2. Reveal navigation and tools progressively so the workspace can become wide when needed.
3. Use familiar desktop and developer-tool affordances with consistent iconography.
4. Preserve context while switching between projects, conversations, and utility panels.
5. Keep interaction feedback fast, subtle, and readable.

## Accessibility & Inclusion

Target WCAG 2.1 AA contrast, visible keyboard focus, semantic controls, keyboard-operable navigation, and reduced-motion support. Information must not rely on color alone.
