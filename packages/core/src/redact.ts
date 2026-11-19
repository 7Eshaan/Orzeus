/**
 * Secret redaction for everything Orzeus writes down: logs, check output, diffs and tool-call
 * bodies (docs/architecture/05-policy-and-safety.md, "Secrets hygiene"). Known secret values are
 * replaced exactly; common key formats are caught by pattern even when Orzeus never saw the key.
 */
export const REDACTED = "[redacted]";

const PATTERNS: readonly RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{20,}/g, // Anthropic
  /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g, // OpenAI
  /\bgh[pousr]_[A-Za-z0-9]{30,}/g, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{30,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key ids
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google API keys
  /\bcrsr_[A-Za-z0-9]{20,}/g, // Cursor API keys
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

/** Bearer tokens keep their "Bearer " prefix so the redacted text still reads naturally. */
const BEARER = /\b(Bearer\s+)[A-Za-z0-9._~+/-]{16,}=*/g;

/** Returns a function that redacts the given secret values and well-known key formats. */
export function createRedactor(secrets: readonly (string | undefined)[]): (text: string) => string {
  // Longest first, so a secret that contains another is replaced whole. Short values are skipped:
  // replacing "abc" everywhere would mangle text without protecting anything.
  const known = [
    ...new Set(secrets.filter((s): s is string => s !== undefined && s.length >= 8)),
  ].sort((a, b) => b.length - a.length);
  return (text) => {
    let out = text;
    for (const secret of known) out = out.split(secret).join(REDACTED);
    for (const pattern of PATTERNS) out = out.replace(pattern, REDACTED);
    return out.replace(BEARER, `$1${REDACTED}`);
  };
}
