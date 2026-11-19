import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Git } from "@orzeus/git";
import { type LanguageId, languageOf } from "./languages.js";
import { type CodeSymbol, extractSymbols } from "./symbols.js";

export interface RepoFile {
  readonly path: string;
  readonly language: LanguageId | null;
  readonly bytes: number;
  readonly lines: number;
  readonly symbols: readonly CodeSymbol[];
}

export interface RepoMap {
  readonly root: string;
  readonly files: readonly RepoFile[];
}

const MAX_PARSE_BYTES = 256_000;

/** Every tracked (and untracked, not ignored) file, with symbols for supported languages. */
export async function buildRepoMap(git: Git, root: string): Promise<RepoMap> {
  const listed = await git.run(root, [
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
  ]);
  const paths = [...new Set(listed.split("\0").filter((p) => p !== ""))].sort();
  const files: RepoFile[] = [];
  for (const path of paths) {
    const absolute = join(root, path);
    // lstat: a symbolic link (even one committed to the repository) is never followed, so the
    // map cannot pull in files from outside the repository.
    const info = await lstat(absolute).catch(() => null);
    if (info === null || !info.isFile()) continue;
    const language = languageOf(path);
    let symbols: CodeSymbol[] = [];
    let lines = 0;
    if (info.size <= MAX_PARSE_BYTES) {
      const text = await readFile(absolute, "utf8").catch(() => "");
      lines = text === "" ? 0 : text.split("\n").length;
      if (language !== null) symbols = await extractSymbols(language, text).catch(() => []);
    }
    files.push({ path, language, bytes: info.size, lines, symbols });
  }
  return { root, files };
}

/**
 * Compact text for the planner: one line per file, with its symbols and line ranges. Stops at
 * `maxChars`, saying how many files were left out, so the prompt size is predictable.
 */
export function renderRepoMap(map: RepoMap, maxChars = 12_000): string {
  const lines: string[] = [];
  let used = 0;
  let omitted = 0;
  for (const file of map.files) {
    const symbols = file.symbols
      .map((s) => `${s.kind} ${s.name} ${s.startLine}-${s.endLine}`)
      .join("; ");
    const line = `${file.path} (${file.lines} lines)${symbols === "" ? "" : `: ${symbols}`}`;
    if (used + line.length + 1 > maxChars) {
      omitted++;
      continue;
    }
    lines.push(line);
    used += line.length + 1;
  }
  if (omitted > 0) lines.push(`… ${omitted} more files not shown`);
  return lines.join("\n");
}
