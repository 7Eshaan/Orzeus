import { zstdCompressSync, zstdDecompressSync } from "node:zlib";
import type { Sha256 } from "@orzeus/schema";
import type { Db } from "./db.js";
import { sha256Bytes } from "./hash.js";

/** Content above this size is stored zstd-compressed. */
const COMPRESS_ABOVE_BYTES = 1024;

export interface StoredBlob {
  readonly hash: Sha256;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
}

/**
 * Content-addressed, immutable storage for packets, diffs, prompts and check output. The hash is
 * over the uncompressed bytes, so it is what the trace chain refers to.
 */
export class BlobStore {
  readonly #db: Db;
  readonly #now: () => number;

  constructor(db: Db, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
  }

  put(content: Uint8Array | string, mediaType: string): Sha256 {
    const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
    const hash = sha256Bytes(bytes);
    if (this.has(hash)) return hash;
    const compress = bytes.byteLength > COMPRESS_ABOVE_BYTES;
    this.#db.run(
      "INSERT INTO blobs (hash, media_type, size, encoding, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      [
        hash,
        mediaType,
        bytes.byteLength,
        compress ? "zstd" : "identity",
        compress ? zstdCompressSync(bytes) : bytes,
        this.#now(),
      ],
    );
    return hash;
  }

  has(hash: Sha256): boolean {
    return this.#db.get("SELECT 1 AS present FROM blobs WHERE hash = ?", [hash]) !== undefined;
  }

  get(hash: Sha256): StoredBlob | undefined {
    const row = this.#db.get<{ media_type: string; encoding: string; bytes: Uint8Array }>(
      "SELECT media_type, encoding, bytes FROM blobs WHERE hash = ?",
      [hash],
    );
    if (row === undefined) return undefined;
    const bytes =
      row.encoding === "zstd"
        ? new Uint8Array(zstdDecompressSync(row.bytes))
        : new Uint8Array(row.bytes);
    return { hash, mediaType: row.media_type, bytes };
  }

  /** Re-hashes stored content; false means the blob was corrupted or tampered with. */
  verify(hash: Sha256): boolean {
    const blob = this.get(hash);
    return blob !== undefined && sha256Bytes(blob.bytes) === hash;
  }
}
