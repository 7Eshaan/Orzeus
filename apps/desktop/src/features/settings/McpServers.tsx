import type { McpDefaultGrant, McpServerInput, McpServerView } from "@orzeus/protocol";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { type FormEvent, useState } from "react";
import { useEngineClient } from "../../app/context.tsx";
import { useLive } from "../../app/live.ts";
import { formatEnv, joinArgs, parseEnv, slugify, splitArgs } from "../../lib/argv.ts";
import { ago } from "../../lib/format.ts";
import { Button, Field, inputClass, Panel, Pill } from "../../ui/components.tsx";
import styles from "./settings.module.css";

const GRANTS: Record<McpDefaultGrant, string> = {
  none: "Nothing until a plan grants it",
  read: "Read-only tools",
  all: "All tools (changes still ask you)",
};

interface Draft {
  readonly id: string;
  readonly name: string;
  readonly transport: "stdio" | "streamable_http";
  readonly command: string;
  readonly env: string;
  readonly secretEnv: string;
  readonly url: string;
  readonly defaultGrant: McpDefaultGrant;
  readonly enabled: boolean;
  readonly secret: string;
}

const EMPTY: Draft = {
  id: "",
  name: "",
  transport: "stdio",
  command: "",
  env: "",
  secretEnv: "",
  url: "",
  defaultGrant: "read",
  enabled: true,
  secret: "",
};

function draftOf(s: McpServerView): Draft {
  return {
    ...EMPTY,
    id: s.id,
    name: s.name,
    transport: s.config.transport,
    defaultGrant: s.defaultGrant,
    enabled: s.enabled,
    ...(s.config.transport === "stdio"
      ? {
          command: joinArgs([s.config.command, ...s.config.args]),
          env: formatEnv(s.config.env),
          secretEnv: s.config.secretEnv ?? "",
        }
      : { url: s.config.url }),
  };
}

function inputOf(d: Draft): McpServerInput {
  const base = {
    id: d.id,
    name: d.name.trim(),
    enabled: d.enabled,
    defaultGrant: d.defaultGrant,
  };
  if (d.transport === "streamable_http")
    return { ...base, config: { transport: "streamable_http", url: d.url.trim() } };
  const [command, ...args] = splitArgs(d.command);
  if (command === undefined) throw new Error("Enter the command that starts the server.");
  return {
    ...base,
    config: {
      transport: "stdio",
      command,
      args,
      env: parseEnv(d.env),
      secretEnv: d.secretEnv.trim() === "" ? null : d.secretEnv.trim(),
    },
  };
}

function describeServer(s: McpServerView): string {
  return s.config.transport === "stdio"
    ? joinArgs([s.config.command, ...s.config.args])
    : s.config.url;
}

function Health({ server }: { readonly server: McpServerView }) {
  if (!server.enabled) return <Pill>Off</Pill>;
  const d = server.discovered;
  if (d === null) return <Pill tone="attention">Not tested</Pill>;
  return d.ok ? (
    <Pill tone="ok">{d.tools.length === 1 ? "1 tool" : `${d.tools.length} tools`}</Pill>
  ) : (
    <Pill tone="bad">Failed</Pill>
  );
}

