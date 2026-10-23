export type { SessionApiFormat, SessionRuntimeConfig, SessionRuntimeConfigPatch } from "@vykor/domain-contracts/sessions/runtime-config";
import { readRuntimeMetadata as domainReadRuntimeMetadata, readSessionRuntimeRevision as domainReadSessionRuntimeRevision } from "@vykor/domain-contracts/sessions/runtime-config";
import { DomainValidationError } from "@vykor/domain-contracts/inputs";
import { ProtocolDataError } from "../serialization/serialization.js";
function adaptRuntimeData<T>(work: () => T): T { try { return work(); } catch (error) { if (error instanceof DomainValidationError) throw new ProtocolDataError(error.message, error.field); throw error; } }
export function readRuntimeMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> { return adaptRuntimeData(() => domainReadRuntimeMetadata(metadata)); }
export function readSessionRuntimeRevision(metadata: Record<string, unknown> | undefined): number { return adaptRuntimeData(() => domainReadSessionRuntimeRevision(metadata)); }
