import type { PendingGate } from "@orzeus/protocol";
import { useEffect, useState } from "react";
import { useEngineClient } from "../../app/context.tsx";
import { useLive } from "../../app/live.ts";
import { ago } from "../../lib/format.ts";
import { Button, DiffView, Empty, inputClass, Pill } from "../../ui/components.tsx";
import styles from "./approvals.module.css";

function describeAction(gate: PendingGate): string {
  const a = gate.action;
  switch (a.kind) {
    case "shell":
      return `Run: ${a.argv.join(" ")}`;
    case "file_write":
      return `Write ${a.path}`;
    case "file_delete":
      return `Delete ${a.path}`;
    case "mcp_call":
      return `${a.access === "write" ? "Change" : "Read"} via ${a.server}/${a.tool}`;
    case "network":
      return `Reach ${a.host}`;
    case "merge":
      return `Merge ${a.from} into ${a.into}`;
    case "budget_threshold":
      return `Spend past ${Math.round(a.fraction * 100)}% of the run budget`;
    case "plan_approval":
      return "Approve the plan";
    case "rollback":
      return `Roll back to ${a.toCheckpoint}`;
  }
}

/** Everything waiting for a human, oldest first, with one-key decisions. */
export function ApprovalQueue({ onOpenRun }: { readonly onOpenRun: (runId: string) => void }) {
  const client = useEngineClient();
  const gates = useLive(
    client === null ? null : () => client.request("approvals.list", {}),
    [],
    ["approvals.changed"],
  );
  const [selected, setSelected] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const list = [...(gates.data ?? [])].sort((a, b) => a.requestedAt - b.requestedAt);
  const current = list.find((g) => g.id === selected) ?? list[0] ?? null;

  const answer = async (decision: "approve" | "reject" | "steer") => {
    if (client === null || current === null) return;
    if (decision === "steer" && note.trim() === "") {
      setError("Write the guidance first.");
      return;
    }
    setError(null);
    try {
      await client.request("approvals.answer", {
        id: current.id,
        decision,
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      setNote("");
      setSelected(null);
      gates.refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        event.metaKey ||
        event.ctrlKey ||
        ["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName ?? "")
      )
        return;
      if (event.key === "a") void answer("approve");
      if (event.key === "r") void answer("reject");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (list.length === 0)
    return (
      <Empty title="Nothing needs you">Approvals, merges and budget questions show up here.</Empty>
    );
  const now = Date.now();
  return (
    <div className={styles.queue}>
      <ul className={styles.list} aria-label="Waiting for you">
        {list.map((g) => (
          <li key={g.id}>
            <button
              type="button"
              className={styles.item}
              aria-current={g.id === current?.id ? "true" : undefined}
              onClick={() => setSelected(g.id)}
            >
              <span>{describeAction(g)}</span>
              <span className={styles.itemMeta}>
                {g.nodeId ?? "run"} · {ago(g.requestedAt, now)}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {current !== null && (
        <section className={styles.detail} aria-labelledby="gate-title">
          <header className={styles.detailHeader}>
            <div>
              <h1 id="gate-title" className={styles.title}>
                {describeAction(current)}
              </h1>
              <p className={styles.reason}>
                <Pill tone="attention">{current.action.kind.replaceAll("_", " ")}</Pill>{" "}
                {current.reason}
              </p>
            </div>
            <Button variant="quiet" onClick={() => onOpenRun(current.runId)}>
              Open run
            </Button>
          </header>
          {current.diff !== null && <DiffView patch={current.diff} />}
          <label htmlFor="steer" className="visually-hidden">
            Note or guidance
          </label>
          <textarea
            id="steer"
            className={inputClass}
            rows={3}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Optional note. For Steer: what the worker should do instead."
          />
          {error !== null && (
            <p role="alert" className={styles.error}>
              {error}
            </p>
          )}
          <div className={styles.buttons}>
            <Button variant="primary" onClick={() => answer("approve")}>
              Approve <kbd>A</kbd>
            </Button>
            <Button variant="danger" onClick={() => answer("reject")}>
              Reject <kbd>R</kbd>
            </Button>
            {current.nodeId !== null && <Button onClick={() => answer("steer")}>Steer</Button>}
          </div>
        </section>
      )}
    </div>
  );
}
