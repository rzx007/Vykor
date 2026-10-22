import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import type { StorageRetentionPolicy } from "@vykor/protocol";
import { defaultUsageSettings, type UsageSettings } from "./usage-settings.js";

export function createMaintenancePolicyRepository(storePath: string) {
  const policyPath = join(dirname(storePath), "storage-policy.json");
  function readPolicy(): StorageRetentionPolicy {
    if (!existsSync(policyPath))
      return { version: 1, enabled: false, days: 90, lastRunAt: null };
    const policy = JSON.parse(
      readFileSync(policyPath, "utf-8"),
    ) as StorageRetentionPolicy;
    if (
      policy.version !== 1 ||
      typeof policy.enabled !== "boolean" ||
      !Number.isSafeInteger(policy.days) ||
      policy.days < 1 ||
      policy.days > 36500
    )
      throw new Error("存储保留策略格式无效");
    return policy;
  }
  function savePolicy(policy: StorageRetentionPolicy) {
    writeFileSync(`${policyPath}.tmp`, JSON.stringify(policy), { mode: 0o600 });
    renameSync(`${policyPath}.tmp`, policyPath);
    return policy;
  }
  const configPath = join(dirname(storePath), "usage-settings.json");
  function readSettings(): UsageSettings {
    if (!existsSync(configPath)) return structuredClone(defaultUsageSettings);
    const value = JSON.parse(
      readFileSync(configPath, "utf-8"),
    ) as UsageSettings;
    if (value.version !== 1 || !Array.isArray(value.prices))
      throw new Error("用量配置格式不兼容");
    if (
      Object.keys(value).some(
        (key) => !["version", "prices", "budget"].includes(key),
      ) ||
      !value.budget ||
      typeof value.budget.enabled !== "boolean" ||
      !/^[A-Z]{3}$/.test(value.budget.currency)
    )
      throw new Error("用量配置包含无效字段");
    for (const threshold of [value.budget.tokens, value.budget.amount])
      if (threshold !== null && (!Number.isFinite(threshold) || threshold <= 0))
        throw new Error("已保存预算阈值无效");
    for (const price of value.prices) {
      if (
        !price ||
        typeof price.subscription !== "boolean" ||
        !Number.isFinite(price.adoptedAt) ||
        price.adoptedAt < 0
      )
        throw new Error("已保存价格依据无效");
      for (const key of ["provider", "model", "currency", "source"] as const)
        if (typeof price[key] !== "string" || !price[key].trim())
          throw new Error("已保存价格来源无效");
      for (const key of [
        "inputPerMillion",
        "outputPerMillion",
        "cacheReadPerMillion",
        "cacheCreationPerMillion",
      ] as const)
        if (!Number.isFinite(price[key]) || price[key] < 0)
          throw new Error("已保存单位价格无效");
    }
    return value;
  }
  function saveSettings(value: UsageSettings) {
    const temporary = `${configPath}.tmp`;
    writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
    renameSync(temporary, configPath);
    return value;
  }

  return { readPolicy, savePolicy, readSettings, saveSettings };
}
