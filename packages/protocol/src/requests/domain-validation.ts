import { DomainValidationError } from "@vykor/domain-contracts/inputs";
import { ProtocolValidationError } from "./requests.js";
export function adaptDomainValidation<T>(work: () => T): T {
  try { return work(); } catch (error) {
    if (error instanceof DomainValidationError) throw new ProtocolValidationError(error.message, error.field, error.reason);
    throw error;
  }
}
