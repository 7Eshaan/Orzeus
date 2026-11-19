import { useEffect, useState } from "react";
import { ApprovalQueue } from "../features/approvals/ApprovalQueue.tsx";
import { MissionControl } from "../features/mission-control/MissionControl.tsx";
import { Settings } from "../features/settings/Settings.tsx";
import { QuotaStrip } from "../features/shell/QuotaStrip.tsx";
import { Sidebar } from "../features/shell/Sidebar.tsx";
import { TraceInspector } from "../features/trace/TraceInspector.tsx";
import { Empty } from "../ui/components.tsx";
import styles from "./App.module.css";
import { EngineProvider } from "./context.tsx";

export type View = "mission" | "approvals" | "trace" | "settings";

const SHORTCUTS: Readonly<Record<string, View>> = {
  "1": "mission",
  "2": "approvals",
  "3": "trace",
  "4": "settings",
};

export function App() {
  return (
    <EngineProvider
      fallback={
        <Empty title="Not connected to the engine">
          <p>
            Open Orzeus through the desktop app (pnpm dev), or start the dev bridge and add
            ?bridge=http://127.0.0.1:1421 to this page.
          </p>
        </Empty>
      }
    >
      <Shell />
    </EngineProvider>
  );
}

function Shell() {
  const [view, setView] = useState<View>("mission");
  const [runId, setRunId] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      const target = SHORTCUTS[event.key];
      if (target !== undefined) {
        event.preventDefault();
        setView(target);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className={styles.shell}>
      <a href="#main" className={styles.skip}>
        Skip to content
      </a>
      <Sidebar
        view={view}
        onView={setView}
        runId={runId}
        onRun={(id) => {
          setRunId(id);
          setView((v) => (v === "settings" || v === "approvals" ? "mission" : v));
        }}
      />
      <div className={styles.column}>
        <header className={styles.topbar} data-tauri-drag-region>
          <QuotaStrip />
        </header>
        <main id="main" className={styles.content} tabIndex={-1}>
          {view === "mission" && (
            <MissionControl
              runId={runId}
              onRun={setRunId}
              onOpenApprovals={() => setView("approvals")}
            />
          )}
          {view === "approvals" && (
            <ApprovalQueue
              onOpenRun={(id) => {
                setRunId(id);
                setView("mission");
              }}
            />
          )}
          {view === "trace" && <TraceInspector runId={runId} />}
          {view === "settings" && <Settings />}
        </main>
      </div>
    </div>
  );
}
