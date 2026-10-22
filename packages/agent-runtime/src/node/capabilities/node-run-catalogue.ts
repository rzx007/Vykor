import { readonlyMap, type RunToolBinding } from "@vykor/agent-contracts";
import type { RunCapabilityView } from "../runtime/node-runtime-resources.js";
import type { PluginSelectionCandidate } from "../plugins/plugin-selection.js";
type Candidates = readonly PluginSelectionCandidate[];
/** One Node root owns this private catalogue; descendant runtimes borrow the same instance. */
export class NodeRunCatalogue {
  private readonly candidateMaps = new WeakMap<object, Candidates>();
  private readonly candidateBindings = new WeakMap<
    RunToolBinding,
    Candidates
  >();
  private readonly catalogues = new WeakMap<object, RunCapabilityView>();
  private readonly views = new WeakMap<RunToolBinding, RunCapabilityView>();
  register(view: RunCapabilityView, candidates?: Candidates): void {
    this.catalogues.set(view.tools, view);
    if (candidates) this.candidateMaps.set(view.tools, candidates);
    for (const binding of view.tools.values()) {
      this.views.set(binding, view);
      if (candidates) this.candidateBindings.set(binding, candidates);
    }
  }
  resolveView(
    tools?: ReadonlyMap<string, RunToolBinding>,
  ): RunCapabilityView | undefined {
    if (tools && this.catalogues.has(tools)) return this.catalogues.get(tools);
    for (const binding of tools?.values() ?? []) {
      const view = this.views.get(binding);
      if (view) return Object.freeze({ ...view, tools: readonlyMap(tools!) });
    }
    return undefined;
  }
  resolveCandidates(
    tools?: ReadonlyMap<string, RunToolBinding>,
  ): Candidates | undefined {
    if (tools && this.candidateMaps.has(tools))
      return this.candidateMaps.get(tools);
    for (const binding of tools?.values() ?? []) {
      const candidates = this.candidateBindings.get(binding);
      if (candidates) return candidates;
    }
    return undefined;
  }
}
