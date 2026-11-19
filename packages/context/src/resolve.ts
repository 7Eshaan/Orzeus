import { readFile, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import { normalizeRelativePath } from "@orzeus/core";
import type { ContextRef } from "@orzeus/schema";
import { languageOf } from "./languages.js";
import { extractSymbols } from "./symbols.js";

export interface ResolvedContext {
  readonly title: string;
  readonly text: string;
  readonly path: string | null;
  readonly startLine: number | null;
  readonly endLine: number | null;
}

export class ContextResolutionError extends Error {
  override readonly name = "ContextResolutionError";
}

const numbered = (lines: readonly string[], first: number): string =>
  lines.map((line, i) => `${String(first + i).padStart(5)}  ${line}`).join("\n");

/**
 * Resolves a file_range or symbol pointer to exact, line-numbered code from the worktree.
 * Memory and MCP resource pointers are resolved by the gateway, which owns those connections.
 */
export async function resolveContextRef(
  ref: ContextRef,
  worktree: string,
): Promise<ResolvedContext> {
  if (ref.kind !== "file_range" && ref.kind !== "symbol") {
    throw new ContextResolutionError(`${ref.kind} pointers are resolved by the gateway`);
  }
  const path = normalizeRelativePath(ref.path);
  if (path === null) throw new ContextResolutionError(`${ref.path} is outside the repository`);
  const full = join(worktree, path);
  const [real, root] = await Promise.all([
    realpath(full).catch(() => {
      throw new ContextResolutionError(`${path} does not exist in this worktree`);
    }),
    realpath(worktree),
  ]);
  if (real !== root && !real.startsWith(`${root}${sep}`))
    throw new ContextResolutionError(
      `${path} leads outside the repository through a symbolic link`,
    );
  const text = await readFile(real, "utf8").catch(() => {
    throw new ContextResolutionError(`${path} does not exist in this worktree`);
  });
  const lines = text.split("\n");

  if (ref.kind === "file_range") {
    const start = Math.max(1, Math.min(ref.startLine, lines.length));
    const end = Math.max(start, Math.min(ref.endLine, lines.length));
    return {
      title: `${path}:${start}-${end}`,
      text: numbered(lines.slice(start - 1, end), start),
      path,
      startLine: start,
      endLine: end,
    };
  }

  const language = languageOf(path);
  if (language === null) throw new ContextResolutionError(`no symbol index for ${path}`);
  const symbols = await extractSymbols(language, text);
  const symbol =
    symbols.find((s) => s.name === ref.symbol) ??
    symbols.find(
      (s) => s.name.endsWith(`.${ref.symbol}`) || s.name === ref.symbol.split(".").at(-1),
    );
  if (symbol === undefined)
    throw new ContextResolutionError(`symbol ${ref.symbol} not found in ${path}`);
  return {
    title: `${symbol.kind} ${symbol.name} (${path}:${symbol.startLine}-${symbol.endLine})`,
    text: numbered(lines.slice(symbol.startLine - 1, symbol.endLine), symbol.startLine),
    path,
    startLine: symbol.startLine,
    endLine: symbol.endLine,
  };
}
