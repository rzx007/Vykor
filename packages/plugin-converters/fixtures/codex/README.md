# Codex fixtures

These minimal fixtures were independently authored for Vykor on 2026-09-09.
They model the legacy layout documented at https://developers.openai.com/plugins/build/plugins
and the `skills`, `apps`, and `interface` declarations observed in locally installed
Figma 2.0.21 and Plugin Management 0.1.0 manifests. No proprietary skill content,
credentials, or user configuration is copied. Portable format cases are constructed
in the tests using the official versioned schema identifier.

The MCP URL uses the reserved `.invalid` domain. The skill script deliberately
throws if executed; conversion and loading must only copy/read it.
