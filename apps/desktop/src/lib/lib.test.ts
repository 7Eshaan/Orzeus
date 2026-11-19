import { describe, expect, it } from "vitest";
import { toSideBySide } from "./diff.js";
import { countdown, statusTone, tokens } from "./format.js";
import { layoutDag } from "./layout.js";

describe("format", () => {
  it("formats tokens and countdowns compactly", () => {
    expect([tokens(950), tokens(1_234), tokens(45_000), tokens(3_200_000)]).toEqual([
      "950",
      "1.2k",
      "45k",
      "3.2M",
    ]);
    expect(countdown(1_000 + 90 * 60_000, 1_000)).toBe("1h 30m");
    expect(countdown(0, 5)).toBe("0m");
    expect(statusTone("awaiting_merge_approval")).toBe("attention");
  });
});

describe("toSideBySide", () => {
  it("pairs removed and added lines and keeps context aligned", () => {
    const patch = [
      "diff --git a/src/a.js b/src/a.js",
      "index 1..2 100644",
      "--- a/src/a.js",
      "+++ b/src/a.js",
      "@@ -1,3 +1,4 @@",
      " keep",
      "-old",
      "+new",
      "+extra",
      " tail",
      "diff --git a/b.txt b/b.txt",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/b.txt",
      "@@ -0,0 +1 @@",
      "+hello",
    ].join("\n");
    const files = toSideBySide(patch);
    expect(files.map((f) => f.path)).toEqual(["src/a.js", "b.txt"]);
    expect(
      files[0]?.rows.map((r) => [r.left.text, r.left.kind, r.right.text, r.right.kind]),
    ).toEqual([
      ["keep", "context", "keep", "context"],
      ["old", "removed", "new", "added"],
      ["", "empty", "extra", "added"],
      ["tail", "context", "tail", "context"],
    ]);
    expect(files[0]?.rows[3]?.right.line).toBe(4);
  });
});

describe("layoutDag", () => {
  it("puts nodes in columns by dependency depth", () => {
    const placed = layoutDag([
      { id: "a", dependsOn: [] },
      { id: "b", dependsOn: [] },
      { id: "c", dependsOn: ["a"] },
      { id: "d", dependsOn: ["b", "c"] },
    ]);
    expect(placed.map((p) => [p.id, p.depth])).toEqual([
      ["a", 0],
      ["b", 0],
      ["c", 1],
      ["d", 2],
    ]);
    expect(placed[2]?.y).toBeGreaterThan(0); // single node in its column is centred
  });
});
