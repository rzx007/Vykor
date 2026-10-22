import { DomainValidationError } from "../validation-error.js";
/** Ordinary Prompt inputs cannot claim host-created UI instances or action Runs. */
export function withoutHostPluginMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const { pluginUi: _ui, uiAction: _action, pluginUiSubmission: _submission,
    pluginAppAction: _appAction, pluginAppSubmission: _appSubmission, pluginAppSource: _appSource, ...ordinary } = metadata;
  return ordinary;
}

export function assertPromptMetadataAllowed(input: {
  metadata?: unknown;
  runMetadata?: unknown;
}): void {
  for (const namespace of ["metadata", "runMetadata"] as const) {
    const metadata = input[namespace];
    if (!metadata || typeof metadata !== "object") continue;
    for (const name of ["pluginUi", "uiAction", "pluginUiSubmission", "pluginAppAction", "pluginAppSubmission", "pluginAppSource"]) {
      if (Object.hasOwn(metadata, name)) {
        const field = `${namespace}.${name}`;
        throw new DomainValidationError(
          `${field} is reserved for the host`,
          field,
        );
      }
    }
  }
}
