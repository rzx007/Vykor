# @vykor/auth

Authentication helpers for Vykor.

This package separates Vykor-managed API keys from external auth sources
such as a local Codex CLI subscription login.

## Credential Storage

`CredentialStorage` stores provider API keys in:

```text
$VYKOR_CONFIG_DIR/credentials.json
```

When `VYKOR_CONFIG_DIR` is not set, the default path is:

```text
~/.vykor/credentials.json
```

Example shape:

```json
{
  "deepseek": {
    "api_key": "sk-xxx"
  }
}
```

## Codex Subscription

Codex subscription auth is external. Vykor reads the local Codex CLI auth
file and does not copy that token into `credentials.json`.

Default source:

```text
~/.codex/auth.json
```

With `CODEX_HOME`:

```text
$CODEX_HOME/auth.json
```

## Usage

```ts
import { CredentialStorage, describeCodexAuthState } from "@vykor/auth";

const storage = new CredentialStorage();
await storage.storeApiKey("deepseek", "sk-xxx");
const key = await storage.loadApiKey("deepseek");

const codex = await describeCodexAuthState();
if (codex.configured) {
  console.log(`Codex ready: ${codex.profileLabel ?? codex.source}`);
}
```

## CLI Semantics

```text
auth     prepares a credential source
provider chooses the model vendor
model    chooses the model name
```

Main CLI shape:

```bash
vk auth login deepseek sk-xxx
vk auth login codex
```

See `docs/auth-provider-model.md` for the complete runtime flow.

## Tests

```bash
pnpm --filter @vykor/auth test
```
