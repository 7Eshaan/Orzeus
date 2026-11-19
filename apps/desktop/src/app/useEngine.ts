import { PROTOCOL_VERSION } from "@orzeus/protocol";
import { useEffect, useState } from "react";
import { connectEngine, type EngineConnection, withTimeout } from "./engine-connection.ts";
import {
  describeEngine,
  type EngineStatus,
  type EngineView,
  type PingResult,
} from "./engine-state.ts";

const PING_TIMEOUT_MS = 3000;

/** Connects to the engine, pings it whenever it (re)starts, and returns what to display. */
export function useEngine(): EngineView {
  const [inShell, setInShell] = useState(true);
  const [status, setStatus] = useState<EngineStatus>({ state: "starting" });
  const [connection, setConnection] = useState<EngineConnection | null>(null);
  const [ping, setPing] = useState<PingResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let opened: EngineConnection | null = null;
    connectEngine((next) => {
      if (active) setStatus(next);
    })
      .then((result) => {
        if (!active) {
          result?.close();
          return;
        }
        opened = result;
        setInShell(result !== null);
        if (result !== null) {
          setConnection(result);
          setStatus(result.initialStatus);
        }
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      active = false;
      opened?.close();
    };
  }, []);

  const runningPid = status.state === "running" ? status.pid : null;
  useEffect(() => {
    if (connection === null || runningPid === null) return;
    let active = true;
    setPing(null);
    setError(null);
    withTimeout(connection.client.request("engine.ping", {}), PING_TIMEOUT_MS, "Engine ping")
      .then((result) => {
        if (active) setPing(result);
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      active = false;
    };
  }, [connection, runningPid]);

  return describeEngine({ inShell, status, ping, error, expectedProtocol: PROTOCOL_VERSION });
}
