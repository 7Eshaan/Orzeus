import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { normalizeRelativePath } from "@orzeus/core";
import type { ToolAllowlist } from "@orzeus/schema";
import { safeWorktreePath } from "../../paths.js";

/** JSON-schema tool definitions in the OpenAI chat-completions format. */
export interface ToolDefinition {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Readonly<Record<string, unknown>>;
  };
}

const tool = (
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
): ToolDefinition => ({
  type: "function",
  function: {
    name,
    description,
    parameters: { type: "object", properties, required, additionalProperties: false },
  },
});

const pathProp = {
  type: "string",
  description: "Path relative to the repository root, e.g. src/index.ts",
};

export const FINISH = tool(
  "finish",
  "Call when the task is complete.",
  { summary: { type: "string", description: "One to three sentences on what you changed." } },
  ["summary"],
);
export const REPORT_AMBIGUITY = tool(
  "report_ambiguity",
  "Call instead of guessing when the task cannot be done without a decision from a human or the planner.",
  { question: { type: "string" } },
  ["question"],
);
const LIST_FILES = tool(
  "list_files",
  "List files under a directory (recursive, at most 500).",
  { path: { ...pathProp, description: "Directory; use . for the root." } },
  ["path"],
);
const READ_FILE = tool(
  "read_file",
  "Read a text file, optionally a line range.",
  {
    path: pathProp,
    start_line: { type: "integer", minimum: 1 },
    end_line: { type: "integer", minimum: 1 },
  },
  ["path"],
);
const WRITE_FILE = tool(
  "write_file",
  "Create or overwrite a file with the full new content.",
  { path: pathProp, content: { type: "string" } },
  ["path", "content"],
);
const DELETE_FILE = tool("delete_file", "Delete a file.", { path: pathProp }, ["path"]);

/** Tools offered to the model, following the packet's built-in grants. */
export function toolsFor(allowlist: ToolAllowlist): ToolDefinition[] {
  const kinds = new Set(allowlist.builtin.map((g) => g.kind));
  return [
    ...(kinds.has("read_files") || kinds.has("edit_files") ? [LIST_FILES, READ_FILE] : []),
    ...(kinds.has("edit_files") ? [WRITE_FILE, DELETE_FILE] : []),
    REPORT_AMBIGUITY,
    FINISH,
  ];
}

/**
 * Worktree-relative path from model input. Models often write "/src/x.ts" meaning the repo
 * root, so one leading slash is treated as the root. Returns null if it escapes the worktree.
 */
export function toWorktreePath(input: unknown): string | null {
  if (typeof input !== "string" || input.trim() === "") return null;
  return normalizeRelativePath(input.trim().replace(/^\/+/, ""));
}

const MAX_READ_CHARS = 200_000;
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "target"]);

export async function listFiles(worktree: string, relativeDir: string): Promise<string> {
  const results: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(await safeWorktreePath(worktree, dir || "."), {
      withFileTypes: true,
    })) {
      if (results.length >= 500) return;
      const path = dir === "" ? entry.name : `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(path);
      } else {
        results.push(path);
      }
    }
  };
  await walk(relativeDir);
  return results.sort().join("\n") || "(empty)";
}

export async function readText(
  worktree: string,
  path: string,
  start?: number,
  end?: number,
): Promise<string> {
  const absolute = await safeWorktreePath(worktree, path);
  if ((await stat(absolute)).size > MAX_READ_CHARS * 4)
    return `${path} is too large to read whole; ask for a line range.`;
  const text = await readFile(absolute, "utf8");
  if (start === undefined && end === undefined) return text.slice(0, MAX_READ_CHARS);
  const lines = text.split("\n");
  return lines.slice((start ?? 1) - 1, end ?? lines.length).join("\n");
}

export async function writeText(worktree: string, path: string, content: string): Promise<void> {
  const absolute = await safeWorktreePath(worktree, path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, content);
}

export async function deleteFile(worktree: string, path: string): Promise<void> {
  await rm(await safeWorktreePath(worktree, path));
}
