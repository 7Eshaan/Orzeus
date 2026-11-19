import type { TaskDAG } from "@orzeus/schema";
import { Button, Panel } from "../../ui/components.tsx";
import styles from "./mission.module.css";

/** The proposed plan, node by node, with the one decision that starts everything. */
export function PlanReview({
  dag,
  busy,
  onApprove,
}: {
  readonly dag: TaskDAG;
  readonly busy: boolean;
  readonly onApprove: () => void;
}) {
  return (
    <Panel>
      <div className={styles.planHeader}>
        <h2>Plan · {dag.nodes.length} nodes</h2>
        <Button variant="primary" onClick={onApprove} disabled={busy}>
          Approve and start
        </Button>
      </div>
      <ol className={styles.planList}>
        {dag.nodes.map((n) => (
          <li key={n.id}>
            <h3>
              {n.id} <span className={styles.sub}>· {n.title}</span>
            </h3>
            <dl className={styles.facts}>
              <dt>Writes</dt>
              <dd>{n.writeScope.join(", ") || "nothing (read-only)"}</dd>
              <dt>After</dt>
              <dd>{n.dependsOn.join(", ") || "—"}</dd>
              <dt>Checks</dt>
              <dd>
                {n.checks
                  .map((c) => (c.kind === "command" ? c.argv.join(" ") : c.label))
                  .join("; ") || "—"}
              </dd>
              <dt>Worker</dt>
              <dd>{n.candidates.map((c) => `${c.adapter}/${c.model}`).join(", ")}</dd>
            </dl>
          </li>
        ))}
      </ol>
    </Panel>
  );
}
