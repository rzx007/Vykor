# Custom Providers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove hard-coded Ollama/vLLM entries and let users create, edit, activate, and delete multiple real OpenAI-compatible custom providers.

**Architecture:** Persist non-secret custom provider metadata in `Settings.customProviders` and API keys in the existing credential store. Merge custom providers into daemon provider/model resources, resolve them in agent runtime, and expose CRUD through the existing client and Desktop IPC chain. The renderer composes existing shadcn Dialog, Field, Input, AlertDialog, Button, Badge, and Card components.

**Tech Stack:** TypeScript, Electron, React, shadcn/ui, Hono resource APIs, Vitest, pnpm workspaces

**Spec:** `docs/superpowers/specs/2026-08-19-custom-providers-design.md`

## Global Constraints

- Do not execute or parse `vk auth` or `vk provider` commands from Desktop.
- API keys remain in `CredentialStorage`; do not persist them in `Settings.customProviders`.
- Custom providers are OpenAI-compatible only in this iteration.
- Keep providers and detected subscriptions in one list and preserve the current resizable settings layout.
- Write a failing behavior test before each production behavior and commit in reviewable batches.

---

### Task 1: Core configuration and runtime request support

**Files:**
- Modify: `packages/core/src/types/settings.ts`
- Modify: `packages/core/src/config/settings.ts`
- Test: `packages/core/src/config/settings.test.ts`
- Modify: `packages/api/src/providers/registry.ts`
- Test: `packages/api/src/providers/registry.test.ts`
- Modify: `packages/api/src/providers/openai.ts`
- Test: `packages/api/src/providers/openai.test.ts`
- Modify: `packages/agent-runtime/src/default-runtime.ts`
- Test: `packages/agent-runtime/src/default-runtime.test.ts`

**Interfaces:**
- Produces `CustomProviderSettings`, `CustomProviderModelSettings`, and `Settings.customProviders?: CustomProviderSettings[]`.
- Extends `ProviderConfig` with `headers?: Record<string, string>`.
- Produces `findCustomProvider(settings, providerId)` or an equivalent pure resolver used by runtime.

- [ ] **Step 1: Write failing settings merge and runtime resolution tests**

```ts
it("preserves custom providers loaded from the settings file", async () => {
  const settings = await loadSettings()
  expect(settings.customProviders).toEqual([{
    id: "office-gateway",
    displayName: "Office Gateway",
    baseUrl: "https://gateway.example/v1",
    apiFormat: "openai",
    models: [{ id: "team-model", displayName: "Team Model" }],
    headers: { "X-Tenant": "desktop" },
  }])
})

it("resolves a selected custom provider as an OpenAI-compatible endpoint", async () => {
  const resolved = resolveCustomProviderRuntime(settings, "office-gateway")
  expect(resolved).toEqual({
    backendType: "openai_compat",
    baseURL: "https://gateway.example/v1",
    headers: { "X-Tenant": "desktop" },
  })
})
```

- [ ] **Step 2: Run focused tests and verify expected failures**

Run: `pnpm --filter @vykor/core test -- settings.test.ts && pnpm --filter @vykor/agent-runtime test -- default-runtime.test.ts`

Expected: FAIL because `customProviders` and the custom runtime resolver do not exist.

- [ ] **Step 3: Add the custom provider settings types and runtime lookup**

```ts
export interface CustomProviderModelSettings {
  id: string
  displayName: string
}

export interface CustomProviderSettings {
  id: string
  displayName: string
  baseUrl: string
  apiFormat: "openai"
  models: CustomProviderModelSettings[]
  headers?: Record<string, string>
}
```

Resolve the selected ID from `settings.customProviders` before registry detection and pass its Base URL, API type, and headers to `OpenAICompatibleClient`.

- [ ] **Step 4: Write the failing OpenAI header forwarding test**

```ts
it("forwards custom provider headers to the OpenAI SDK", () => {
  const client = new OpenAICompatibleClient({
    apiKey: "key",
    baseURL: "https://gateway.example/v1",
    headers: { "X-Tenant": "desktop" },
  })
  expect(client.client.defaultHeaders).toMatchObject({ "X-Tenant": "desktop" })
})
```

