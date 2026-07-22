import assert from "node:assert/strict";
import test from "node:test";

import {
  foodMatchQuality,
  normalizeParsedFoodQuantity,
  pickWholeFoodReferenceMeasure,
  pickBestFood,
  resolveNutritionLookup,
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

test("plain sweet potato beats unrequested processed sweet-potato products", () => {
  const plain = {
    description: "Sweet potato, cooked, baked in skin, flesh, without salt",
    score: 10,
  };
  const processed = [
    "Sweet potato tots",
    "Sweet potato fries",
    "Sweet potato paste",
    "Sweet potato puree",
    "Sweet potato casserole",
    "Sweet potato, mashed",
    "Sweet potato, candied",
    "Sweet potato, NFS",
    "Sweet potato leaves, raw",
    "Bread, sweet potato",
    "Pie, sweet potato",
    "Sweet potato pakora",
  ].map((description) => ({ description, score: 100 }));

  for (const food of processed) {
    assert.equal(
      foodMatchQuality("sweet potato", food).credible,
      false,
      food.description
    );
  }
  assert.equal(
    pickBestFood([...processed, plain], "sweet potato"),
    plain
  );
  assert.equal(
    foodMatchQuality("sweet potato fries", processed[1]).credible,
    true
  );
});

test("generic sweet potato lookup expands to a plain whole-food reference", async () => {
  const searched = [];
  const nfs = {
    fdcId: 1,
    description: "Sweet potato, NFS",
    score: 100,
    _src: "usda",
    nutrients: { kcal: 115, protein: 1.6, fat: 4.5, carbs: 17.1 },
  };
  const raw = {
    fdcId: 2,
    description: "Sweet potato, raw, unprepared",
    score: 50,
    _src: "usda",
    nutrients: { kcal: 86, protein: 1.6, fat: 0.1, carbs: 20.1 },
  };
  const result = await resolveNutritionLookup(
    { query: "sweet potato", amount: 0.75, unit: "lb" },
    {
      foodSearchFn: async (query) => {
        searched.push(query);
        return { foods: query.includes("raw") ? [raw] : [nfs], errors: [] };
      },
    }
  );

  assert.deepEqual(searched, ["Sweet potato, raw, unprepared", "sweet potato"]);
  assert.equal(result.match.description, raw.description);
  assert.equal(result.nutrition.kcal, 292.6);
  assert.equal(result.nutrition.fat, 0.3);
});

test("read-only nutrition lookup scales verified food data to an explicit mass", async () => {
  const sourceFood = {
    fdcId: 123,
    description: "Sweet potato, cooked, baked in skin, flesh, without salt",
    score: 50,
    _src: "usda",
    nutrients: {
      kcal: 90,
      protein: 2,
      fat: 0.2,
      carbs: 20.7,
      fiber: 3.3,
      potassium: 475,
    },
  };
  const result = await resolveNutritionLookup(
    { query: "sweet potato", amount: 0.75, unit: "lb" },
    {
      foodSearchFn: async () => ({ foods: [sourceFood], errors: [] }),
    }
  );

  assert.equal(result.match.description, sourceFood.description);
  assert.equal(result.portion_basis.kind, "explicit_mass");
  assert.equal(result.portion_basis.estimated, false);
  assert.equal(result.portion_basis.label, "0.75 lb");
  assert.ok(Math.abs(result.portion_basis.grams - 340.194) < 0.001);
  assert.equal(result.nutrition.kcal, 306.2);
  assert.equal(result.nutrition.carbs, 70.4);
  assert.equal(result.nutrition_basis.kind, "database_per_100g");
  assert.equal(result.writes_ledger, false);
});

test("whole-food reference sizes use an exact USDA size and reject household forms", async () => {
  const sourceFood = {
    fdcId: 456,
    description: "Sweet potato, cooked, baked in skin",
    score: 50,
    _src: "usda",
    nutrients: { kcal: 90, protein: 2, fat: 0.2, carbs: 20.7 },
    foodMeasures: [
      { amount: 1, gramWeight: 130, label: "1 medium sweet potato" },
      { amount: 1, gramWeight: 200, label: "1 cup mashed" },
      { amount: 1, gramWeight: 60, label: "1 small sweet potato" },
    ],
  };

  assert.deepEqual(pickWholeFoodReferenceMeasure(sourceFood, { size: "medium" }), {
    grams: 130,
    label: "1 medium sweet potato",
    size: "medium",
    estimated: true,
  });
  assert.equal(
    pickWholeFoodReferenceMeasure(
      { ...sourceFood, foodMeasures: [{ amount: 1, gramWeight: 200, label: "1 cup mashed" }] },
      { size: "medium" }
    ),
    null
  );
  assert.equal(
    pickWholeFoodReferenceMeasure(sourceFood, { size: "large" }),
    null
  );

  const result = await resolveNutritionLookup(
    { query: "sweet potato", amount: 1, unit: "piece", size: "medium" },
    { foodSearchFn: async () => ({ foods: [sourceFood], errors: [] }) }
  );
  assert.equal(result.portion_basis.kind, "usda_reference_size");
  assert.equal(result.portion_basis.estimated, true);
  assert.equal(result.portion_basis.grams, 130);
  assert.equal(result.nutrition.kcal, 117);
  assert.equal(result.writes_ledger, false);

  const realUsdaStyleFood = {
    ...sourceFood,
    description: "Sweet potato, raw, unprepared",
    foodMeasures: [
      { amount: 1, gramWeight: 133, modifier: "cup, cubes" },
      { amount: 1, gramWeight: 130, modifier: 'sweetpotato, 5" long' },
    ],
  };
  assert.deepEqual(
    pickWholeFoodReferenceMeasure(realUsdaStyleFood, { size: "medium" }),
    {
      grams: 130,
      label: 'sweetpotato, 5" long',
      size: "medium",
      estimated: true,
    }
  );
});

test("an unusable nutrition match returns an explicit tool error", async () => {
  const result = await resolveNutritionLookup(
    { query: "mystery food" },
    {
      foodSearchFn: async () => ({
        foods: [
          {
            fdcId: 999,
            description: "Mystery food",
            score: 50,
            _src: "usda",
            nutrients: {},
          },
        ],
        errors: [],
      }),
    }
  );

  assert.equal(result.nutrition, null);
  assert.equal(result.error.code, "TOOL_UNAVAILABLE");
  assert.match(result.error.message, /usable nutrition/i);
});
