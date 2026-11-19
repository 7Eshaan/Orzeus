import { parseTraceEvent, type TraceEvent } from "@orzeus/schema";
import { useMemo, useState } from "react";
import { useEngineClient } from "../../app/context.tsx";
import { useLive } from "../../app/live.ts";
import { clock, tokens } from "../../lib/format.ts";
import { describe, type EventGroup, groupOf, tokenBreakdown } from "../../lib/trace.ts";
import { Button, DiffView, Empty, inputClass, Panel } from "../../ui/components.tsx";
import styles from "./trace.module.css";

const GROUPS: readonly EventGroup[] = [
  "run",
  "plan",
  "node",
  "model",
  "tool",
  "check",
  "approval",
  "budget",
];

/** Filterable timeline of a run's hash-chained events, with the content behind each one. */
export function TraceInspector({ runId }: { readonly runId: string | null }) {
  const client = useEngineClient();
  const run = useLive(
    client === null || runId === null ? null : () => client.request("runs.get", { runId }),
    [runId],
  );
  const raw = useLive(
    client === null || runId === null
      ? null
      : () => client.request("runs.events", { runId, limit: 5_000 }),
    [runId],
  );
  const events = useMemo(
    () =>
      (raw.data ?? []).flatMap((e) => {
        const parsed = parseTraceEvent(e);
        return parsed.ok ? [parsed.value] : [];
      }),
    [raw.data],
  );
  const [groups, setGroups] = useState<ReadonlySet<EventGroup>>(new Set(GROUPS));
  const [node, setNode] = useState("");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  if (runId === null)
    return <Empty title="Pick a run">Choose a run in the sidebar to inspect its trace.</Empty>;
  const nodes = [
    ...new Set(events.map((e) => e.nodeId).filter((n): n is NonNullable<typeof n> => n !== null)),
  ];
  const visible = events.filter(
    (e) =>
      groups.has(groupOf(e.type)) &&
      (node === "" || e.nodeId === node) &&
      (query === "" || describe(e).toLowerCase().includes(query.toLowerCase())),
  );
  const current = events.find((e) => e.seq === selected) ?? null;

  const verify = async () => {
    const result = await client?.request("runs.verify", { runId });
    setMessage(result?.detail ?? null);
  };
  const exportAs = async (format: "jsonl" | "otlp") => {
    const result = await client?.request("runs.export", { runId, format });
    if (result === undefined) return;
    const url = URL.createObjectURL(new Blob([result.content], { type: result.mediaType }));
    const link = document.createElement("a");
    link.href = url;
    link.download = result.filename;
    link.click();
    URL.revokeObjectURL(url);
    setMessage(`Exported ${result.filename}.`);
  };
  const rollback = async (checkpointId: string, label: string) => {
    if (
      !window.confirm(`Roll back to "${label}"? Work after it is discarded (the trace keeps it).`)
    )
      return;
    try {
      await client?.request("runs.rollback", { runId, checkpointId });
      setMessage(`Rolled back to "${label}". Resume the run from Mission Control.`);
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : String(reason));
    }
  };

  return (
    <div className={styles.trace}>
      <div className={styles.toolbar}>
        <fieldset className={styles.groups}>
          <legend className="visually-hidden">Event types</legend>
          {GROUPS.map((g) => (
            <label key={g} className={styles.chip}>
              <input
                type="checkbox"
                checked={groups.has(g)}
                onChange={() => {
                  const next = new Set(groups);
                  if (next.has(g)) next.delete(g);
                  else next.add(g);
                  setGroups(next);
                }}
              />
              {g}
            </label>
          ))}
        </fieldset>
        <label className="visually-hidden" htmlFor="node-filter">
          Node
        </label>
        <select
          id="node-filter"
          className={inputClass}
          value={node}
          onChange={(e) => setNode(e.target.value)}
        >
          <option value="">All nodes</option>
          {nodes.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        <label className="visually-hidden" htmlFor="trace-search">
          Search
        </label>
        <input
          id="trace-search"
          className={inputClass}
          placeholder="Search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <Button onClick={verify}>Verify chain</Button>
        <Button onClick={() => exportAs("jsonl")}>Export JSONL</Button>
        <Button onClick={() => exportAs("otlp")}>Export OTLP</Button>
      </div>
      {message !== null && (
        <p role="status" className={styles.message}>
          {message}
        </p>
      )}

      <div className={styles.split}>
        <ol className={styles.timeline} aria-label="Events">
          {visible.map((e) => (
            <li key={e.seq}>
              <button
                type="button"
                className={styles.event}
                aria-current={e.seq === selected ? "true" : undefined}
                onClick={() => setSelected(e.seq)}
              >
                <span className={styles.seq}>{e.seq}</span>
                <span className={styles.time}>{clock(e.ts)}</span>
                <span className={styles.group} data-group={groupOf(e.type)}>
                  {e.nodeId ?? "run"}
                </span>
                <span className={styles.text}>{describe(e)}</span>
              </button>
            </li>
          ))}
        </ol>
        <div className={styles.side}>
          {current === null ? (
            <Summary
              events={events}
              checkpoints={run.data?.checkpoints ?? []}
              onRollback={
                run.data !== null && run.data.status !== "completed" && !run.data.active
                  ? rollback
                  : null
              }
            />
          ) : (
            <EventDetail event={current} onClose={() => setSelected(null)} />
          )}
        </div>
      </div>
    </div>
  );
}

