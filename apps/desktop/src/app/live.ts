import { useCallback, useEffect, useRef, useState } from "react";
import { useEngineClient } from "./context.tsx";

export interface Live<T> {
  readonly data: T | null;
  readonly error: string | null;
  readonly loading: boolean;
  refresh(): void;
}

/**
 * Reads engine data and keeps it fresh: refetches when any of `events` fires (debounced), when
 * the engine (re)connects, and every `pollMs` as a safety net.
 */
export function useLive<T>(
  load: (() => Promise<T>) | null,
  deps: readonly unknown[],
  events: readonly ("run.updated" | "approvals.changed")[] = ["run.updated"],
  pollMs = 15_000,
): Live<T> {
  const client = useEngineClient();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: deps are the caller's
  useEffect(() => {
    if (load === null || client === null) return;
    let active = true;
    setLoading(true);
    load().then(
      (value) => {
        if (!active) return;
        setData(value);
        setError(null);
        setLoading(false);
      },
      (reason: unknown) => {
        if (!active) return;
        setError(reason instanceof Error ? reason.message : String(reason));
        setLoading(false);
      },
    );
    return () => {
      active = false;
    };
  }, [client, tick, ...deps]);

  useEffect(() => {
    if (client === null) return;
    const bump = () => {
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(refresh, 120);
    };
    const offs = events.map((e) => client.on(e, bump));
    const offStatus = client.onStatus((s) => {
      if (s.state === "running") bump();
    });
    const interval = setInterval(refresh, pollMs);
    return () => {
      for (const off of offs) off();
      offStatus();
      clearInterval(interval);
    };
  }, [client, refresh, pollMs, events]);

  return { data, error, loading, refresh };
}
