import { getVersion } from "@tauri-apps/api/app";
import { isTauri } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { useCallback, useEffect, useState } from "react";
import { Button, Panel } from "../../ui/components.tsx";
import styles from "./settings.module.css";

type State =
  | { readonly kind: "idle" }
  | { readonly kind: "checking" }
  | { readonly kind: "current" }
  | { readonly kind: "available"; readonly update: Update }
  | { readonly kind: "downloading"; readonly done: number; readonly total: number | null }
  | { readonly kind: "ready" }
  | { readonly kind: "unavailable"; readonly reason: string }
  | { readonly kind: "error"; readonly message: string };

const LAST_CHECK = "orzeus.updates.lastCheck";
const DAY_MS = 24 * 3_600_000;

/**
 * Signed updates from the project's GitHub Releases (docs/decisions/0007-auto-updates.md).
 * Each update is verified against the public key built into the app before it is installed.
 */
export function Updates() {
  const desktop = isTauri();
  const [version, setVersion] = useState<string | null>(null);
  const [state, setState] = useState<State>({ kind: "idle" });

  const runCheck = useCallback(async () => {
    setState({ kind: "checking" });
    try {
      const update = await check();
      localStorage.setItem(LAST_CHECK, String(Date.now()));
      setState(update === null ? { kind: "current" } : { kind: "available", update });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Development builds have no updater configured, so the plugin is not loaded.
      setState(
        /not (found|allowed|registered)|plugin/i.test(message)
          ? { kind: "unavailable", reason: "Updates are available in the packaged app." }
          : { kind: "error", message },
      );
    }
  }, []);

  useEffect(() => {
    if (!desktop) return;
    void getVersion().then(setVersion);
    // Check quietly once a day when Settings opens.
    const last = Number(localStorage.getItem(LAST_CHECK) ?? 0);
    if (Date.now() - last > DAY_MS) void runCheck();
  }, [desktop, runCheck]);

  const install = async (update: Update) => {
    let done = 0;
    let total: number | null = null;
    try {
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") total = event.data.contentLength ?? null;
        if (event.event === "Progress") done += event.data.chunkLength;
        setState({ kind: "downloading", done, total });
      });
      setState({ kind: "ready" });
    } catch (error) {
      setState({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    }
  };

  const mb = (bytes: number) => `${(bytes / 1_048_576).toFixed(1)} MB`;
  return (
    <Panel>
      <h2 className={styles.h2}>Updates</h2>
      {!desktop ? (
        <p className={styles.muted}>Updates are available in the desktop app.</p>
      ) : (
        <>
          <p className={styles.muted}>
            Orzeus {version ?? "…"}. Updates come from the project's GitHub releases and are
            installed only if their signature matches the key built into this app.
          </p>
          {state.kind === "available" && (
            <div className={styles.update}>
              <strong>Orzeus {state.update.version} is available.</strong>
              {state.update.body && <p className={styles.notes}>{state.update.body}</p>}
            </div>
          )}
          <p role="status" className={styles.muted}>
            {state.kind === "checking" && "Checking…"}
            {state.kind === "current" && "You have the latest version."}
            {state.kind === "downloading" &&
              `Downloading ${mb(state.done)}${state.total === null ? "" : ` of ${mb(state.total)}`}…`}
            {state.kind === "ready" && "Installed. Restart to use the new version."}
            {state.kind === "unavailable" && state.reason}
            {state.kind === "error" && `Could not update: ${state.message}`}
          </p>
          <div className={styles.keyButtons}>
            {state.kind === "available" ? (
              <Button variant="primary" onClick={() => install(state.update)}>
                Download and install
              </Button>
            ) : state.kind === "ready" ? (
              <Button variant="primary" onClick={() => relaunch()}>
                Restart now
              </Button>
            ) : (
              <Button
                onClick={runCheck}
                disabled={state.kind === "checking" || state.kind === "downloading"}
              >
                Check for updates
              </Button>
            )}
          </div>
        </>
      )}
    </Panel>
  );
}