function Summary({
  events,
  checkpoints,
  onRollback,
}: {
  readonly events: readonly TraceEvent[];
  readonly checkpoints: readonly { id: string; label: string; atSeq: number }[];
  readonly onRollback: ((id: string, label: string) => void) | null;
}) {
  const rows = tokenBreakdown(events);
  return (
    <>
      <Panel>
        <h2 className={styles.h2}>Tokens</h2>
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">Purpose</th>
              <th scope="col">Model</th>
              <th scope="col">Calls</th>
              <th scope="col">In</th>
              <th scope="col">Out</th>
              <th scope="col">Cached</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.purpose}${r.model}`}>
                <td>
                  {r.purpose} <span className={styles.muted}>({r.tier})</span>
                </td>
                <td>{r.model}</td>
                <td>{r.calls}</td>
                <td>{tokens(r.input)}</td>
                <td>{tokens(r.output)}</td>
                <td>{tokens(r.cached)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
      <Panel>
        <h2 className={styles.h2}>Checkpoints</h2>
        <ul className={styles.checkpoints}>
          {checkpoints.map((c) => (
            <li key={c.id}>
              <span>
                {c.label} <span className={styles.muted}>· event {c.atSeq}</span>
              </span>
              {onRollback !== null && (
                <Button variant="quiet" onClick={() => onRollback(c.id, c.label)}>
                  Roll back here
                </Button>
              )}
            </li>
          ))}
        </ul>
      </Panel>
    </>
  );
}

function EventDetail({
  event,
  onClose,
}: {
  readonly event: TraceEvent;
  readonly onClose: () => void;
}) {
  const client = useEngineClient();
  const [blob, setBlob] = useState<{ hash: string; mediaType: string; text: string } | null>(null);
  const open = async (hash: string) => {
    const result = await client?.request("blobs.read", { hash, maxChars: 200_000 });
    if (result !== undefined) setBlob({ hash, mediaType: result.mediaType, text: result.text });
  };
  return (
    <Panel>
      <div className={styles.detailHeader}>
        <h2 className={styles.h2}>
          #{event.seq} {event.type}
        </h2>
        <Button variant="quiet" onClick={onClose}>
          Close
        </Button>
      </div>
      <p className={styles.muted}>
        {event.actor.kind}
        {event.actor.kind === "model" ? ` · ${event.actor.model.model}` : ""} · hash{" "}
        {event.hash.slice(0, 16)}…
      </p>
      <pre className={styles.json}>{JSON.stringify(event.payload, null, 2)}</pre>
      {event.blobs.length > 0 && (
        <div className={styles.blobs}>
          {event.blobs.map((h) => (
            <Button key={h} onClick={() => open(h)}>
              Show{" "}
              {event.type === "diff.captured"
                ? "diff"
                : event.type === "check.completed"
                  ? "output"
                  : event.type.includes("packet") || event.type === "node.dispatched"
                    ? "packet"
                    : "content"}
            </Button>
          ))}
        </div>
      )}
      {blob !== null &&
        (blob.mediaType === "text/x-diff" ? (
          <DiffView patch={blob.text} />
        ) : (
          <pre className={styles.json}>
            {blob.mediaType.includes("json")
              ? JSON.stringify(JSON.parse(blob.text), null, 2)
              : blob.text}
          </pre>
        ))}
    </Panel>
  );
}