/** Upstream MCP servers that workers can use through the run's gateway. */
export function McpServers() {
  const client = useEngineClient();
  const desktop = isTauri();
  const servers = useLive(client === null ? null : () => client.request("mcp.list", {}), []);
  const [editing, setEditing] = useState<{ draft: Draft; isNew: boolean } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const run = async (label: string, work: () => Promise<void>) => {
    setBusy(label);
    setMessage(null);
    try {
      await work();
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
      servers.refresh();
    }
  };

  const test = (id: string) =>
    run(`test:${id}`, async () => {
      if (client === null) return;
      const result = await client.request("mcp.test", { id });
      const d = result.discovered;
      setMessage(
        d?.ok
          ? `${result.name} answered with ${d.tools.length} tools.`
          : `${result.name} did not connect: ${d?.error ?? "unknown error"}`,
      );
    });

  const save = (event: FormEvent) => {
    event.preventDefault();
    if (editing === null || client === null) return;
    const { draft } = editing;
    void run("save", async () => {
      const saved = await client.request("mcp.save", { server: inputOf(draft) });
      setEditing(null);
      if (draft.secret.trim() !== "" && desktop) {
        await invoke("secret_set", { name: `mcp.${saved.id}`, value: draft.secret });
        await invoke("engine_restart");
        setMessage(`Saved ${saved.name}. Its secret is in the Keychain; the engine restarted.`);
      } else {
        setMessage(`Saved ${saved.name}.`);
      }
    });
  };

  const remove = (s: McpServerView) =>
    run(`remove:${s.id}`, async () => {
      if (client === null) return;
      await client.request("mcp.remove", { id: s.id });
      setConfirmRemove(null);
      if (desktop && s.secretSet) {
        await invoke("secret_delete", { name: `mcp.${s.id}` });
        await invoke("engine_restart");
      }
      setMessage(`Removed ${s.name}.`);
    });

  const toggle = (s: McpServerView) =>
    run(`toggle:${s.id}`, async () => {
      if (client === null) return;
      const { secretSet: _set, secretVar: _var, discovered: _d, ...input } = s;
      await client.request("mcp.save", { server: { ...input, enabled: !s.enabled } });
    });

  const list = servers.data ?? [];
  return (
    <Panel>
      <div className={styles.panelHeader}>
        <h2 className={styles.h2}>MCP servers</h2>
        {editing === null && (
          <Button onClick={() => setEditing({ draft: EMPTY, isNew: true })}>Add server</Button>
        )}
      </div>
      <p className={styles.muted}>
        Workers reach these servers only through Orzeus's gateway, which checks every call against
        the plan's grants and asks you before anything that changes outside state. Changes apply to
        runs started afterwards.
      </p>
      {servers.error !== null && <p className={styles.muted}>{servers.error}</p>}
      {list.length === 0 && servers.data !== null && editing === null && (
        <p className={styles.muted}>No servers yet. The repository memory is always available.</p>
      )}
      <ul className={styles.servers}>
        {list.map((s) => (
          <li key={s.id} className={styles.server}>
            <div className={styles.serverHead}>
              <div className={styles.serverName}>
                <strong>{s.name}</strong> <span className={styles.muted}>{s.id}</span>{" "}
                <Health server={s} />
                {s.secretSet && <Pill tone="active">secret set</Pill>}
              </div>
              <div className={styles.keyButtons}>
                <Button
                  variant="quiet"
                  onClick={() => toggle(s)}
                  disabled={busy !== null}
                  aria-pressed={s.enabled}
                >
                  {s.enabled ? "Turn off" : "Turn on"}
                </Button>
                <Button onClick={() => test(s.id)} disabled={busy !== null}>
                  {busy === `test:${s.id}` ? "Testing…" : "Test"}
                </Button>
                <Button
                  onClick={() => setEditing({ draft: draftOf(s), isNew: false })}
                  disabled={busy !== null}
                >
                  Edit
                </Button>
                {confirmRemove === s.id ? (
                  <Button variant="danger" onClick={() => remove(s)} disabled={busy !== null}>
                    Confirm remove
                  </Button>
                ) : (
                  <Button variant="quiet" onClick={() => setConfirmRemove(s.id)}>
                    Remove
                  </Button>
                )}
              </div>
            </div>
            <code className={styles.command}>{describeServer(s)}</code>
            <div className={styles.muted}>
              New plans get: {GRANTS[s.defaultGrant].toLowerCase()}.
              {s.discovered !== null && ` Tested ${ago(s.discovered.at, Date.now())}.`}
              {s.discovered?.error ? ` ${s.discovered.error}` : ""}
            </div>
            {s.discovered?.ok && s.discovered.tools.length > 0 && (
              <details className={styles.tools}>
                <summary>Tools</summary>
                <ul>
                  {s.discovered.tools.map((t) => (
                    <li key={t.name}>
                      <code>{t.name}</code> {t.readOnly ? <Pill>read-only</Pill> : null}{" "}
                      <span className={styles.muted}>{t.description}</span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </li>
        ))}
      </ul>
      {editing !== null && (
        <ServerForm
          draft={editing.draft}
          isNew={editing.isNew}
          taken={list.map((s) => s.id)}
          desktop={desktop}
          busy={busy === "save"}
          onChange={(draft) => setEditing({ ...editing, draft })}
          onSubmit={save}
          onCancel={() => setEditing(null)}
        />
      )}
      {message !== null && (
        <p role="status" className={styles.muted}>
          {message}
        </p>
      )}
    </Panel>
  );
}

function ServerForm({
  draft,
  isNew,
  taken,
  desktop,
  busy,
  onChange,
  onSubmit,
  onCancel,
}: {
  readonly draft: Draft;
  readonly isNew: boolean;
  readonly taken: readonly string[];
  readonly desktop: boolean;
  readonly busy: boolean;
  readonly onChange: (draft: Draft) => void;
  readonly onSubmit: (event: FormEvent) => void;
  readonly onCancel: () => void;
}) {
  const set = (patch: Partial<Draft>) => onChange({ ...draft, ...patch });
  let problem: string | null = null;
  try {
    if (draft.name.trim() !== "") inputOf(draft);
  } catch (error) {
    problem = error instanceof Error ? error.message : String(error);
  }
  if (isNew && taken.includes(draft.id)) problem = `The id "${draft.id}" is taken.`;
  const ready =
    problem === null &&
    draft.name.trim() !== "" &&
    (draft.transport === "stdio" ? draft.command.trim() !== "" : draft.url.trim() !== "");

  return (
    <form className={styles.serverForm} onSubmit={onSubmit} aria-label="MCP server">
      <h3 className={styles.h3}>{isNew ? "Add a server" : `Edit ${draft.name}`}</h3>
      <Field label="Name">
        <input
          className={inputClass}
          value={draft.name}
          onChange={(e) =>
            set({ name: e.target.value, ...(isNew ? { id: slugify(e.target.value) } : {}) })
          }
        />
      </Field>
      <Field label="Id (tool prefix workers see)">
        <input className={inputClass} value={draft.id} readOnly spellCheck={false} />
      </Field>
      <Field label="How Orzeus reaches it">
        <select
          className={inputClass}
          value={draft.transport}
          onChange={(e) => set({ transport: e.target.value as Draft["transport"] })}
        >
          <option value="stdio">Starts a local command (stdio)</option>
          <option value="streamable_http">Connects to a URL (Streamable HTTP)</option>
        </select>
      </Field>
      {draft.transport === "stdio" ? (
        <>
          <Field label="Command">
            <input
              className={`${inputClass} ${styles.mono}`}
              value={draft.command}
              placeholder="npx -y some-mcp-server --flag"
              spellCheck={false}
              onChange={(e) => set({ command: e.target.value })}
            />
          </Field>
          <Field label="Environment (KEY=value per line, not for secrets)">
            <textarea
              className={`${inputClass} ${styles.mono}`}
              rows={2}
              value={draft.env}
              spellCheck={false}
              onChange={(e) => set({ env: e.target.value })}
            />
          </Field>
          <Field label="Pass the secret as variable">
            <input
              className={`${inputClass} ${styles.mono}`}
              value={draft.secretEnv}
              placeholder="e.g. GITHUB_TOKEN"
              spellCheck={false}
              onChange={(e) => set({ secretEnv: e.target.value })}
            />
          </Field>
        </>
      ) : (
        <Field label="URL">
          <input
            className={`${inputClass} ${styles.mono}`}
            value={draft.url}
            placeholder="https://example.com/mcp"
            spellCheck={false}
            onChange={(e) => set({ url: e.target.value })}
          />
        </Field>
      )}
      <Field
        label={
          draft.transport === "stdio"
            ? "Secret (stored in the Keychain)"
            : "Bearer token (Keychain)"
        }
      >
        <input
          className={inputClass}
          type="password"
          autoComplete="off"
          disabled={!desktop}
          placeholder={desktop ? "Leave empty to keep the current one" : "Desktop app only"}
          value={draft.secret}
          onChange={(e) => set({ secret: e.target.value })}
        />
      </Field>
      <Field label="New plans give workers">
        <select
          className={inputClass}
          value={draft.defaultGrant}
          onChange={(e) => set({ defaultGrant: e.target.value as McpDefaultGrant })}
        >
          {(Object.keys(GRANTS) as McpDefaultGrant[]).map((g) => (
            <option key={g} value={g}>
              {GRANTS[g]}
            </option>
          ))}
        </select>
      </Field>
      <label className={styles.check}>
        <input
          type="checkbox"
          checked={draft.enabled}
          onChange={(e) => set({ enabled: e.target.checked })}
        />
        Use this server in new runs
      </label>
      {problem !== null && (
        <p role="alert" className={styles.problem}>
          {problem}
        </p>
      )}
      <div className={styles.keyButtons}>
        <Button type="submit" variant="primary" disabled={!ready || busy}>
          {busy ? "Saving…" : "Save"}
        </Button>
        <Button variant="quiet" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      <p className={styles.muted}>
        Tools are listed after a successful test; grants for new plans use the last test.
      </p>
    </form>
  );
}
