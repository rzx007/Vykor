import { validatePluginAppSource, validateOpenPluginAppInput, validateClosePluginAppInput, validatePluginAppToolInput, validatePluginAppConversationInput, validatePluginAppComposerContexts, type ValidationResult } from "@vykor/domain-contracts/plugin-apps";
import { ApplicationError } from "../../../shared/application-error.js";
function input<T>(result: ValidationResult<T>): T { if(result.ok) return result.value; throw new ApplicationError(400,result.code); }
export const parsePluginAppSource = (value: unknown) => input(validatePluginAppSource(value));
export const parseOpenPluginAppInput = (value: unknown) => input(validateOpenPluginAppInput(value));
export const parseClosePluginAppInput = (value: unknown) => input(validateClosePluginAppInput(value));
export const parsePluginAppToolRequest = (value: unknown) => input(validatePluginAppToolInput(value));
export const parsePluginAppConversationRequest = (value: unknown) => input(validatePluginAppConversationInput(value));
export const parsePluginAppComposerContexts = (value: unknown) => input(validatePluginAppComposerContexts(value));
export type { PluginAppToolInput as PluginAppToolRequest, PluginAppConversationInput as PluginAppConversationRequest } from "@vykor/domain-contracts/plugin-apps";
