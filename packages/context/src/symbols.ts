import type { Node } from "web-tree-sitter";
import { type LanguageId, parserFor } from "./languages.js";

export type SymbolKind = "function" | "method" | "class" | "interface" | "type" | "const";

export interface CodeSymbol {
  /** Qualified for members, e.g. "AuthService.refresh". */
  readonly name: string;
  readonly kind: SymbolKind;
  /** 1-based, inclusive. */
  readonly startLine: number;
  readonly endLine: number;
  readonly exported: boolean;
}

const nameOf = (node: Node): string | null => node.childForFieldName("name")?.text ?? null;

function push(
  out: CodeSymbol[],
  node: Node,
  name: string | null,
  kind: SymbolKind,
  exported: boolean,
): void {
  if (name === null || name === "") return;
  out.push({
    name,
    kind,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    exported,
  });
}

function collectJs(
  node: Node,
  out: CodeSymbol[],
  exported: boolean,
  container: string | null,
): void {
  switch (node.type) {
    case "export_statement":
      for (const child of node.namedChildren)
        if (child !== null) collectJs(child, out, true, container);
      return;
    case "function_declaration":
    case "generator_function_declaration":
      push(out, node, nameOf(node), "function", exported);
      return;
    case "class_declaration":
    case "abstract_class_declaration": {
      const name = nameOf(node);
      push(out, node, name, "class", exported);
      const body = node.childForFieldName("body");
      for (const member of body?.namedChildren ?? []) {
        if (
          member !== null &&
          member.type === "method_definition" &&
          name !== null &&
          nameOf(member) !== "constructor"
        )
          push(out, member, `${name}.${nameOf(member) ?? ""}`, "method", exported);
      }
      return;
    }
    case "interface_declaration":
      push(out, node, nameOf(node), "interface", exported);
      return;
    case "type_alias_declaration":
    case "enum_declaration":
      push(out, node, nameOf(node), "type", exported);
      return;
    case "lexical_declaration":
    case "variable_declaration":
      for (const declarator of node.namedChildren) {
        if (declarator === null || declarator.type !== "variable_declarator") continue;
        const value = declarator.childForFieldName("value");
        const isFunction =
          value !== null &&
          ["arrow_function", "function_expression", "function"].includes(value.type);
        if (isFunction || exported)
          push(out, node, nameOf(declarator), isFunction ? "function" : "const", exported);
      }
      return;
    default:
      return;
  }
}

function collectPython(node: Node, out: CodeSymbol[], container: string | null): void {
  if (node.type === "decorated_definition") {
    const inner = node.childForFieldName("definition");
    if (inner !== null) collectPython(inner, out, container);
    return;
  }
  if (node.type === "function_definition") {
    const name = nameOf(node);
    push(
      out,
      node,
      container === null ? name : `${container}.${name ?? ""}`,
      container === null ? "function" : "method",
      !name?.startsWith("_"),
    );
  } else if (node.type === "class_definition") {
    const name = nameOf(node);
    push(out, node, name, "class", !name?.startsWith("_"));
    for (const child of node.childForFieldName("body")?.namedChildren ?? [])
      if (child !== null) collectPython(child, out, name);
  }
}

/** Top-level symbols (and class members) with line ranges. */
export async function extractSymbols(language: LanguageId, source: string): Promise<CodeSymbol[]> {
  const parser = await parserFor(language);
  const tree = parser.parse(source);
  const out: CodeSymbol[] = [];
  try {
    for (const node of tree?.rootNode.namedChildren ?? []) {
      if (node === null) continue;
      if (language === "python") collectPython(node, out, null);
      else collectJs(node, out, false, null);
    }
  } finally {
    tree?.delete();
    parser.delete();
  }
  return out;
}
