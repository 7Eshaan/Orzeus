import { createRequire } from "node:module";
import { extname } from "node:path";
import { Language, Parser } from "web-tree-sitter";

export type LanguageId = "typescript" | "tsx" | "javascript" | "python";

const require = createRequire(import.meta.url);

const GRAMMARS: Readonly<Record<LanguageId, string>> = {
  typescript: "tree-sitter-typescript/tree-sitter-typescript.wasm",
  tsx: "tree-sitter-typescript/tree-sitter-tsx.wasm",
  javascript: "tree-sitter-javascript/tree-sitter-javascript.wasm",
  python: "tree-sitter-python/tree-sitter-python.wasm",
};

const EXTENSIONS: Readonly<Record<string, LanguageId>> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascript",
  ".py": "python",
};

export function languageOf(path: string): LanguageId | null {
  return EXTENSIONS[extname(path).toLowerCase()] ?? null;
}

let ready: Promise<void> | null = null;
const loaded = new Map<LanguageId, Promise<Language>>();

/** A parser for the language. Grammars load lazily, once per process. */
export async function parserFor(language: LanguageId): Promise<Parser> {
  ready ??= Parser.init();
  await ready;
  let grammar = loaded.get(language);
  if (grammar === undefined) {
    grammar = Language.load(require.resolve(GRAMMARS[language]));
    loaded.set(language, grammar);
  }
  const parser = new Parser();
  parser.setLanguage(await grammar);
  return parser;
}
