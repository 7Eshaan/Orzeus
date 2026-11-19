import type { TraceEvent } from "@orzeus/schema";
import { canonicalize } from "./canonical-json.js";

/**
 * One canonical JSON object per line. Canonical form means anyone can re-verify the hashes from
 * the export alone. OTLP export arrives with the Trace Inspector (Phase 5).
 */
export function exportJsonl(events: readonly TraceEvent[]): string {
  return events.map((event) => `${canonicalize(event)}\n`).join("");
}
