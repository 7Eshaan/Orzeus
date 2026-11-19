import type { TaskDAG } from "@orzeus/schema";
import { useState } from "react";
import { useEngineClient } from "../../app/context.tsx";
import { useLive } from "../../app/live.ts";
import { Button, Panel } from "../../ui/components.tsx";
import styles from "./mission.module.css";
import { PlanEditor } from "./PlanEditor.tsx";

/** The proposed plan, node by node, with the decision that starts everything (or an edit first). */
export function PlanReview({
  runId,
  dag,
  busy,
  onApprove,
  onRevised,
}: {
  readonly runId: string;
  readonly dag: TaskDAG;
  readonly busy: boolean;
  readonly onApprove: () => void;
  readonly onRevised: () => void;
}) {
  const client = useEngineClient();
  // Reload when the revision changes, so the review always shows what will be approved.
  const plan = useLive(client === null ? null : () => client.request("runs.plan", { runId }), [
    runId,
    dag.revision,
  ]);
  const [editing, setEditing] = useState(false);
  const details = new Map((plan.data?.nodes ?? []).map((n) => [n.id, n]));

  if (editing && plan.data !== null && plan.data.revision === dag.revision)
    return (
      <PlanEditor
        runId={runId}
        plan={plan.data}
        onDone={() => {
          setEditing(false);
          onRevised();
        }}
      />
    );

  return (
    <Panel>
      <div className={styles.planHeader}>
        <h2>
          Plan · {dag.nodes.length} nodes
          {dag.revision > 1 && <span className={styles.sub}> · revision {dag.revision}</span>}
        </h2>
        <div className={styles.actions}>
          <Button onClick={() => setEditing(true)} disabled={busy || plan.data === null}>
            Edit plan
          </Button>
          <Button variant="primary" onClick={onApprove} disabled={busy}>
            Approve and start
          </Button>
        </div>
      </div>
      <ol className={styles.planList}>
        {dag.nodes.map((n) => {
          const d = details.get(n.id);
          return (
            <li key={n.id}>
              <h3>
                {n.id} <span className={styles.sub}>· {n.title}</span>
              </h3>
              {d !== undefined && <p className={styles.objective}>{d.objective}</p>}
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
                {d !== undefined && (
                  <>
                    <dt>Tools</dt>
                    <dd>{d.mcp.map((g) => `${g.server}/${g.tool}`).join(", ") || "—"}</dd>
                  </>
                )}
              </dl>
            </li>
          );
        })}
      </ol>
    </Panel>
  );
}
