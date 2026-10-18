import { expect, it } from "vitest"
import { resolveComposerPluginSelection } from "../plugin-selection"
import type { DesktopSessionRecord, DesktopSessionRun } from "@shared/session-types"

const session = (metadata: Record<string, unknown>) => ({ metadata }) as DesktopSessionRecord
const run = (pluginSelection: unknown, createdAt = 1) =>
  ({
    id: `run-${createdAt}`,
    sessionId: "session-1",
    updatedAt: createdAt,
    createdAt,
    status: "completed",
    metadata: { pluginSelection },
  }) as DesktopSessionRun
const catalog = [{ pluginId: "dev.quality", displayName: "Quality" }] as never

it("does not present an automatic capability scope as a selected singleton plugin", () => {
  const automatic = run({ status: "resolved", source: "auto", scopeVersion: 2,
    pluginId: "dev.quality", pluginIds: ["dev.quality", "dev.other"] })
  expect(resolveComposerPluginSelection(session({}), [automatic], catalog).automaticPluginName).toBeNull()
  expect(resolveComposerPluginSelection(session({}), [run({ status: "resolved", source: "auto", pluginId: "dev.quality", pluginIds: ["dev.quality"] })], catalog).automaticPluginName).toBeNull()
})

it("defaults automatic selection on and reads a manual plugin from the session", () => {
  expect(
    resolveComposerPluginSelection(session({ activePluginId: "dev.quality" }), [], catalog)
  ).toEqual({
    pluginAutoSelectionEnabled: true,
    manualPluginName: "Quality",
    automaticPluginName: null,
  })
  expect(
    resolveComposerPluginSelection(
      session({ runtime: { pluginAutoSelectionEnabled: false } }),
      [],
      catalog
    ).pluginAutoSelectionEnabled
  ).toBe(false)
})

it("uses only the latest run's resolved automatic result and never mistakes it for a manual choice", () => {
  const automatic = run({
    status: "resolved",
    source: "auto",
    pluginId: "dev.quality",
    reason: "matched",
  })
  expect(resolveComposerPluginSelection(session({}), [automatic], catalog)).toEqual({
    pluginAutoSelectionEnabled: true,
    manualPluginName: null,
    automaticPluginName: "Quality",
  })
  expect(
    resolveComposerPluginSelection(session({}), [automatic, run(undefined, 2)], catalog)
      .automaticPluginName
  ).toBeNull()
  expect(
    resolveComposerPluginSelection(
      session({}),
      [run({ status: "resolved", source: "explicit", pluginId: "dev.quality" })],
      catalog
    ).automaticPluginName
  ).toBeNull()
})

it("retains a removable manual plugin label when the plugin is no longer in the catalog", () => {
  expect(
    resolveComposerPluginSelection(session({ activePluginId: "missing" }), [], []).manualPluginName
  ).toBe("missing")
})

it("keeps the running turn's automatic plugin visible when another prompt is queued", () => {
  const running = {
    ...run({ status: "resolved", source: "auto", pluginId: "dev.quality" }),
    status: "running" as const,
  }
  const queued = { ...run(undefined, 2), status: "pending" as const }
  expect(
    resolveComposerPluginSelection(session({}), [queued, running], catalog).automaticPluginName
  ).toBe("Quality")
})
