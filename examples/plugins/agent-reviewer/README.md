# Agent Reviewer Test Native Plugin

This is a minimal Vykor Native Plugin used to test plugin-provided agents.

It contributes one agent:

```text
example.agent-reviewer:reviewer
```

The plugin does not request permissions and does not include tools, MCP servers, hooks, or skills. It only verifies that `components.agents` is installed and loaded into the Agent Runtime.

After importing the ZIP in Desktop, start a new conversation and ask Vykor to delegate to:

```text
example.agent-reviewer:reviewer
```

Expected behavior: the reviewer agent should answer with concise implementation or plan review feedback.
