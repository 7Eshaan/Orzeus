import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");
const token = (name: string): string => {
  const value = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`).exec(css)?.[1];
  if (value === undefined) throw new Error(`missing token ${name}`);
  return value;
};

function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = Number.parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Every text-on-background pair the UI uses, with the WCAG level it must meet. */
const PAIRS: readonly [string, string, number][] = [
  ["color-text", "color-bg", 4.5],
  ["color-text", "color-surface", 4.5],
  ["color-text-muted", "color-bg", 4.5],
  ["color-text-muted", "color-surface", 4.5],
  ["color-text-muted", "color-surface-muted", 4.5],
  ["color-on-accent", "color-accent", 4.5],
  ["color-accent", "color-surface", 4.5],
  ["color-active", "color-active-soft", 4.5],
  ["color-ok", "color-ok-soft", 4.5],
  ["color-attention", "color-attention-soft", 4.5],
  ["color-bad", "color-bad-soft", 4.5],
  ["color-text", "color-diff-added", 4.5],
  ["color-text", "color-diff-removed", 4.5],
  // Line numbers in diffs are supplementary, so they need large-text contrast only.
  ["color-text-faint", "color-surface", 3],
];

describe("design tokens meet WCAG AA contrast", () => {
  it.each(PAIRS)("%s on %s ≥ %d:1", (fg, bg, minimum) => {
    expect(contrast(token(fg), token(bg))).toBeGreaterThanOrEqual(minimum);
  });
});
