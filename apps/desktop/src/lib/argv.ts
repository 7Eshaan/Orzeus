/**
 * Commands are stored as argv arrays and run without a shell. These helpers let people type them
 * as one line: whitespace separates arguments, and single or double quotes keep spaces.
 */
export function splitArgs(line: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let started = false;
  for (const ch of line) {
    if (quote !== null) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started) args.push(current);
      current = "";
      started = false;
    } else {
      current += ch;
      started = true;
    }
  }
  if (quote !== null) throw new Error(`unclosed ${quote} quote`);
  if (started) args.push(current);
  return args;
}

/** The inverse of splitArgs for display and editing. */
export function joinArgs(argv: readonly string[]): string {
  return argv
    .map((a) => (a === "" || /[\s"']/.test(a) ? (a.includes("'") ? `"${a}"` : `'${a}'`) : a))
    .join(" ");
}

/** KEY=value lines; blank lines and # comments are ignored. */
export function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    const key = eq < 0 ? line : line.slice(0, eq).trim();
    if (eq < 0 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
      throw new Error(`"${line}" is not KEY=value`);
    env[key] = line.slice(eq + 1);
  }
  return env;
}

export function formatEnv(env: Readonly<Record<string, string>>): string {
  return Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
}

/** Lowercase letters, digits and dashes, as node and server ids require. */
export function slugify(text: string, max = 63): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, max) || "item"
  );
}

/** Non-empty trimmed lines. */
export function lines(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
}
