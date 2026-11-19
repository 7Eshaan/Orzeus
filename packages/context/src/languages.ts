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

/** The wasm files the repo map needs, by the names a packaged build stores them under. */
export const WASM_FILES: Readonly<Record<string, string>> = {
  "web-tree-sitter.wasm": "web-tree-sitter/web-tree-sitter.wasm",
  ...Object.fromEntries(Object.values(GRAMMARS).map((path) => [path.split("/").at(-1), path])),
};

/** Where wasm comes from: node_modules by default; a packaged engine embeds the files instead. */
export interface WasmSource {
  /** Bytes of a file named in WASM_FILES, or null to load it from node_modules. */
  read(name: string): Uint8Array | null;
}

let source: WasmSource = { read: () => null };

/** Packaged builds call this once, before the first parse. */
export function setWasmSource(next: WasmSource): void {
  source = next;
}

const fileName = (path: string) => path.split("/").at(-1) ?? path;

let ready: Promise<void> | null = null;
const loaded = new Map<LanguageId, Promise<Language>>();

/** A parser for the language. Grammars load lazily, once per process. */
export async function parserFor(language: LanguageId): Promise<Parser> {
  ready ??= (() => {
    const runtime = source.read("web-tree-sitter.wasm");
    return runtime === null ? Parser.init() : Parser.init({ wasmBinary: runtime.slice().buffer });
  })();
  await ready;
  let grammar = loaded.get(language);
  if (grammar === undefined) {
    const path = GRAMMARS[language];
    grammar = Language.load(source.read(fileName(path)) ?? require.resolve(path));
    loaded.set(language, grammar);
  }
  const parser = new Parser();
  parser.setLanguage(await grammar);
  return parser;
}
