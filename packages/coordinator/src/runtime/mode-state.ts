export const COORDINATOR_MODE_ENV = "VYKOR_COORDINATOR_MODE";

const COORDINATOR_TRUTHY_VALUES = new Set(["1", "true", "yes"]);

function isTruthyEnv(value: string | undefined): boolean {
  return value !== undefined && COORDINATOR_TRUTHY_VALUES.has(value.toLowerCase());
}

export function isCoordinatorMode(): boolean {
  return isTruthyEnv(process.env[COORDINATOR_MODE_ENV]);
}
