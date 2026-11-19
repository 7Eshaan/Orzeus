import { describe, expect, it } from "vitest";
import { formatEnv, joinArgs, lines, parseEnv, slugify, splitArgs } from "./argv.js";

describe("argv", () => {
  it("splits on whitespace and keeps quoted spaces", () => {
    expect(splitArgs(`node -e "console.log('a b')"  x ''`)).toEqual([
      "node",
      "-e",
      "console.log('a b')",
      "x",
      "",
    ]);
    expect(() => splitArgs(`echo "oops`)).toThrow(/unclosed/);
  });

  it("joins so that splitting gives the same argv back", () => {
    const argv = ["node", "-e", "require('fs')", "a b", "", 'say "hi"'];
    expect(splitArgs(joinArgs(argv))).toEqual(argv);
  });

  it("parses KEY=value lines", () => {
    expect(parseEnv("# comment\nA=1\n\nB_2 = x=y")).toEqual({ A: "1", B_2: " x=y" });
    expect(() => parseEnv("not a pair")).toThrow(/KEY=value/);
    expect(formatEnv({ A: "1", B: "2" })).toBe("A=1\nB=2");
  });

  it("makes ids and trims lines", () => {
    expect(slugify("My GitHub Server!")).toBe("my-github-server");
    expect(slugify("***")).toBe("item");
    expect(lines(" a \n\n b")).toEqual(["a", "b"]);
  });
});
