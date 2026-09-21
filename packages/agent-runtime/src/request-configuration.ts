import type {
  AgentRequestConfiguration,
  AgentRequestConfigurationPatch,
  AgentRequestConfigurationSnapshot,
  AgentRequestConfigurationStore,
} from "@openharness/core";

export type ValidateRequestConfiguration = (
  next: AgentRequestConfiguration,
  patch: AgentRequestConfigurationPatch,
) => Promise<AgentRequestConfiguration>;

export interface MemoryRequestConfigurationStore
  extends AgentRequestConfigurationStore {
  replaceSynchronously(
    patch: AgentRequestConfigurationPatch,
  ): AgentRequestConfigurationSnapshot;
}

export function createMemoryRequestConfigurationStore(
  initial: AgentRequestConfiguration,
  validate: ValidateRequestConfiguration,
): MemoryRequestConfigurationStore {
  let current = copyConfiguration(initial);
  let revision = 0;
  let tail: Promise<unknown> = Promise.resolve();

  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const result = tail.then(work, work);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const snapshot = (): AgentRequestConfigurationSnapshot => ({
    revision,
    configuration: copyConfiguration(current),
  });

  return {
    read: async () => snapshot(),
    update: (patch) => serial(async () => {
      const normalizedPatch = omitUndefined(patch);
      const next = copyConfiguration(await validate(
        { ...current, ...normalizedPatch },
        normalizedPatch,
      ));
      if (!sameConfiguration(current, next)) {
        current = next;
        revision++;
      }
      return snapshot();
    }),
    restoreIfCurrent: (failedRevision, previous) => serial(async () => {
      if (revision !== failedRevision) return undefined;
      const restored = copyConfiguration(await validate(
        copyConfiguration(previous),
        copyConfiguration(previous),
      ));
      if (!sameConfiguration(current, restored)) {
        current = restored;
        revision++;
      }
      return snapshot();
    }),
    replaceSynchronously: (patch) => {
      const next = { ...current, ...omitUndefined(patch) };
      if (!sameConfiguration(current, next)) {
        current = next;
        revision++;
      }
      return snapshot();
    },
  };
}

function copyConfiguration(
  configuration: Readonly<AgentRequestConfiguration>,
): AgentRequestConfiguration {
  return { ...configuration };
}

function omitUndefined(
  patch: AgentRequestConfigurationPatch,
): AgentRequestConfigurationPatch {
  return Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined),
  ) as AgentRequestConfigurationPatch;
}

function sameConfiguration(
  left: AgentRequestConfiguration,
  right: AgentRequestConfiguration,
): boolean {
  const leftKeys = Object.keys(left) as Array<keyof AgentRequestConfiguration>;
  const rightKeys = Object.keys(right) as Array<keyof AgentRequestConfiguration>;
  return leftKeys.length === rightKeys.length && leftKeys.every(
    (key) => Object.prototype.hasOwnProperty.call(right, key) && left[key] === right[key],
  );
}
