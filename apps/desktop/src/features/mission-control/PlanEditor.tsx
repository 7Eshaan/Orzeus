import type { PlanEdit } from "@orzeus/protocol";
import type { NodeKind } from "@orzeus/schema";
import { Fragment, useState } from "react";
import { useEngineClient } from "../../app/context.tsx";
import { useLive } from "../../app/live.ts";
import { slugify } from "../../lib/argv.ts";
import {
  type EditorNode,
  type EditorState,
  fromEditor,
  grantableTools,
  newNode,
  removeNode,
  renameNode,
  toEditor,
  toggleGrant,
} from "../../lib/plan-editor.ts";
import { Button, Field, inputClass, Panel } from "../../ui/components.tsx";
import styles from "./mission.module.css";

const KINDS: readonly NodeKind[] = ["implement", "test", "refactor", "docs", "investigate"];

/**
 * Edits the proposed plan before it is approved: every node's task, checks, dependencies, write
 * scope, worker and tools, plus adding and removing nodes. Saving records a new plan revision.
 */
export function PlanEditor({
  runId,
  plan,
  onDone,
}: {
  readonly runId: string;
  readonly plan: PlanEdit;
  readonly onDone: () => void;
}) {
  const client = useEngineClient();
  const settings = useLive(client === null ? null : () => client.request("settings.read", {}), []);
  const servers = useLive(client === null ? null : () => client.request("mcp.list", {}), []);
  const [state, setState] = useState<EditorState>(() => toEditor(plan));
  const [problems, setProblems] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const providers = Object.fromEntries(
    (settings.data?.adapters ?? [])
      .filter((a) => a.roles.includes("worker"))
      .map((a) => [a.id, a.provider]),
  );
  const tools = grantableTools(servers.data ?? []);
  const workerOptions = [
    ...new Set([
      ...(settings.data === null ? [] : [settings.data.defaults.worker]),
      ...state.nodes.map((n) => n.worker),
    ]),
  ].filter((w) => w !== "");

  const update = (key: string, patch: Partial<EditorNode>) =>
    setState((s) => ({
      ...s,
      nodes: s.nodes.map((n) => (n.key === key ? { ...n, ...patch } : n)),
    }));

  const save = async () => {
    if (client === null) return;
    setProblems(null);
    let edit: PlanEdit;
    try {
      edit = fromEditor(state, providers);
    } catch (error) {
      setProblems((error as Error).message);
      return;
    }
    setSaving(true);
    try {
      await client.request("runs.revisePlan", { runId, plan: edit });
      onDone();
    } catch (error) {
      setProblems((error as Error).message.replace(/^Plan has problems:\n/, ""));
    } finally {
      setSaving(false);
    }
  };

  const add = () =>
    setState((s) => ({
      ...s,
      nodes: [
        ...s.nodes,
        newNode(s, {
          worker: settings.data?.defaults.worker ?? s.nodes[0]?.worker ?? "",
          mcp: s.nodes[0]?.mcp ?? [],
        }),
      ],
    }));

  return (
    <Panel>
      <div className={styles.planHeader}>
        <h2>Edit plan · {state.nodes.length} nodes</h2>
        <div className={styles.actions}>
          <Button variant="quiet" onClick={onDone} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </div>
      <Field label="Workers at once">
        <input
          className={`${inputClass} ${styles.narrow}`}
          type="number"
          min={1}
          max={16}
          value={state.maxConcurrency}
          onChange={(e) =>
            setState((s) => ({
              ...s,
              maxConcurrency: Math.min(16, Math.max(1, Number(e.target.value) || 1)),
            }))
          }
        />
      </Field>
      {problems !== null && (
        <div role="alert" className={styles.problems}>
          <strong>Fix these first:</strong>
          <ul>
            {problems.split("\n").map((p) => (
              <li key={p}>{p.replace(/^\s*-\s*/, "")}</li>
            ))}
          </ul>
        </div>
      )}
      <datalist id="orzeus-workers">
        {workerOptions.map((w) => (
          <option key={w} value={w} />
        ))}
      </datalist>
      <ol className={styles.editList}>
        {state.nodes.map((n) => (
          <li key={n.key} className={styles.editNode}>
            <fieldset>
              <legend className="visually-hidden">Node {n.id}</legend>
              <div className={styles.editRow}>
                <Field label="Id">
                  <input
                    className={`${inputClass} ${styles.mono}`}
                    value={n.id}
                    readOnly={!n.isNew}
                    spellCheck={false}
                    onChange={(e) =>
                      setState((s) => renameNode(s, n.key, slugify(e.target.value, 64)))
                    }
                  />
                </Field>
                <Field label="Title">
                  <input
                    className={inputClass}
                    value={n.title}
                    onChange={(e) => update(n.key, { title: e.target.value })}
                  />
                </Field>
                <Field label="Kind">
                  <select
                    className={inputClass}
                    value={n.kind}
                    onChange={(e) => update(n.key, { kind: e.target.value as NodeKind })}
                  >
                    {KINDS.map((k) => (
                      <option key={k} value={k}>
                        {k}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              <Field label="Task">
                <textarea
                  className={inputClass}
                  rows={3}
                  value={n.objective}
                  onChange={(e) => update(n.key, { objective: e.target.value })}
                />
              </Field>
              <div className={styles.editRow2}>
                <Field label="Done when (one per line)">
                  <textarea
                    className={inputClass}
                    rows={2}
                    value={n.acceptance}
                    onChange={(e) => update(n.key, { acceptance: e.target.value })}
                  />
                </Field>
                <Field label="Constraints (one per line)">
                  <textarea
                    className={inputClass}
                    rows={2}
                    value={n.constraints}
                    onChange={(e) => update(n.key, { constraints: e.target.value })}
                  />
                </Field>
                <Field label="Checks (one command per line)">
                  <textarea
                    className={`${inputClass} ${styles.mono}`}
                    rows={2}
                    spellCheck={false}
                    value={n.commands}
                    onChange={(e) => update(n.key, { commands: e.target.value })}
                  />
                </Field>
                <Field label="May change (files or globs)">
                  <textarea
                    className={`${inputClass} ${styles.mono}`}
                    rows={2}
                    spellCheck={false}
                    value={n.writeScope}
                    placeholder="Empty: read-only"
                    onChange={(e) => update(n.key, { writeScope: e.target.value })}
                  />
                </Field>
              </div>
              <Field label="Worker (adapter:model)">
                <input
                  className={`${inputClass} ${styles.mono}`}
                  list="orzeus-workers"
                  spellCheck={false}
                  value={n.worker}
                  onChange={(e) => update(n.key, { worker: e.target.value })}
                />
              </Field>
              <fieldset className={styles.choices}>
                <legend>Starts after</legend>
                {state.nodes.filter((o) => o.key !== n.key).length === 0 && (
                  <span className={styles.sub}>No other nodes.</span>
                )}
                {state.nodes
                  .filter((o) => o.key !== n.key)
                  .map((o) => (
                    <label key={o.key} className={styles.choice}>
                      <input
                        type="checkbox"
                        checked={n.dependsOn.includes(o.id)}
                        onChange={(e) =>
                          update(n.key, {
                            dependsOn: e.target.checked
                              ? [...n.dependsOn, o.id]
                              : n.dependsOn.filter((d) => d !== o.id),
                          })
                        }
                      />
                      {o.id}
                    </label>
                  ))}
              </fieldset>
              <fieldset className={styles.choices}>
                <legend>Tools</legend>
                {tools.map((t, i) => (
                  <Fragment key={`${t.server}/${t.tool}`}>
                    {(i === 0 || tools[i - 1]?.server !== t.server) && (
                      <span className={styles.toolServer}>{t.serverName}</span>
                    )}
                    <label className={styles.choice}>
                      <input
                        type="checkbox"
                        checked={n.mcp.some((g) => g.server === t.server && g.tool === t.tool)}
                        onChange={(e) =>
                          update(n.key, { mcp: toggleGrant(n.mcp, t, e.target.checked) })
                        }
                      />
                      <code>{t.tool}</code>
                      {!t.readOnly && <span className={styles.sub}>(asks you)</span>}
                    </label>
                  </Fragment>
                ))}
              </fieldset>
              <div className={styles.editFoot}>
                <Button
                  variant="quiet"
                  disabled={state.nodes.length === 1}
                  onClick={() => setState((s) => removeNode(s, n.key))}
                >
                  Remove {n.id}
                </Button>
              </div>
            </fieldset>
          </li>
        ))}
      </ol>
      <Button onClick={add}>Add node</Button>
    </Panel>
  );
}
