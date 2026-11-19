import type { ModelRef } from "@orzeus/schema";
import type { AccountContext, ProviderAdapter } from "./adapter.js";

export interface RegisteredAdapter {
  readonly adapter: ProviderAdapter;
  readonly account: AccountContext;
}

/** Adapters available to a run, keyed by adapter id, each with the account it uses. */
export class AdapterRegistry {
  readonly #entries = new Map<string, RegisteredAdapter>();

  register(adapter: ProviderAdapter, account: AccountContext): this {
    this.#entries.set(adapter.manifest.id, { adapter, account });
    return this;
  }

  get(adapterId: string): RegisteredAdapter | undefined {
    return this.#entries.get(adapterId);
  }

  /** First candidate whose adapter is registered and can run agent sessions. */
  pick(
    candidates: readonly ModelRef[],
  ): { readonly model: ModelRef; readonly entry: RegisteredAdapter } | null {
    for (const model of candidates) {
      const entry = this.#entries.get(model.adapter);
      if (
        entry?.adapter.manifest.capabilities.agentSession &&
        entry.adapter.startSession !== undefined
      ) {
        return { model, entry };
      }
    }
    return null;
  }

  ids(): string[] {
    return [...this.#entries.keys()];
  }
}
