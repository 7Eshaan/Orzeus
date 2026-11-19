import { invoke, isTauri } from "@tauri-apps/api/core";
import { type FormEvent, useState } from "react";
import { useEngineClient } from "../../app/context.tsx";
import { useLive } from "../../app/live.ts";
import { Button, Field, inputClass, Panel, Pill } from "../../ui/components.tsx";
import { McpServers } from "./McpServers.tsx";
import styles from "./settings.module.css";

const KEYS = [
  {
    name: "anthropic",
    label: "Anthropic API key",
    help: "Planner, steering and review with Claude.",
  },
  { name: "gemini", label: "Gemini API key (AI Studio)", help: "Planner with Gemini." },
  {
    name: "openai",
    label: "OpenAI API key",
    help: "Codex with an API key instead of your ChatGPT login.",
  },
] as const;

/** Accounts and keys, models and routing, and the repository memory. */
export function Settings() {
  const client = useEngineClient();
  const settings = useLive(client === null ? null : () => client.request("settings.read", {}), []);
  const s = settings.data;

  return (
    <div className={styles.settings}>
      <h1 className={styles.title}>Settings</h1>
      <Panel>
        <h2 className={styles.h2}>Models and routing</h2>
        {s === null ? (
          <p aria-busy="true">Loading…</p>
        ) : (
          <>
            <p className={styles.muted}>
              Planner and frontier: <strong>{s.defaults.planner ?? "none"}</strong> · Default
              worker: <strong>{s.defaults.worker}</strong>
            </p>
            <ul className={styles.adapters}>
              {s.adapters.map((a) => (
                <li key={a.id}>
                  <span>
                    <strong>{a.displayName}</strong> <span className={styles.muted}>({a.id})</span>
                  </span>
                  <span className={styles.roles}>
                    {a.roles.map((r) => (
                      <Pill key={r} tone={r === "planner" ? "active" : "neutral"}>
                        {r}
                      </Pill>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
            <p className={styles.muted}>
              Codex {s.codexEnabled ? "is enabled" : "is off"}: it uses your own Codex login and
              quota. Data lives in {s.dataDir}.
            </p>
          </>
        )}
      </Panel>
      <ApiKeys received={s?.secrets ?? null} />
      <McpServers />
      <Memory />
    </div>
  );
}

function ApiKeys({ received }: { readonly received: Readonly<Record<string, boolean>> | null }) {
  const desktop = isTauri();
  const stored = useLive(
    desktop ? () => invoke<Record<string, boolean>>("secret_status") : null,
    [],
  );
  const [values, setValues] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);

  const save = async (name: string) => {
    const value = values[name]?.trim() ?? "";
    if (value === "") return;
    try {
      await invoke("secret_set", { name, value });
      setValues((v) => ({ ...v, [name]: "" }));
      await invoke("engine_restart");
      setMessage("Saved to the Keychain. The engine restarted to pick it up.");
      stored.refresh();
    } catch (reason) {
      setMessage(String(reason));
    }
  };
  const remove = async (name: string) => {
    await invoke("secret_delete", { name });
    await invoke("engine_restart");
    setMessage("Removed from the Keychain.");
    stored.refresh();
  };

  return (
    <Panel>
      <h2 className={styles.h2}>API keys</h2>
      <p className={styles.muted}>
        Keys are stored in the macOS Keychain and given to the engine when it starts. Orzeus can
        tell whether a key is set, but never shows it again.
      </p>
      {!desktop && <p className={styles.muted}>Key management is available in the desktop app.</p>}
      {KEYS.map((k) => {
        const isSet = stored.data?.[k.name] ?? received?.[k.name] ?? false;
        return (
          <div key={k.name} className={styles.key}>
            <Field label={k.label}>
              <input
                className={inputClass}
                type="password"
                autoComplete="off"
                disabled={!desktop}
                placeholder={isSet ? "Set (hidden)" : "Not set"}
                value={values[k.name] ?? ""}
                onChange={(e) => setValues((v) => ({ ...v, [k.name]: e.target.value }))}
              />
            </Field>
            <span className={styles.muted}>{k.help}</span>
            <div className={styles.keyButtons}>
              <Button
                disabled={!desktop || (values[k.name] ?? "").trim() === ""}
                onClick={() => save(k.name)}
              >
                Save
              </Button>
              {isSet && desktop && (
                <Button variant="danger" onClick={() => remove(k.name)}>
                  Remove
                </Button>
              )}
            </div>
          </div>
        );
      })}
      {message !== null && (
        <p role="status" className={styles.muted}>
          {message}
        </p>
      )}
    </Panel>
  );
}

function Memory() {
  const client = useEngineClient();
  const [repo, setRepo] = useState(() => localStorage.getItem("orzeus.lastRepo") ?? "");
  const memories = useLive(
    client === null || repo.trim() === ""
      ? null
      : () => client.request("memory.list", { repo: repo.trim() }),
    [repo],
  );
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [kind, setKind] = useState<"decision" | "constraint" | "convention" | "gotcha">(
    "convention",
  );

  const add = async (event: FormEvent) => {
    event.preventDefault();
    if (client === null || title.trim() === "" || body.trim() === "") return;
    await client.request("memory.add", {
      repo: repo.trim(),
      kind,
      title: title.trim(),
      body: body.trim(),
    });
    setTitle("");
    setBody("");
    memories.refresh();
  };

  return (
    <Panel>
      <h2 className={styles.h2}>Repository memory</h2>
      <p className={styles.muted}>
        Decisions and conventions the planner reads, and workers can look up through the gateway.
      </p>
      <Field label="Repository">
        <input
          className={inputClass}
          value={repo}
          onChange={(e) => setRepo(e.target.value)}
          spellCheck={false}
        />
      </Field>
      <ul className={styles.memories}>
        {(memories.data ?? []).map((m) => (
          <li key={m.id}>
            <Pill>{m.kind}</Pill> <strong>{m.title}</strong>
            <div className={styles.muted}>{m.body}</div>
          </li>
        ))}
        {memories.error !== null && <li className={styles.muted}>{memories.error}</li>}
      </ul>
      <form className={styles.memoryForm} onSubmit={add}>
        <Field label="Kind">
          <select
            className={inputClass}
            value={kind}
            onChange={(e) => setKind(e.target.value as typeof kind)}
          >
            <option value="convention">Convention</option>
            <option value="decision">Decision</option>
            <option value="constraint">Constraint</option>
            <option value="gotcha">Gotcha</option>
          </select>
        </Field>
        <Field label="Title">
          <input className={inputClass} value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field label="Details">
          <textarea
            className={inputClass}
            rows={2}
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
        </Field>
        <Button
          type="submit"
          disabled={repo.trim() === "" || title.trim() === "" || body.trim() === ""}
        >
          Add memory
        </Button>
      </form>
    </Panel>
  );
}
