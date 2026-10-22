/** Stable source identity captured by the host when an input is admitted. */
export interface PluginSelectionCandidate {
  pluginId: string;
  displayName: string;
  description: string;
  version: string;
  behaviorDigest?: string;
}

/** Prepared by the host; summaries never grant execution capabilities. */
export interface PluginSelectionCatalog {
  candidates: readonly PluginSelectionCandidate[];
  validate(candidate: PluginSelectionCandidate): Promise<void>;
}

/** Retained for persisted single-plugin runs created before scope version 2. */
export interface PluginSelectionResult {
  pluginId: string | null;
  reason:
    | "matched"
    | "no_match"
    | "no_candidates"
    | "invalid_response"
    | "selection_failed";
  version?: string;
  behaviorDigest?: string;
}
