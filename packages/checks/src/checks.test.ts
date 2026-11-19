import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { afterAll, describe, expect, it } from "vitest";
import { outOfScope, runChecks } from "./checks.js";
import { HeadTailBuffer } from "./output-buffer.js";
import { runCommand } from "./run-command.js";

const dir = mkdtempSync(join(tmpdir(), "orzeus-checks-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const env = { PATH: process.env["PATH"] ?? "" };
const node = process.execPath;

describe("runCommand", () => {
  it("captures interleaved output and the exit code without a shell", async () => {
    const result = await runCommand(
      [node, "-e", "console.log('out'); console.error('err'); process.exit(3)"],
      {
        cwd: dir,
        env,
        timeoutMs: 10_000,
      },
    );
    expect(result.exitCode).toBe(3);
    expect(result.output).toContain("out");
    expect(result.output).toContain("err");
    const literal = await runCommand(["echo", "$HOME", "&&", "rm"], {
      cwd: dir,
      env,
      timeoutMs: 10_000,
    });
    expect(literal.output.trim()).toBe("$HOME && rm");
  });

  it("kills the whole process group on timeout", async () => {
    const script =
      "require('child_process').spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], {stdio:'inherit'}); setInterval(()=>{}, 1000)";
    const started = Date.now();
    const result = await runCommand([node, "-e", script], {
      cwd: dir,
      env,
      timeoutMs: 300,
      killGraceMs: 200,
    });
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("reports a missing executable as a failure, not a crash", async () => {
    const result = await runCommand(["definitely-not-a-command-orzeus"], {
      cwd: dir,
      env,
      timeoutMs: 1_000,
    });
    expect(result.exitCode).toBeNull();
    expect(result.output).toContain("Failed to start");
  });
});

describe("HeadTailBuffer", () => {
  it("keeps head and tail within the limit", () => {
    fc.assert(
      fc.property(fc.array(fc.string(), { maxLength: 50 }), (chunks) => {
        const buffer = new HeadTailBuffer(100);
        for (const chunk of chunks) buffer.push(chunk);
        const all = chunks.join("");
        if (all.length <= 100) {
          expect(buffer.toString()).toBe(all);
          expect(buffer.truncated).toBe(false);
        } else {
          expect(buffer.toString().startsWith(all.slice(0, 50))).toBe(true);
          expect(buffer.toString().endsWith(all.slice(-50))).toBe(true);
        }
      }),
    );
  });
});

describe("runChecks", () => {
  it("adds the scope guard and runs command checks in the worktree", async () => {
    const results = await runChecks(
      [
        {
          kind: "command",
          id: "ok",
          label: "ok",
          argv: [node, "-e", "process.exit(0)"],
          cwd: ".",
          timeoutMs: 10_000,
          expectExitCode: 0,
        },
      ],
      { worktree: dir, changedPaths: ["src/a.ts", "README.md"], writeScope: ["src/**"] },
    );
    expect(results.map((r) => [r.checkId, r.passed])).toEqual([
      ["scope", false],
      ["ok", true],
    ]);
    expect(results[0]?.output).toContain("README.md");
  });

  it("refuses a cwd outside the worktree", async () => {
    const [, result] = await runChecks(
      [
        {
          kind: "command",
          id: "esc",
          label: "esc",
          argv: [node, "-v"],
          cwd: "../..",
          timeoutMs: 1_000,
          expectExitCode: 0,
        },
      ],
      { worktree: dir, changedPaths: [], writeScope: [] },
    );
    expect(result).toMatchObject({
      passed: false,
      output: expect.stringContaining("outside the worktree"),
    });
  });

  it("outOfScope lists only paths outside the globs", () => {
    expect(outOfScope(["src/a.ts", "docs/x.md", "../evil"], ["src/**"])).toEqual([
      "docs/x.md",
      "../evil",
    ]);
  });
});

describe("scope guard and links", () => {
  it("fails when the attempt created a symbolic link or submodule, even inside the scope", async () => {
    const [result] = await runChecks([], {
      worktree: process.cwd(),
      changedPaths: ["src/link"],
      writeScope: ["src/**"],
      links: ["src/link"],
    });
    expect(result?.passed).toBe(false);
    expect(result?.output).toMatch(/symbolic links or submodules/);
  });
});
