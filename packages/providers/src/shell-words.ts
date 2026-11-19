/**
 * Splits a POSIX-ish command line into argv for policy matching (quotes and backslashes).
 * Anything with shell operators is returned whole as ["sh", "-c", command] so it never matches
 * a narrow allowlist prefix by accident.
 */
export function shellWords(command: string): string[] {
  if (/[|&;<>()`$]/.test(command.replace(/'[^']*'/g, ""))) return ["sh", "-c", command];
  const words: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let hasWord = false;
  for (let i = 0; i < command.length; i++) {
    const char = command[i] as string;
    if (quote !== null) {
      if (char === quote) quote = null;
      else if (char === "\\" && quote === '"' && i + 1 < command.length) current += command[++i];
      else current += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      hasWord = true;
    } else if (char === "\\" && i + 1 < command.length) {
      current += command[++i];
      hasWord = true;
    } else if (/\s/.test(char)) {
      if (hasWord) words.push(current);
      current = "";
      hasWord = false;
    } else {
      current += char;
      hasWord = true;
    }
  }
  if (quote !== null) return ["sh", "-c", command];
  if (hasWord) words.push(current);
  return words;
}
