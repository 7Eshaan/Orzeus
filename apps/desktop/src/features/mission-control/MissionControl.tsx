import { useState } from "react";
import { useEngineClient } from "../../app/context.tsx";
import { useLive } from "../../app/live.ts";
import { tokens, usd } from "../../lib/format.ts";
import { Button, Empty, Pill, StatusPill } from "../../ui/components.tsx";
import { DagGraph } from "./DagGraph.tsx";
import { GoalBar } from "./GoalBar.tsx";
import styles from "./mission.module.css";
import { PlanReview } from "./PlanReview.tsx";

interface Props {
  readonly runId: string | null;
  readonly onRun: (id: string) => void;
  readonly onOpenApprovals: () => void;
}

/** Mission Control: start a run from a goal, review its plan, and watch it execute. */
export function MissionControl({ runId, onRun, onOpenApprovals }: Props) {
  const client = useEngineClient();
  const run = useLive(
    client === null || runId === null ? null : () => client.request("runs.get", { runId }),
    [runId],
  );
  const approvals = useLive(
    client === null ? null : () => client.request("approvals.list", {}),
    [],
    ["approvals.changed"],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (runId === null) return <GoalBar onStarted={onRun} />;
  const detail = run.data;
  if (detail === null)
    return run.error === null ? (
      <p aria-busy="true">Loading run…</p>
    ) : (
      <Empty title="Run unavailable">{run.error}</Empty>
    );

  const act = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      run.refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  const waiting = (approvals.data ?? []).filter((g) => g.runId === runId);
  const running = detail.nodeViews.filter((n) =>
    ["running", "verifying", "awaiting_approval"].includes(n.status),
  );
  const resumable =
    !detail.active &&
    ["executing", "paused", "integrating", "reviewing", "awaiting_merge_approval"].includes(
      detail.status,
    );

  return (
    <div className={styles.mission}>
      <header className={styles.runHeader}>
        <div>
          <h1 className={styles.goal}>{detail.goal}</h1>
          <p className={styles.meta}>
            <StatusPill status={detail.status} /> {detail.repo.root} · {detail.succeeded}/
            {detail.nodes} nodes · {tokens(detail.totals.workerTokens)} worker /{" "}
            {tokens(detail.totals.frontierTokens)} frontier tokens
            {detail.totals.costMicroUsd > 0 ? ` · ${usd(detail.totals.costMicroUsd)}` : ""}
          </p>
        </div>
        <div className={styles.actions}>
          {waiting.length > 0 && (
            <Button variant="primary" onClick={onOpenApprovals}>
              {waiting.length} waiting for you
            </Button>
          )}
          {resumable && (
            <Button
              disabled={busy}
              onClick={() =>
                act(() => client?.request("runs.resume", { runId }) ?? Promise.resolve())
              }
            >
              Resume
            </Button>
          )}
        </div>
      </header>
      {error !== null && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}

      {detail.status === "planning" && (
        <Empty title="Planning…">
          The frontier model is reading the repository and writing a plan.
        </Empty>
      )}

      {detail.awaitingPlanApproval && detail.dag !== null && (
        <PlanReview
          dag={detail.dag}
          busy={busy}
          onApprove={() =>
            act(() => client?.request("runs.approvePlan", { runId }) ?? Promise.resolve())
          }
        />
      )}

      {!detail.awaitingPlanApproval && detail.nodeViews.length > 0 && (
        <>
          <section aria-label="Workers" className={styles.pills}>
            {running.length === 0 ? (
              <span className={styles.idle}>
                {detail.active ? "Between tasks…" : "No workers running."}
              </span>
            ) : (
              running.map((n) => (
                <Pill key={n.id} tone={n.status === "awaiting_approval" ? "attention" : "active"}>
                  {n.id} · {n.model?.model ?? "?"} · attempt {n.attempt}
                </Pill>
              ))
            )}
          </section>
          <DagGraph nodes={detail.nodeViews} />
          <NodeTable nodes={detail.nodeViews} />
        </>
      )}
    </div>
  );
}

function NodeTable({ nodes }: { readonly nodes: Parameters<typeof DagGraph>[0]["nodes"] }) {
  return (
    <table className={styles.table}>
      <caption className="visually-hidden">Nodes</caption>
      <thead>
        <tr>
          <th scope="col">Node</th>
          <th scope="col">Status</th>
          <th scope="col">Attempts</th>
          <th scope="col">Tokens</th>
          <th scope="col">Result</th>
        </tr>
      </thead>
      <tbody>
        {nodes.map((n) => (
          <tr key={n.id}>
            <td>
              <strong>{n.id}</strong>
              <div className={styles.sub}>{n.title}</div>
            </td>
            <td>
              <StatusPill status={n.status} />
            </td>
            <td>
              {n.attempt}
              {n.steers > 0 ? ` (${n.steers} steered)` : ""}
            </td>
            <td>{tokens(n.usage.inputTokens + n.usage.outputTokens)}</td>
            <td className={styles.sub}>
              {n.lastError
                ? `${n.lastError.errorClass}: ${n.lastError.message}`
                : (n.summary ?? "")}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
