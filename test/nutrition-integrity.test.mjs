import assert from "node:assert/strict";
import test from "node:test";

import { toConvertibleGrams } from "../api/_lib.js";

test("fallback food scaling only accepts exact mass conversions", () => {
  assert.equal(toConvertibleGrams(250, "g"), 250);
  assert.equal(toConvertibleGrams(2, "oz"), 56.699);
  assert.equal(toConvertibleGrams(1, "lb"), 453.592);
  assert.equal(toConvertibleGrams(1.5, "kg"), 1500);

  for (const guessedUnit of ["serving", "egg", "scoop", "cup", "tbsp", "tsp", ""]) {
    assert.equal(toConvertibleGrams(2, guessedUnit), null);
  }
  assert.equal(toConvertibleGrams(-1, "g"), null);
  assert.equal(toConvertibleGrams(Number.NaN, "g"), null);
});
