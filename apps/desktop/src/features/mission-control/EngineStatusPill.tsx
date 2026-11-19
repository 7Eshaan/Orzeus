import type { EngineView } from "../../app/engine-state.ts";
import styles from "./EngineStatusPill.module.css";

interface EngineStatusPillProps {
  readonly view: EngineView;
}

export function EngineStatusPill({ view }: EngineStatusPillProps) {
  return (
    <div className={styles.pill} data-tone={view.tone} role="status" aria-live="polite">
      <span className={styles.dot} aria-hidden="true" />
      <span className={styles.label}>{view.label}</span>
      {view.detail !== null && <span className={styles.detail}>{view.detail}</span>}
    </div>
  );
}
