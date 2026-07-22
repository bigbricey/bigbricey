import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { offNutrients, pickNutrients } from "../api/_lib.js";
import { rowFromSavedFood } from "../api/_supabase.js";

test("database lookups preserve unknown nutrients instead of inventing zero", () => {
  const usda = pickNutrients([
    { nutrientId: 1008, value: 120 },
    { nutrientId: 1003, value: 10 },
    { nutrientId: 1004, value: 4 },
    { nutrientId: 1005, value: 0 },
  ]);
  assert.equal(usda.carbs, 0, "an explicit database zero stays known");
  assert.equal(usda.fiber, null, "a missing USDA nutrient stays unknown");

  const off = offNutrients({
    "energy-kcal_100g": 120,
    proteins_100g: 10,
    fat_100g: 4,
    carbohydrates_100g: 0,
  });
  assert.equal(off.carbs, 0, "an explicit OFF zero stays known");
  assert.equal(off.fiber, null, "a missing OFF nutrient stays unknown");
});

test("Open Food Facts units are converted only when their source unit is known", () => {
  const off = offNutrients({
    "energy-kcal_100g": 120,
    proteins_100g: 10,
    fat_100g: 4,
    carbohydrates_100g: 1,
    calcium_100g: 0.12,
    calcium_unit: "g",
    "vitamin-a_100g": 0.000149,
    "vitamin-a_unit": "g",
    "vitamin-d_100g": 0.0000022,
    "vitamin-d_unit": "g",
    "omega-3-fat_100g": 0.043,
    "omega-3-fat_unit": "g",
  });
  assert.equal(off.calcium, 120);
  assert.equal(off.vitamin_a, 149);
  assert.ok(Math.abs(off.vitamin_d - 88) < 0.0001);
  assert.equal(off.omega3, 0.043);
  assert.equal(off.b12, null);
});

test("saved foods preserve optional nutrient knownness across storage", () => {
  const base = {
    id: "saved-1",
    name: "Test shake",
    kcal: 200,
    protein: 30,
    fat: 8,
    carbs: 4,
    fiber: 0,
    sugars: 0,
    potassium: 0,
    magnesium: 0,
    sodium: 0,
  };

  const unknown = rowFromSavedFood({
    ...base,
    extras: {
      known_nutrients: ["kcal", "protein", "fat", "carbs"],
    },
  });
  assert.equal(unknown.fiber, undefined);
  assert.equal(unknown.potassium, undefined);

  const explicitZero = rowFromSavedFood({
    ...base,
    extras: {
      known_nutrients: [
        "kcal",
        "protein",
        "fat",
        "carbs",
        "fiber",
        "potassium",
      ],
    },
  });
  assert.equal(explicitZero.fiber, 0);
  assert.equal(explicitZero.potassium, 0);
});

test("food parser has a small explicit completion ceiling", async () => {
  const source = await readFile(new URL("../api/_lib.js", import.meta.url), "utf8");
  const start = source.indexOf("export async function parseFood");
  const end = source.indexOf("export async function openFoodFactsSearch", start);
  assert.match(source.slice(start, end), /maxTokens:\s*250/);
});
