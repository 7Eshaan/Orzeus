import type { NodeView } from "@orzeus/protocol";
import { Background, type Edge, MarkerType, type Node, Position, ReactFlow } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useMemo } from "react";
import { statusLabel, statusTone } from "../../lib/format.ts";
import { layoutDag } from "../../lib/layout.ts";
import styles from "./mission.module.css";

/** The live plan: one card per node, coloured by status, edges for dependencies. */
export function DagGraph({ nodes }: { readonly nodes: readonly NodeView[] }) {
  const { flowNodes, flowEdges } = useMemo(() => {
    const placed = new Map(layoutDag(nodes).map((p) => [p.id, p]));
    const flowNodes: Node[] = nodes.map((n) => ({
      id: n.id,
      position: { x: placed.get(n.id)?.x ?? 0, y: placed.get(n.id)?.y ?? 0 },
      data: {
        label: (
          <div className={styles.card} data-tone={statusTone(n.status)}>
            <strong>{n.id}</strong>
            <span>{statusLabel(n.status)}</span>
            {n.attempt > 1 && <span className={styles.sub}>attempt {n.attempt}</span>}
          </div>
        ),
      },
      draggable: false,
      connectable: false,
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
      ariaLabel: `${n.id}: ${statusLabel(n.status)}`,
      className: styles.flowNode ?? "",
    }));
    const flowEdges: Edge[] = nodes.flatMap((n) =>
      n.dependsOn.map((d) => ({
        id: `${d}->${n.id}`,
        source: d,
        target: n.id,
        animated: ["running", "verifying"].includes(n.status),
        markerEnd: { type: MarkerType.ArrowClosed },
      })),
    );
    return { flowNodes, flowEdges };
  }, [nodes]);

  return (
    <figure className={styles.graph} aria-label="Plan graph">
      <ReactFlow
        nodes={flowNodes}
        edges={flowEdges}
        fitView
        fitViewOptions={{ padding: 0.25 }}
        nodesDraggable={false}
        nodesConnectable={false}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={24} size={1} color="#d9d6cf" bgColor="#ffffff" />
      </ReactFlow>
    </figure>
  );
}
