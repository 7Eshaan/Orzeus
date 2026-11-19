import type { AccountContext } from "./adapter.js";

export const USER_AGENT = "orzeus/0.0.0";

/** Reads an API key for accounts that use one; null for keyless (local) accounts. */
export async function apiKeyOf(account: AccountContext): Promise<string | null> {
  return account.auth.kind === "api_key" ? account.getSecret(account.auth.secretName) : null;
}

export async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return text === "" ? null : (JSON.parse(text) as unknown);
  } catch {
    throw new Error(`HTTP ${response.status}: response was not JSON: ${text.slice(0, 300)}`);
  }
}

export class HttpStatusError extends Error {
  override readonly name = "HttpStatusError";
  readonly status: number;

  constructor(status: number, body: unknown) {
    super(`HTTP ${status}: ${JSON.stringify(body).slice(0, 500)}`);
    this.status = status;
  }
}
