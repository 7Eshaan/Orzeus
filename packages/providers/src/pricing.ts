import type { MicroUsd, TokenUsage } from "@orzeus/schema";

/** Prices per million tokens, in micro-USD. */
export interface TokenPrices {
  readonly input: number;
  readonly cachedInput: number;
  readonly output: number;
}

/**
 * OpenAI standard-tier text prices for the short-context rate (≤272K input tokens), from
 * https://developers.openai.com/api/docs/pricing (checked 2026-11-19). Long-context requests
 * cost more; Orzeus's packets stay far below that limit.
 */
export const OPENAI_PRICES: Readonly<Record<string, TokenPrices>> = {
  "gpt-6.2-astra": { input: 8_000_000, cachedInput: 400_000, output: 40_000_000 },
  "gpt-6-astra": { input: 10_000_000, cachedInput: 1_000_000, output: 50_000_000 },
  "gpt-6.2-sol": { input: 2_000_000, cachedInput: 100_000, output: 10_000_000 },
  "gpt-6.1-sol": { input: 2_000_000, cachedInput: 100_000, output: 10_000_000 },
  "gpt-6-sol": { input: 2_000_000, cachedInput: 200_000, output: 10_000_000 },
  "gpt-6.1-terra": { input: 1_000_000, cachedInput: 50_000, output: 5_000_000 },
  "gpt-6-luna": { input: 100_000, cachedInput: 10_000, output: 500_000 },
};

/** Exact model id first, then a dated snapshot of it (e.g. "gpt-6-luna-2026-09-01"). */
export function pricesFor(
  table: Readonly<Record<string, TokenPrices>>,
  model: string,
): TokenPrices | null {
  if (table[model] !== undefined) return table[model];
  const base = Object.keys(table)
    .filter((id) => model.startsWith(`${id}-`))
    .sort((a, b) => b.length - a.length)[0];
  return base === undefined ? null : (table[base] ?? null);
}

/** Cost of one call; reasoning tokens are billed as output and already counted in it. */
export function costOf(prices: TokenPrices | null, usage: TokenUsage): MicroUsd | null {
  if (prices === null) return null;
  return Math.round(
    (usage.inputTokens * prices.input +
      usage.cacheReadTokens * prices.cachedInput +
      usage.outputTokens * prices.output) /
      1_000_000,
  ) as MicroUsd;
}
