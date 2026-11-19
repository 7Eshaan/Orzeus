import type { EngineView } from "../../app/engine-state.ts";
import { EngineStatusPill } from "./EngineStatusPill.tsx";
import styles from "./MissionControl.module.css";

interface MissionControlProps {
  readonly engine: EngineView;
}

/** Phase 0 placeholder for Mission Control: the prompt bar and engine status. */
export function MissionControl({ engine }: MissionControlProps) {
  return (
    <section className={styles.root} aria-labelledby="mission-control-title">
      <div className={styles.intro}>
        <h1 id="mission-control-title" className={styles.title}>
          What should we build?
        </h1>
        <p className={styles.subtitle}>
          Describe a goal. A frontier model plans it, fast workers build it in parallel, and you
          approve what matters.
        </p>
      </div>

      <form className={styles.prompt} onSubmit={(event) => event.preventDefault()}>
        <label htmlFor="goal" className="visually-hidden">
          Goal
        </label>
        <input
          id="goal"
          className={styles.input}
          placeholder="Planning arrives in Phase 3"
          disabled
          autoComplete="off"
        />
        <button type="submit" className={styles.button} disabled>
          Plan
        </button>
      </form>

      <EngineStatusPill view={engine} />
    </section>
  );
}
