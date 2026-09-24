# User-scoped Native Plugin installation design

## Goal

Native Plugins are installed for the user, not for an individual project. A plugin ID therefore has one mutable user installation record whose cache path points to an immutable content snapshot. Project working directories affect runtime execution context only; they do not create separate plugin identities or permission grants.

## Installation contract

- Local install and link APIs accept only `scope: "user"`.
- CLI install commands no longer expose a scope selector and always send `user`.
- The server rejects `project` and `local` values instead of silently promoting their narrower approvals to user scope.
- Install, link, enable, disable, and uninstall are global runtime mutations: they acquire the global mutation lease and close every cached runtime after a successful state change. Reload remains cwd-specific because it changes no installation state.
- Reinstalling the same ID replaces the user installation only after the candidate manifest and its newly supplied permission approvals pass validation.
- Non-link records persist the SHA-256 behavior digest computed from every cached file. Link records remain explicitly mutable development installations and do not pin a content digest.

## Legacy records

The store schema continues to understand `project` and `local` values so existing files can be read. Discovery and management ignore those records and return a warning that the plugin must be reinstalled for the user. They are not automatically migrated because a project-only permission approval cannot safely become a user-wide approval.

Existing non-link user records without a persisted digest are also rejected at runtime and reported as requiring reinstall. Computing and accepting a digest during migration would trust whichever content currently occupies the formerly shared cache.

## Runtime verification

Before any contribution is loaded, runtime discovery validates the cached manifest and compares it with its installation record. For copied user installations it first verifies that the cache root itself is a real directory whose resolved path is the expected child of its resolved parent; it never follows a snapshot-root symbolic link or directory junction.

1. manifest ID equals the recorded ID;
2. manifest version equals the recorded version;
3. permissions recomputed from the actual manifest exactly equal the recorded requested permissions;
4. every actual requested permission appears in the recorded approvals;
5. a non-link installation has a recorded digest and the current cache digest equals it.

Any mismatch fails closed with a warning. Link installations skip only the content-digest comparison; manifest identity, version, and permissions are still checked on every discovery.

## Cache behavior

Copied installations use `cacheRoot/pluginId/<safeVersion>-<digest>`. Candidate copying and validation remain atomic, and reinstalling an ID creates another immutable snapshot before switching the user record to it. The final snapshot entry must be a real directory, not a symbolic link or directory junction, and its resolved path must remain under the resolved plugin cache directory. If an existing snapshot has the wrong digest, cannot be read, or contains a nested link that prevents digest calculation, reinstall atomically moves its root entry to quarantine, rebuilds the expected snapshot from the validated source, and removes the quarantine without traversing or deleting a link target. A failed candidate or failed store update leaves every previously referenced valid snapshot intact. A Runtime that already verified the old path continues reading the same bytes even if a new version is installed concurrently.

The record-verification function lives in `@vykor/plugins` and is shared by Agent Runtime discovery, plugin management listing, and CLI dry-run discovery. A rejected record is never passed to component loading; management surfaces it as invalid with the same diagnostic the runtime uses.

## Tests

- installer rejects non-user scopes and persists a digest for copied installs;
- CLI exposes no project/local installation option and sends user scope;
- HTTP rejects non-user installation requests;
- user-level mutations use the global runtime lease and close all runtimes;
- discovery ignores legacy project/local records and reports them;
- runtime rejects missing or mismatched digests, manifest identity/version mismatches, and actual permission mismatches;
- runtime accepts a correctly recorded copied plugin;
- link mode remains mutable while permission escalation is rejected;
- cache materialization and runtime verification reject symbolic-link/junction snapshot roots and detect source changes during copying;
- reinstall recovers when nested links or read errors prevent digest calculation without deleting external link targets;
- reinstall repairs a corrupted snapshot and restores runtime discovery without accepting the corrupted bytes.
