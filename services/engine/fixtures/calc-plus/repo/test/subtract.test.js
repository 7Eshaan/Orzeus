import assert from "node:assert/strict";
import { test } from "node:test";
import { subtract } from "../src/index.js";

test("subtract is exported from the library", () => {
  assert.equal(subtract(5, 3), 2);
  assert.equal(subtract(0, 4), -4);
});
