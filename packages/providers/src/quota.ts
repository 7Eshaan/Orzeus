import type { AccountId, QuotaWindow } from "@orzeus/schema";

const status = (used: number | null, limited = false): QuotaWindow["status"] =>
  limited || (used !== null && used >= 100)
    ? "limited"
    : used !== null && used >= 80
      ? "warning"
      : "ok";

const round = (n: number) => Math.round(n * 10) / 10;

/**
 * OpenAI's reset headers are durations such as "1s", "6m0s", "1h2m3.5s" or "250ms".
 * Returns milliseconds, or null when the value cannot be read.
 */
export function parseResetDuration(value: string | null): number | null {
  if (value === null || value.trim() === "") return null;
  const text = value.trim();
  if (/^\d+(\.\d+)?$/.test(text)) return Number(text) * 1_000;
  let ms = 0;
  let matched = "";
  for (const m of text.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)) {
    matched += m[0];
    const n = Number(m[1]);
    ms += m[2] === "h" ? n * 3_600_000 : m[2] === "m" ? n * 60_000 : m[2] === "s" ? n * 1_000 : n;
  }
  return matched === text ? Math.round(ms) : null;
}

/**
 * `x-ratelimit-*` response headers (OpenAI API) to per-minute quota windows.
 * https://developers.openai.com/api/docs/guides/rate-limits
 */
export function quotaFromOpenAiHeaders(
  accountId: AccountId,
  headers: Headers,
  now: number,
): QuotaWindow[] {
  const windows: QuotaWindow[] = [];
  for (const bucket of ["tokens", "requests"]) {
    const limit = Number(headers.get(`x-ratelimit-limit-${bucket}`));
    const remaining = Number(headers.get(`x-ratelimit-remaining-${bucket}`));
    if (!Number.isFinite(limit) || limit <= 0 || !Number.isFinite(remaining)) continue;
    const used = round(Math.min(100, Math.max(0, ((limit - remaining) / limit) * 100)));
    const reset = parseResetDuration(headers.get(`x-ratelimit-reset-${bucket}`));
    windows.push({
      accountId,
      window: `${bucket}/min`,
      usedPercent: used,
      resetsAt: reset === null ? null : now + reset,
      status: status(used),
      source: "response_headers",
      observedAt: now,
    });
  }
  return windows;
}

/** The rate-limit info Claude Code reports in its stream (Agent SDK `rate_limit_event`). */
export interface ClaudeRateLimitInfo {
  readonly status?: string;
  /** Unix seconds. */
  readonly resetsAt?: number;
  readonly rateLimitType?: string;
  /** 0..1 */
  readonly utilization?: number;
}

const CLAUDE_WINDOWS: Readonly<Record<string, string>> = {
  five_hour: "5h",
  seven_day: "7d",
  seven_day_opus: "7d opus",
  seven_day_sonnet: "7d sonnet",
  overage: "overage",
};

/**
 * Claude's rate-limit events to a quota window. The shape varies between versions, so every
 * field is optional and unknown window types keep their own name.
 */
export function quotaFromClaudeRateLimit(
  accountId: AccountId,
  info: ClaudeRateLimitInfo,
  now: number,
): QuotaWindow[] {
  const type = info.rateLimitType ?? "unknown";
  const used =
    typeof info.utilization === "number" && Number.isFinite(info.utilization)
      ? round(Math.min(100, Math.max(0, info.utilization * 100)))
      : null;
  const rejected = info.status === "rejected";
  return [
    {
      accountId,
      window: CLAUDE_WINDOWS[type] ?? type,
      usedPercent: used,
      resetsAt: typeof info.resetsAt === "number" ? info.resetsAt * 1_000 : null,
      status:
        rejected || (used !== null && used >= 100)
          ? "limited"
          : info.status === "allowed_warning"
            ? "warning"
            : status(used),
      source: "cli_event",
      observedAt: now,
    },
  ];
}

/** Characters per token for estimates when a provider reports no usage (labelled as estimates). */
export const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}