- [ ] **Step 5: Run the test, implement `defaultHeaders`, and rerun**

Run: `pnpm --filter @vykor/api test -- openai.test.ts`

Expected before implementation: FAIL because headers are ignored. Add `defaultHeaders: config.headers` to the SDK constructor, then expect PASS.

- [ ] **Step 6: Remove Ollama/vLLM from the registry under a failing consumer behavior test**

Change the registry test to assert the available provider names do not contain false local services, run it to observe failure, remove both entries, and rerun `pnpm --filter @vykor/api test -- registry.test.ts`.

- [ ] **Step 7: Run package checks and commit**

Run: `pnpm --filter @vykor/core test && pnpm --filter @vykor/api test && pnpm --filter @vykor/agent-runtime test && pnpm --filter @vykor/agent-runtime check-types`

Commit: `feat(providers): 支持自定义 OpenAI 兼容运行时`

### Task 2: Daemon resources and client CRUD

**Files:**
- Modify: `packages/server/src/application/settings-api.ts`
- Modify: `packages/server/src/application/default-application-services.ts`
- Test: `packages/server/src/application/__test__/default-application-services.test.ts`
- Modify: `packages/server/src/http/routes/system.ts`
- Test: `packages/server/src/http/__test__/http.test.ts`
- Modify: `packages/client/src/types/index.ts`
- Modify: `packages/client/src/transport/http-client.ts`
- Test: `packages/client/src/transport/__test__/http-client.test.ts`

**Interfaces:**
- Produces `CustomProviderInput` and provider service methods `create`, `update`, and `remove`.
- Extends `ProviderInfo` with `custom?: boolean` and `requiresApiKey?: boolean`.
- Client methods: `createCustomProvider(input)`, `updateCustomProvider(id, input)`, `removeCustomProvider(id)`.

- [ ] **Step 1: Write failing provider/model merge tests**

```ts
it("lists configured custom providers and their declared models", async () => {
  expect(await providers.list()).toContainEqual(expect.objectContaining({
    name: "office-gateway",
    displayName: "Office Gateway",
    custom: true,
  }))
  expect(await models.list()).toContainEqual({
    name: "office-gateway",
    displayName: "Office Gateway",
    models: [expect.objectContaining({ id: "team-model", label: "Team Model" })],
  })
})
```

- [ ] **Step 2: Run the service test and verify it fails**

Run: `pnpm --filter @vykor/server test -- default-application-services.test.ts`

Expected: FAIL because services only iterate `PROVIDERS`.

- [ ] **Step 3: Implement validation and service CRUD**

Validate IDs with `/^[a-z0-9][a-z0-9_-]*$/`, reject built-in collisions, require an HTTP(S) Base URL, require non-empty unique model IDs, trim header rows, merge configured providers into list/model results, and use `CredentialStorage` to save or clear an optional API key.

- [ ] **Step 4: Write failing HTTP and client contract tests**

```ts
expect(await client.createCustomProvider(input)).toMatchObject({ id: "office-gateway" })
expect(await client.updateCustomProvider("office-gateway", edited)).toMatchObject({ displayName: "Office AI" })
await client.removeCustomProvider("office-gateway")
expect(await client.listProviders()).not.toContainEqual(expect.objectContaining({ name: "office-gateway" }))
```

- [ ] **Step 5: Add resource routes and transport methods**

Add `POST /providers/custom`, `PATCH /providers/custom/:id`, and `DELETE /providers/custom/:id`; return 400 for validation errors, 404 for missing IDs, and 409 when deleting the active provider. Keep the existing daemon mutation barrier and return the normalized provider record.

- [ ] **Step 6: Run package checks and commit**

Run: `pnpm --filter @vykor/server test && pnpm --filter @vykor/client test && pnpm --filter @vykor/server check-types && pnpm --filter @vykor/client check-types`

Commit: `feat(server): 添加自定义供应商资源接口`

### Task 3: Desktop IPC and unified renderer workflow

