export interface LayoutNode {
  readonly id: string;
  readonly dependsOn: readonly string[];
}

export interface Positioned {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly depth: number;
}

/**
 * Layered left-to-right layout for the plan DAG: a node's column is the length of the longest
 * dependency chain before it; rows keep plan order within a column, centred vertically.
 */
export function layoutDag(
  nodes: readonly LayoutNode[],
  colWidth = 260,
  rowHeight = 96,
): Positioned[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const depth = new Map<string, number>();
  const visit = (id: string, stack: Set<string>): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    if (stack.has(id)) return 0;
    stack.add(id);
    const deps = byId.get(id)?.dependsOn.filter((d) => byId.has(d)) ?? [];
    const d = deps.length === 0 ? 0 : Math.max(...deps.map((dep) => visit(dep, stack) + 1));
    stack.delete(id);
    depth.set(id, d);
    return d;
  };
  for (const n of nodes) visit(n.id, new Set());
  const columns = new Map<number, string[]>();
  for (const n of nodes) {
    const d = depth.get(n.id) ?? 0;
    columns.set(d, [...(columns.get(d) ?? []), n.id]);
  }
  const tallest = Math.max(1, ...[...columns.values()].map((c) => c.length));
  return nodes.map((n) => {
    const d = depth.get(n.id) ?? 0;
    const column = columns.get(d) ?? [];
    const row = column.indexOf(n.id);
    const offset = ((tallest - column.length) * rowHeight) / 2;
    return { id: n.id, x: d * colWidth, y: offset + row * rowHeight, depth: d };
  });
}
