import type { View } from "../../app/App.tsx";
import { useEngineClient, useEngineStatus } from "../../app/context.tsx";
import { useLive } from "../../app/live.ts";
import { ago } from "../../lib/format.ts";
import { StatusPill } from "../../ui/components.tsx";
import styles from "./shell.module.css";

const NAV: readonly { view: View; label: string; key: string }[] = [
  { view: "mission", label: "Mission Control", key: "1" },
  { view: "approvals", label: "Approvals", key: "2" },
  { view: "trace", label: "Trace", key: "3" },
  { view: "settings", label: "Settings", key: "4" },
];

export function Sidebar({
  view,
  onView,
  runId,
  onRun,
}: {
  readonly view: View;
  readonly onView: (v: View) => void;
  readonly runId: string | null;
  readonly onRun: (id: string | null) => void;
}) {
  const client = useEngineClient();
  const status = useEngineStatus();
  const runs = useLive(client === null ? null : () => client.request("runs.list", {}), []);
  const approvals = useLive(
    client === null ? null : () => client.request("approvals.list", {}),
    [],
    ["approvals.changed"],
  );
  const pending = approvals.data?.length ?? 0;
  const now = Date.now();

  return (
    <nav className={styles.sidebar} aria-label="Orzeus">
      <div className={styles.brand} data-tauri-drag-region>
        Orzeus
      </div>
      <ul className={styles.nav}>
        {NAV.map((item) => (
          <li key={item.view}>
            <button
              type="button"
              className={styles.navItem}
              aria-current={view === item.view ? "page" : undefined}
              onClick={() => onView(item.view)}
              title={`⌘${item.key}`}
            >
              <span>{item.label}</span>
              {item.view === "approvals" && pending > 0 && (
                <span className={styles.badge}>
                  {pending}
                  <span className="visually-hidden"> waiting</span>
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>

      <div className={styles.runsHeader}>
        <span>Runs</span>
        <button
          type="button"
          className={styles.newRun}
          onClick={() => {
            onRun(null);
            onView("mission");
          }}
        >
          New
        </button>
      </div>
      <ul className={styles.runs} aria-label="Runs">
        {(runs.data ?? []).map((run) => (
          <li key={run.runId}>
            <button
              type="button"
              className={styles.run}
              aria-current={run.runId === runId ? "true" : undefined}
              onClick={() => onRun(run.runId)}
            >
              <span className={styles.runGoal}>{run.goal}</span>
              <span className={styles.runMeta}>
                <StatusPill status={run.status} />
                <span>{ago(run.updatedAt, now)}</span>
              </span>
            </button>
          </li>
        ))}
        {runs.data?.length === 0 && <li className={styles.noRuns}>No runs yet.</li>}
      </ul>

      <div className={styles.engine} role="status" aria-live="polite">
        <span className={styles.dot} data-state={status.state} aria-hidden="true" />
        {status.state === "running"
          ? "Engine ready"
          : status.state === "starting"
            ? "Starting engine…"
            : status.state === "failed"
              ? `Engine failed: ${status.message}`
              : "Engine stopped, restarting…"}
      </div>
    </nav>
  );
}
