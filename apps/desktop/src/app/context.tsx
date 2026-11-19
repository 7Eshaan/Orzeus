import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { EngineClient } from "./engine-client.ts";
import type { EngineStatus } from "./engine-state.ts";
import { openTransport } from "./transport.ts";

const ClientContext = createContext<EngineClient | null>(null);

export function useEngineClient(): EngineClient | null {
  return useContext(ClientContext);
}

/** Connects once per window and provides the client to every screen. */
export function EngineProvider({
  children,
  fallback,
}: {
  readonly children: ReactNode;
  readonly fallback: ReactNode;
}) {
  const [client, setClient] = useState<EngineClient | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let active = true;
    let opened: EngineClient | null = null;
    void openTransport().then(async (transport) => {
      if (transport === null) {
        if (active) setMissing(true);
        return;
      }
      opened = new EngineClient(transport);
      await opened.init();
      if (active) setClient(opened);
      else opened.close();
    });
    return () => {
      active = false;
      opened?.close();
    };
  }, []);

  if (missing) return fallback;
  return <ClientContext.Provider value={client}>{children}</ClientContext.Provider>;
}

export function useEngineStatus(): EngineStatus {
  const client = useEngineClient();
  const [status, setStatus] = useState<EngineStatus>(client?.status ?? { state: "starting" });
  useEffect(() => {
    if (client === null) return;
    setStatus(client.status);
    return client.onStatus(setStatus);
  }, [client]);
  return status;
}
