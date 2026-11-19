import type { AccountId, QuotaWindow } from "@orzeus/schema";
import type { Db } from "./db.js";

export interface AccountRecord {
  readonly id: string;
  readonly provider: string;
  readonly adapter: string;
  readonly label: string;
  readonly authKind: "api_key" | "own_cli_login" | "service_account" | "none";
  /** Keychain item name for API keys; never the secret. */
  readonly secretRef: string | null;
}

interface QuotaRow {
  account_id: string;
  window: string;
  used_percent: number | null;
  resets_at: number | null;
  status: QuotaWindow["status"];
  source: QuotaWindow["source"];
  observed_at: number;
}

const KEEP_MS = 30 * 24 * 3_600_000;

/**
 * Accounts, quota observations and soft caps (tables provider_accounts and quota_observations
 * from migration 0001). Quota lives outside the event log because it belongs to accounts, not
 * runs: every source (official APIs, CLI events, response headers) lands here.
 */
export class Telemetry {
  readonly #db: Db;
  readonly #now: () => number;

  constructor(db: Db, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
  }

  /** Records an account the engine uses; label and adapter follow the latest configuration. */
  ensureAccount(account: AccountRecord): void {
    this.#db.run(
      `INSERT INTO provider_accounts (id, provider, adapter, label, auth_kind, secret_ref, enabled, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?)
       ON CONFLICT (id) DO UPDATE SET label = excluded.label`,
      [
        account.id,
        account.provider,
        account.adapter,
        account.label,
        account.authKind,
        account.secretRef,
        this.#now(),
      ],
    );
  }

  /** Stores observations for known accounts (others are ignored) and drops month-old ones. */
  recordQuota(windows: readonly QuotaWindow[]): void {
    if (windows.length === 0) return;
    this.#db.transaction(() => {
      for (const w of windows) {
        const known = this.#db.get("SELECT 1 FROM provider_accounts WHERE id = ?", [w.accountId]);
        if (known === undefined) continue;
        this.#db.run(
          `INSERT INTO quota_observations (account_id, window, used_percent, resets_at, status, source, observed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [w.accountId, w.window, w.usedPercent, w.resetsAt, w.status, w.source, w.observedAt],
        );
      }
      this.#db.run("DELETE FROM quota_observations WHERE observed_at < ?", [this.#now() - KEEP_MS]);
    });
  }

  /** The latest observation of every window of every account. */
  latestQuota(): QuotaWindow[] {
    return this.#db
      .all<QuotaRow>(
        `SELECT q.account_id, q.window, q.used_percent, q.resets_at, q.status, q.source, q.observed_at
         FROM quota_observations q
         WHERE q.id = (SELECT id FROM quota_observations
                       WHERE account_id = q.account_id AND window = q.window
                       ORDER BY observed_at DESC, id DESC LIMIT 1)
         ORDER BY q.account_id, q.window`,
      )
      .map((r) => ({
        accountId: r.account_id as AccountId,
        window: r.window,
        usedPercent: r.used_percent,
        resetsAt: r.resets_at,
        status: r.status,
        source: r.source,
        observedAt: r.observed_at,
      }));
  }

  /** Window name → percent at which Orzeus stops scheduling new work on the account. */
  softCaps(accountId: string): Record<string, number> {
    const row = this.#db.get<{ soft_caps_json: string }>(
      "SELECT soft_caps_json FROM provider_accounts WHERE id = ?",
      [accountId],
    );
    return row === undefined ? {} : (JSON.parse(row.soft_caps_json) as Record<string, number>);
  }

  /** Sets (or with null, clears) one window's soft cap. */
  setSoftCap(accountId: string, window: string, percent: number | null): void {
    if (percent !== null && !(percent > 0 && percent <= 100))
      throw new Error("a soft cap is a percentage between 1 and 100");
    this.#db.transaction(() => {
      const caps = this.softCaps(accountId);
      if (this.#db.get("SELECT 1 FROM provider_accounts WHERE id = ?", [accountId]) === undefined)
        throw new Error(`unknown account ${accountId}`);
      if (percent === null) delete caps[window];
      else caps[window] = percent;
      this.#db.run("UPDATE provider_accounts SET soft_caps_json = ? WHERE id = ?", [
        JSON.stringify(caps),
        accountId,
      ]);
    });
  }
}
