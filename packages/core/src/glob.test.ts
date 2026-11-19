import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { globToRegExp, matchesAny, normalizeRelativePath, scopesMayOverlap } from "./glob.js";

describe("normalizeRelativePath", () => {
  it("normalizes and refuses paths that escape the root", () => {
    expect(normalizeRelativePath("./src//a/../b.ts")).toBe("src/b.ts");
    expect(normalizeRelativePath("../etc/passwd")).toBeNull();
    expect(normalizeRelativePath("/etc/passwd")).toBeNull();
    expect(normalizeRelativePath("C:\\x")).toBeNull();
    expect(normalizeRelativePath("src\\a.ts")).toBeNull();
  });
});

describe("globToRegExp", () => {
  it.each([
    ["src/**", "src/a/b.ts", true],
    ["src/**", "srcx/a.ts", false],
    ["src/**/*.ts", "src/a.ts", true],
    ["src/**/*.ts", "src/a/b/c.ts", true],
    ["src/*.ts", "src/a/b.ts", false],
    ["src/?.ts", "src/a.ts", true],
    ["a.b+c(d).ts", "a.b+c(d).ts", true],
  ])("%s matches %s → %s", (glob, path, expected) => {
    expect(globToRegExp(glob).test(path)).toBe(expected);
  });

  it("matchesAny normalizes the path first", () => {
    expect(matchesAny("./src/x/../y.ts", ["src/*.ts"])).toBe(true);
    expect(matchesAny("../y.ts", ["**"])).toBe(false);
  });
});

describe("scopesMayOverlap", () => {
  it("separates disjoint directories and read-only scopes", () => {
    expect(scopesMayOverlap(["src/a/**"], ["src/b/**"])).toBe(false);
    expect(scopesMayOverlap([], ["**"])).toBe(false);
    expect(scopesMayOverlap(["src/**"], ["src/a/x.ts"])).toBe(true);
    expect(scopesMayOverlap(["src/a"], ["src/a/**/*.ts"])).toBe(true);
    expect(scopesMayOverlap(["*.md"], ["src/x.ts"])).toBe(true); // conservative
  });

  const segment = fc.constantFrom("src", "lib", "a", "b", "x.ts", "y.md");
  const path = fc.array(segment, { minLength: 1, maxLength: 4 }).map((parts) => parts.join("/"));
  const globFromPath = (p: string, cut: number, mode: number): string => {
    const parts = p.split("/");
    const keep = parts.slice(0, Math.min(cut, parts.length));
    if (mode === 0) return [...keep, "**"].join("/");
    if (mode === 1) return [...keep, "*"].join("/");
    return p;
  };

  it("never misses a real overlap (soundness)", () => {
    fc.assert(
      fc.property(
        path,
        path,
        fc.nat(4),
        fc.nat(2),
        fc.nat(4),
        fc.nat(2),
        fc.array(path, { maxLength: 3 }),
        (p1, p2, c1, m1, c2, m2, probes) => {
          const a = [globFromPath(p1, c1, m1)];
          const b = [globFromPath(p2, c2, m2)];
          for (const probe of [p1, p2, ...probes]) {
            if (matchesAny(probe, a) && matchesAny(probe, b)) {
              expect(scopesMayOverlap(a, b)).toBe(true);
            }
          }
        },
      ),
      { numRuns: 500 },
    );
  });
});
