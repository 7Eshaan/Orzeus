import { MissionControl } from "../features/mission-control/MissionControl.tsx";
import { useEngine } from "./useEngine.ts";

export function App() {
  const engine = useEngine();
  return (
    <div className="shell">
      <header className="topbar" data-tauri-drag-region>
        <span className="wordmark">Orzeus</span>
      </header>
      <main className="content">
        <MissionControl engine={engine} />
      </main>
    </div>
  );
}
