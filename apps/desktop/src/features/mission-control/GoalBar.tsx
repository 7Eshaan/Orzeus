import { type FormEvent, useEffect, useRef, useState } from "react";
import { useEngineClient } from "../../app/context.tsx";
import { useLive } from "../../app/live.ts";
import { Button, Field, inputClass } from "../../ui/components.tsx";
import styles from "./mission.module.css";

const REPO_KEY = "orzeus.lastRepo";

/** The prompt bar: a goal, a repository, and which models plan and build. */
export function GoalBar({ onStarted }: { readonly onStarted: (runId: string) => void }) {
  const client = useEngineClient();
  const settings = useLive(client === null ? null : () => client.request("settings.read", {}), []);
  const [goal, setGoal] = useState("");
  const [repo, setRepo] = useState(() => localStorage.getItem(REPO_KEY) ?? "");
  const [planner, setPlanner] = useState("");
  const [worker, setWorker] = useState("");
  const [planText, setPlanText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const goalRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    goalRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (
        event.key === "/" &&
        document.activeElement?.tagName !== "TEXTAREA" &&
        document.activeElement?.tagName !== "INPUT"
      ) {
        event.preventDefault();
        goalRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (client === null || repo.trim() === "" || (planText === null && goal.trim() === "")) return;
    setBusy(true);
    setError(null);
    try {
      localStorage.setItem(REPO_KEY, repo.trim());
      if (planText !== null) {
        const { runId } = await client.request("runs.startPlan", {
          repo: repo.trim(),
          plan: JSON.parse(planText) as unknown,
        });
        onStarted(runId);
        return;
      }
      const { runId } = await client.request("runs.start", {
        goal: goal.trim(),
        repo: repo.trim(),
        ...(planner.trim() ? { planner: planner.trim() } : {}),
        ...(worker.trim() ? { worker: worker.trim() } : {}),
      });
      onStarted(runId);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const defaults = settings.data?.defaults;
  return (
    <form className={styles.goalBar} onSubmit={submit} aria-labelledby="goal-title">
      <h1 id="goal-title" className={styles.title}>
        What should we build?
      </h1>
      <p className={styles.subtitle}>
        A frontier model plans it, fast workers build it in parallel, and you approve what matters.
      </p>
      <div className={styles.prompt}>
        <label htmlFor="goal" className="visually-hidden">
          Goal
        </label>
        <textarea
          id="goal"
          ref={goalRef}
          className={styles.goalInput}
          rows={3}
          placeholder="Describe the change, e.g. Add a subtract function and export it from the library"
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit(e);
          }}
        />
        <Button
          type="submit"
          variant="primary"
          disabled={busy || repo.trim() === "" || (planText === null && goal.trim() === "")}
        >
          {busy ? "Starting…" : planText === null ? "Plan" : "Load plan"}
        </Button>
      </div>
      <div className={styles.options}>
        <Field label="Repository">
          <input
            className={inputClass}
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
            placeholder="/path/to/repo"
            spellCheck={false}
          />
        </Field>
        <Field label="Planner">
          <input
            className={inputClass}
            value={planner}
            onChange={(e) => setPlanner(e.target.value)}
            placeholder={defaults?.planner ?? "adapter:model"}
            spellCheck={false}
          />
        </Field>
        <Field label="Worker">
          <input
            className={inputClass}
            value={worker}
            onChange={(e) => setWorker(e.target.value)}
            placeholder={defaults?.worker ?? "adapter:model"}
            spellCheck={false}
          />
        </Field>
      </div>
      <details
        className={styles.planFile}
        open={planText !== null}
        onToggle={(e) =>
          setPlanText((e.target as HTMLDetailsElement).open ? (planText ?? "") : null)
        }
      >
        <summary>Use a hand-written plan instead</summary>
        <label htmlFor="plan-json" className="visually-hidden">
          Plan JSON
        </label>
        <textarea
          id="plan-json"
          className={inputClass}
          rows={8}
          spellCheck={false}
          placeholder='{"goal": "...", "nodes": [...]}'
          value={planText ?? ""}
          onChange={(e) => setPlanText(e.target.value)}
        />
      </details>
      {error !== null && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      <p className={styles.hint}>⌘↵ to plan · / to focus · ⌘1–4 to switch screens</p>
    </form>
  );
}
