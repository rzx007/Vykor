export const OFFICE_VERSION: string;
export const OFFICE_ASSETS: Record<string, [string, string]>;
export function hash(bytes: Uint8Array | string): string;
export function officeBinaryPath(): Promise<string>;
export interface OfficeRunnerContext {
  cwd: string;
  signal: AbortSignal;
  deadline: number;
  binaryPath?: string;
  maxOutputBytes?: number;
}
export function createOfficeRunner(
  context: OfficeRunnerContext,
): Promise<
  (args: string[], operations?: unknown[], closing?: boolean) => Promise<string>
>;
