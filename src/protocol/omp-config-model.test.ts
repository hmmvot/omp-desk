import assert from "node:assert/strict";
import { test } from "node:test";
import { parseNumericInput } from "./omp-config-model.ts";

test("a typed number is a plain finite number, whole when the setting is", () => {
  assert.deepEqual(parseNumericInput(" 300000 ", true), { value: 300000 });
  assert.deepEqual(parseNumericInput("0.5", false), { value: 0.5 });
  assert.deepEqual(parseNumericInput("1e3", true), { value: 1000 });
  assert.deepEqual(parseNumericInput("-0", true), { value: 0 });
  assert.deepEqual(parseNumericInput("-5", true), { value: -5 }, "OMP's registry declares no bounds");
  assert.deepEqual(parseNumericInput("1.5", true), { error: "Enter a whole number." });
  assert.deepEqual(parseNumericInput("", false), { error: "Enter a number." });
  for (const text of ["abc", "12px", "1,5", "0x10", "NaN", "Infinity", "--1", "1 2", "."]) assert.match((parseNumericInput(text, false) as { error: string }).error, /plain number/, text);
  assert.deepEqual(parseNumericInput("1e999", false), { error: "That number is too large." });
});
