import { useEffect, useState } from "react";
import { useEngineClient } from "../../app/context.tsx";
import { useLive } from "../../app/live.ts";
import { countdown, tokens } from "../../lib/format.ts";
import styles from "./shell.module.css";

/** At-a-glance usage: each account's windows, routing, and the frontier tokens workers saved. */
export function QuotaStrip() {
  const client = useEngineClient();
  const quota = useLive(
    client === null ? null : () => client.request("quota.read", {}),
    [],
    ["run.updated", "quota.changed"],
    60_000,
  );
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  const q = quota.data;
  if (q === null) return <div className={styles.quota} aria-busy="true" />;
  const windows = q.accounts.flatMap((a) =>
    a.windows.map((w) => ({ ...w, label: a.label, cap: a.softCaps[w.window] ?? null })),
  );

  return (
    <section className={styles.quota} aria-label="Usage and quota">
      {windows.map((w) => (
        <div
          key={`${w.accountId}-${w.window}`}
          className={styles.meter}
          title={`${w.label} ${w.window} window (${w.source.replaceAll("_", " ")})${w.cap === null ? "" : `; new work pauses at ${w.cap}%`}`}
        >
          <span className={styles.meterLabel}>
            {w.label} · {w.window}
          </span>
          <span className={styles.bar} aria-hidden="true">
            <span
              className={styles.fill}
              data-status={w.status}
              style={{ width: `${w.usedPercent ?? 0}%` }}
            />
            {w.cap !== null && <span className={styles.cap} style={{ left: `${w.cap}%` }} />}
          </span>
          <span className={styles.meterValue}>
            {w.usedPercent ?? "?"}%<span className="visually-hidden"> used</span>
            {w.cap !== null && <span className="visually-hidden">, limit {w.cap}%</span>}
            {w.resetsAt !== null ? ` · resets in ${countdown(w.resetsAt, now)}` : ""}
          </span>
        </div>
      ))}
      <div className={styles.stat}>
        <span className={styles.meterLabel}>Frontier</span>
        <span className={styles.statValue}>{tokens(q.totals.frontierTokens)} tokens</span>
      </div>
      <div
        className={styles.stat}
        title="Tokens handled by worker models instead of the frontier model (estimate)"
      >
        <span className={styles.meterLabel}>Frontier quota saved</span>
        <span className={styles.statValue}>{tokens(q.totals.frontierTokensAvoided)} tokens</span>
      </div>
      <div className={styles.stat}>
        <span className={styles.meterLabel}>Routing</span>
        <span className={styles.statValue}>
          {q.routing.planner ?? "no planner"} → {q.routing.worker}
        </span>
      </div>
    </section>
  );
}