**Files:**
- Modify: `apps/desktop/src/shared/provider-types.ts`
- Modify: `apps/desktop/src/shared/ipc-channels.ts`
- Modify: `apps/desktop/src/preload/desktop-api.ts`
- Modify: `apps/desktop/src/preload/index.d.ts`
- Modify: `apps/desktop/src/main/features/provider/ipc.ts`
- Modify: `apps/desktop/src/main/features/provider/provider-service.ts`
- Test: `apps/desktop/src/main/features/provider/provider-service.test.ts`
- Create: `apps/desktop/src/renderer/src/components/desktop/settings-page/custom-provider-form.ts`
- Test: `apps/desktop/src/renderer/src/components/desktop/settings-page/custom-provider-form.test.ts`
- Modify: `apps/desktop/src/renderer/src/components/desktop/settings-page/provider-settings.tsx`

**Interfaces:**
- IPC methods: `providers.createCustom`, `providers.updateCustom`, `providers.removeCustom`.
- `DesktopProviderInfo.custom` identifies editable rows.
- Pure form functions normalize dynamic rows and return field-specific validation messages.

- [ ] **Step 1: Write failing Desktop service snapshot and mutation tests**

```ts
expect(snapshot.providers.find((item) => item.name === "office-gateway")).toMatchObject({
  custom: true,
  connected: true,
  credentialSource: "configured",
})
```

Exercise create/update/remove against a complete fake daemon client and assert returned snapshots, not mock call existence.

- [ ] **Step 2: Run the service tests and verify failure**

Run: `pnpm --filter @vykor/desktop test -- provider-service.test.ts`

Expected: FAIL because custom metadata and mutation methods are absent.

- [ ] **Step 3: Implement shared types, IPC channels, preload methods, and main service operations**

API Key is optional for custom creation/update. After creation, optionally activate the new provider; removal always refreshes and returns the full snapshot.

- [ ] **Step 4: Write failing pure form validation tests**

```ts
expect(validateCustomProviderForm(validForm)).toEqual({ ok: true, value: normalized })
expect(validateCustomProviderForm({ ...validForm, id: "Open AI" })).toEqual({
  ok: false,
  field: "id",
  message: "供应商 ID 只能包含小写字母、数字、连字符或下划线。",
})
expect(validateCustomProviderForm({ ...validForm, models: [] })).toMatchObject({
  ok: false,
  field: "models",
})
```

- [ ] **Step 5: Implement the Dialog form and unified custom rows**

Compose existing `Dialog`, `FieldGroup`, `Field`, `Input`, `Button`, `Separator`, `Badge`, `AlertDialog`, and lucide icons. Dynamic model/header rows use stable client-generated row IDs; validation applies `data-invalid` and `aria-invalid`. Add/edit dialogs share one form. Custom rows use the existing card list and expose edit/delete actions without a separate section.

- [ ] **Step 6: Inspect shadcn docs before finalizing composition**

Run: `pnpm dlx shadcn@latest docs dialog field input alert-dialog button badge card`

Verify every Dialog has a title, destructive confirmation uses AlertDialog, icons use `data-icon`, layout uses `gap-*`, and colors use semantic tokens.

- [ ] **Step 7: Run Desktop checks and commit**

Run: `pnpm --filter @vykor/desktop test && pnpm --filter @vykor/desktop check-types`

Commit: `feat(desktop): 添加自定义供应商管理表单`

### Task 4: Regression, visual QA, and cleanup

**Files:**
- Modify as required by failures in Task 1–3 only.

**Interfaces:**
- Consumes all preceding interfaces; produces no new public surface.

- [ ] **Step 1: Run focused lint and all impacted package tests**

Run: `pnpm --filter @vykor/core test && pnpm --filter @vykor/api test && pnpm --filter @vykor/agent-runtime test && pnpm --filter @vykor/server test && pnpm --filter @vykor/client test && pnpm --filter @vykor/desktop test`

- [ ] **Step 2: Run repository type checks and lint**

Run: `pnpm check-types && pnpm lint`

- [ ] **Step 3: Launch Desktop and visually verify**

Run: `pnpm dev:apps`

Verify the settings shell remains resizable; the right pane keeps its rounded shadow; no Ollama/vLLM rows appear by default; create/edit/delete dialogs fit at common window sizes; multiple models and headers can be added; busy state globally disables mutations; success/error alerts dismiss automatically.

- [ ] **Step 4: Commit only if verification required code changes**

Commit: `fix(desktop): 完善自定义供应商交互`

