import type {
  CompactContext,
  CompactContextProvider,
} from "@vykor/core";

type CompactContextSource<K extends keyof CompactContext> = () =>
  | CompactContext[K]
  | null
  | undefined
  | Promise<CompactContext[K] | null | undefined>;

export interface CompactContextSources {
  supplementalSections?: CompactContextSource<"supplementalSections">;
  sessionMemory?: CompactContextSource<"sessionMemory">;
}

export function createCompactContextProvider(
  sources: CompactContextSources,
): CompactContextProvider {
  return async () => {
    const context: CompactContext = {};
    const supplementalSections = await sources.supplementalSections?.();
    if (supplementalSections) context.supplementalSections = supplementalSections;
    const sessionMemory = await sources.sessionMemory?.();
    if (sessionMemory) context.sessionMemory = sessionMemory;
    return context;
  };
}
