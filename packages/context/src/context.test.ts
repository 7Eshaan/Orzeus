import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Git } from "@orzeus/git";
import { createFixtureRepo } from "@orzeus/git/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildRepoMap, renderRepoMap } from "./repo-map.js";
import { resolveContextRef } from "./resolve.js";
import { extractSymbols } from "./symbols.js";

const TS = `import { x } from "./x.js";
export class AuthService {
  constructor(private readonly secret: string) {}
  refresh(token: string): string {
    return token + this.secret;
  }
}
export function login(user: string) {
  return user;
}
export const logout = () => true;
const internal = 1;
export interface Session { id: string }
export type Token = string;
`;

const PY = `class Store:
    def get(self, key):
        return key

    def _private(self):
        pass

def helper():
    return 1
`;

let dir: string;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "orzeus-context-"));
  await createFixtureRepo(dir, { "src/auth.ts": TS, "tools/store.py": PY, "README.md": "# hi\n" });
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("extractSymbols", () => {
  it("finds classes, methods, functions, interfaces and types in TypeScript", async () => {
    const symbols = await extractSymbols("typescript", TS);
    expect(symbols.map((s) => [s.kind, s.name, s.startLine, s.endLine, s.exported])).toEqual([
      ["class", "AuthService", 2, 7, true],
      ["method", "AuthService.refresh", 4, 6, true],
      ["function", "login", 8, 10, true],
      ["function", "logout", 11, 11, true],
      ["interface", "Session", 13, 13, true],
      ["type", "Token", 14, 14, true],
    ]);
  });

  it("finds Python classes, methods and functions", async () => {
    const symbols = await extractSymbols("python", PY);
    expect(symbols.map((s) => `${s.kind}:${s.name}:${s.exported}`)).toEqual([
      "class:Store:true",
      "method:Store.get:true",
      "method:Store._private:false",
      "function:helper:true",
    ]);
  });
});

describe("repo map", () => {
  it("lists files with symbols and renders within a budget", async () => {
    const map = await buildRepoMap(new Git(), dir);
    expect(map.files.map((f) => f.path)).toEqual(["README.md", "src/auth.ts", "tools/store.py"]);
    const text = renderRepoMap(map);
    expect(text).toContain(
      "src/auth.ts (15 lines): class AuthService 2-7; method AuthService.refresh 4-6",
    );
    const tiny = renderRepoMap(map, 60);
    expect(tiny.length).toBeLessThan(120);
    expect(tiny).toContain("more files not shown");
  });
});

describe("resolveContextRef", () => {
  it("returns numbered lines for ranges and symbols", async () => {
    const range = await resolveContextRef(
      { kind: "file_range", path: "src/auth.ts", startLine: 8, endLine: 9, why: "x" },
      dir,
    );
    expect(range.text).toBe("    8  export function login(user: string) {\n    9    return user;");
    const symbol = await resolveContextRef(
      { kind: "symbol", path: "src/auth.ts", symbol: "refresh", symbolKind: "method", why: "x" },
      dir,
    );
    expect(symbol.title).toBe("method AuthService.refresh (src/auth.ts:4-6)");
  });

  it("refuses paths outside the worktree and unknown symbols", async () => {
    await expect(
      resolveContextRef(
        { kind: "file_range", path: "../etc/passwd", startLine: 1, endLine: 2, why: "x" },
        dir,
      ),
    ).rejects.toThrow(/outside/);
    await expect(
      resolveContextRef(
        { kind: "symbol", path: "src/auth.ts", symbol: "nope", symbolKind: "function", why: "x" },
        dir,
      ),
    ).rejects.toThrow(/not found/);
  });
});

describe("describeTooling", () => {
  it("reports package.json scripts or their absence", async () => {
    const { describeTooling } = await import("./tooling.js");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }));
    expect(describeTooling(dir)).toContain("no scripts");
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
    expect(describeTooling(dir)).toContain("test = node --test");
  });
});
