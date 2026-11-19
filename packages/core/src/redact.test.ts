import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createRedactor, REDACTED } from "./redact.js";

describe("createRedactor", () => {
  const redact = createRedactor(["my-very-secret-value", "short", undefined]);

  it("replaces known secrets and common key formats", () => {
    const text = [
      "key=my-very-secret-value",
      "anthropic sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx",
      "openai sk-proj-AbCdEfGhIjKlMnOpQrStUvWx12",
      "gh ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "aws AKIAABCDEFGHIJKLMNOP",
      "Authorization: Bearer abcdefghijklmnop.qrstuv",
      "-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----",
    ].join("\n");
    const out = redact(text);
    for (const leaked of [
      "my-very-secret",
      "sk-ant-api03",
      "sk-proj-",
      "ghp_",
      "AKIA",
      "abcdefghijklmnop.",
      "MIIE",
    ])
      expect(out).not.toContain(leaked);
    expect(out).toContain(`Bearer ${REDACTED}`);
  });

  it("leaves ordinary text and short values alone", () => {
    const text = "short notes about the skeleton key and a task list";
    expect(redact(text)).toBe(text);
  });

  it("never lets a known secret through, wherever it appears", () => {
    const secret = "S3cr3t-Value-0123456789";
    const r = createRedactor([secret]);
    fc.assert(
      fc.property(fc.string(), fc.string(), (before, after) => {
        expect(r(`${before}${secret}${after}`)).not.toContain(secret);
      }),
    );
  });
});
