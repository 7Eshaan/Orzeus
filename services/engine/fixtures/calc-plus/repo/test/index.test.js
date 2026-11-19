import assert from "node:assert/strict";
import { test } from "node:test";
import { add, multiply } from "../src/index.js";

test("index re-exports add and multiply", () => {
  assert.equal(add(1, 2), 3);
  assert.equal(multiply(3, 3), 9);
});
