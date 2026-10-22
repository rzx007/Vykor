export interface UsagePrice {
  provider: string; model: string; currency: string; source: string; adoptedAt: number;
  inputPerMillion: number; outputPerMillion: number; cacheReadPerMillion: number; cacheCreationPerMillion: number; subscription: boolean;
  inputIncludesCache?: boolean;
}
export interface UsageSettings { version: 1; prices: UsagePrice[]; budget: { enabled: boolean; tokens: number | null; amount: number | null; currency: string } }
