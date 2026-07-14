import assert from "node:assert/strict";
import test from "node:test";

import {
  foodMatchQuality,
  normalizeParsedFoodQuantity,
  pickBestFood,
  toConvertibleGrams,
  toGrams,
  verifiedFoodGrams,
} from "../api/_lib.js";

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

test("new food resolution does not invent generic household or serving weights", () => {
  assert.equal(toGrams(2, "oz"), 56.699);
  for (const guessedUnit of ["serving", "piece", "scoop", "cup", "tbsp", "tsp"]) {
    assert.equal(toGrams(1, guessedUnit), null);
    assert.equal(verifiedFoodGrams({ amount: 1, unit: guessedUnit }, "tilapia"), null);
  }
});

test("an explicit butter stick gets a deterministic fixed mass basis", () => {
  const parsed = normalizeParsedFoodQuantity("half a stick of salted butter", {
    food_query: "salted butter",
    amount: 1,
    unit: "serving",
    grams_estimate: 100,
  });
  assert.equal(parsed.amount, 0.5);
  assert.equal(parsed.unit, "stick");
  assert.equal(parsed.grams_estimate, null);
  assert.ok(Math.abs(verifiedFoodGrams(parsed, "salted butter") - 56.699) < 0.001);
});

test("food matching rejects semantically contaminated products", () => {
  const popcorn = {
    description: "Himalayan Pink Salt popcorn",
    score: 100,
  };
  const pureSalt = {
    description: "Himalayan Pink Salt",
    score: 20,
  };
  assert.equal(foodMatchQuality("himalayan pink salt", popcorn).credible, false);
  assert.equal(foodMatchQuality("himalayan pink salt", pureSalt).credible, true);
  assert.equal(pickBestFood([popcorn, pureSalt], "himalayan pink salt"), pureSalt);
  assert.equal(pickBestFood([popcorn], "himalayan pink salt"), null);

  assert.equal(
    foodMatchQuality("butter", { description: "Butter, light, stick, with salt" })
      .credible,
    false
  );
  assert.equal(
    foodMatchQuality("butter", { description: "Butter, stick, with salt" }).credible,
    true
  );
});
