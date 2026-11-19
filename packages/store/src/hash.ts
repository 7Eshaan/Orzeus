import { createHash } from "node:crypto";
import type { Sha256 } from "@orzeus/schema";
import type { HashFn } from "@orzeus/trace";

/** SHA-256 over UTF-8 text, lowercase hex. The HashFn implementation for @orzeus/trace. */
export const sha256Text: HashFn = (text) =>
  createHash("sha256").update(text, "utf8").digest("hex") as Sha256;

export function sha256Bytes(bytes: Uint8Array): Sha256 {
  return createHash("sha256").update(bytes).digest("hex") as Sha256;
}
