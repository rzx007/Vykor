# @vykor/swarm

Reusable filesystem-based swarm infrastructure.

This package no longer provides the runtime child-agent backend. Current Agent and Workflow execution goes through the framework-owned `AgentChildManager`; daemon hosting consumes framework events through `DaemonAgentEventProjector` and keeps live routing handles in `LiveChildAgentDirectory`.

## Public Surface

- Team and mailbox helpers
- File-backed permission synchronization helpers
- Team lifecycle helpers

Removed from the public surface:

- `ChildSessionBackend`
- `BackendRegistry`
- `getBackendRegistry`
- `TeammateSpawnConfig`
- `SwarmBackend`

## Tests

```bash
pnpm --filter @vykor/swarm test
```
