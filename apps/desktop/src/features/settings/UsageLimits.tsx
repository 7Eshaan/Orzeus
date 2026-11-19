import { useState } from "react";
import { useEngineClient } from "../../app/context.tsx";
import { useLive } from "../../app/live.ts";
import { countdown } from "../../lib/format.ts";
import { Button, inputClass, Panel } from "../../ui/components.tsx";
import styles from "./settings.module.css";

/**
 * Soft caps: per account and window, the usage at which Orzeus stops starting new work there.
 * Work already running finishes; waiting nodes resume when the window resets.
 */
export function UsageLimits() {
  const client = useEngineClient();
  const quota = useLive(
    client === null ? null : () => client.request("quota.read", {}),
    [],
    ["quota.changed"],
  );
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const accounts = (quota.data?.accounts ?? []).filter(
    (a) => a.windows.length > 0 || Object.keys(a.softCaps).length > 0,
  );

  const save = async (accountId: string, window: string, value: string | null) => {
    if (client === null) return;
    const percent = value === null || value.trim() === "" ? null : Number(value);
    if (percent !== null && !(percent > 0 && percent <= 100)) {
      setMessage("A limit is a percentage from 1 to 100.");
      return;
    }
    try {
      await client.request("quota.setSoftCap", { accountId, window, percent });
      setDrafts((d) => {
        const { [`${accountId}/${window}`]: _, ...rest } = d;
        return rest;
      });
      setMessage(
        percent === null ? `Removed the ${window} limit.` : `New work pauses at ${percent}%.`,
      );
      quota.refresh();
    } catch (error) {
      setMessage((error as Error).message);
    }
  };

  return (
    <Panel>
      <h2 className={styles.h2}>Usage limits</h2>
      <p className={styles.muted}>
        Stop starting new work on an account once a window reaches a share of its quota. Running
        work finishes, and waiting nodes continue when the window resets. Windows appear here once
        Orzeus has seen them reported.
      </p>
      {accounts.length === 0 && (
        <p className={styles.muted}>No quota windows reported yet. Local models have none.</p>
      )}
      <ul className={styles.limits}>
        {accounts.flatMap((a) => {
          const windows = [
            ...new Set([...a.windows.map((w) => w.window), ...Object.keys(a.softCaps)]),
          ];
          return windows.map((window) => {
            const key = `${a.accountId}/${window}`;
            const observed = a.windows.find((w) => w.window === window);
            const cap = a.softCaps[window];
            const draft = drafts[key] ?? (cap === undefined ? "" : String(cap));
            return (
              <li key={key} className={styles.limit}>
                <span>
                  <strong>{a.label}</strong> · {window}
                  <span className={styles.muted}>
                    {observed === undefined
                      ? " (no recent reading)"
                      : ` ${observed.usedPercent ?? "?"}% used${
                          observed.resetsAt === null
                            ? ""
                            : `, resets in ${countdown(observed.resetsAt, Date.now())}`
                        }${observed.source === "local_estimate" ? " (estimate)" : ""}`}
                  </span>
                </span>
                <label className={styles.limitInput}>
                  Pause new work at
                  <input
                    className={inputClass}
                    type="number"
                    min={1}
                    max={100}
                    placeholder="no limit"
                    value={draft}
                    onChange={(e) => setDrafts((d) => ({ ...d, [key]: e.target.value }))}
                  />
                  %
                </label>
                <span className={styles.keyButtons}>
                  <Button
                    disabled={drafts[key] === undefined}
                    onClick={() => save(a.accountId, window, draft)}
                  >
                    Save
                  </Button>
                  {cap !== undefined && (
                    <Button variant="quiet" onClick={() => save(a.accountId, window, null)}>
                      Clear
                    </Button>
                  )}
                </span>
              </li>
            );
          });
        })}
      </ul>
      {message !== null && (
        <p role="status" className={styles.muted}>
          {message}
        </p>
      )}
    </Panel>
  );
}
