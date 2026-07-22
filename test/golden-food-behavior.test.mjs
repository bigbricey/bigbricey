import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeParsedFoodQuantity,
  pickNutrients,
  resolveFood,
} from "../api/_lib.js";

function parserReturning(parsed) {
  return async () => ({ source: "test", parsed });
}

function searchReturning(food, calls = []) {
  return async (query) => {
    calls.push(query);
    return { foods: [{ ...food }], errors: [] };
  };
}

const FULL_NUTRIENTS = {
  kcal: 155,
  protein: 12.6,
  fat: 10.6,
  carbs: 1.12,
  fiber: 0,
  sugars: 1.12,
  potassium: 126,
  magnesium: 10,
  sodium: 124,
  calcium: 50,
  iron: 1.19,
  zinc: 1.05,
  vitamin_a: 149,
  vitamin_c: 0,
  vitamin_d: 87,
  vitamin_e: 1.03,
  vitamin_k: 0.3,
  b12: 1.11,
  folate: 44,
  omega3: 0.043,
};

test("golden: Log four large hard-boiled eggs preserves count and full verified nutrition", async () => {
  const calls = [];
  const result = await resolveFood("Log four large hard-boiled eggs", {
    parseFoodFn: parserReturning({
      food_query: "eggs",
      amount: 1,
      unit: "serving",
      grams_estimate: null,
    }),
    foodSearchFn: searchReturning(
      {
        fdcId: 173424,
        description: "Egg, whole, cooked, hard-boiled",
        dataType: "SR Legacy",
        _src: "usda",
        score: 100,
        nutrients: FULL_NUTRIENTS,
      },
      calls
    ),
  });

  assert.equal(result.parsed.amount, 4);
  assert.equal(result.parsed.unit, "eggs");
  assert.equal(result.row.grams, 200);
  assert.equal(result.row.kcal, 310);
  assert.equal(result.row.calcium, 100);
  assert.equal(result.row.b12, 2.2);
  assert.equal(result.row.extras.provenance.source, "usda");
  assert.equal(result.row.extras.provenance.portion_estimated, false);
  assert.equal(
    result.row.extras.known_nutrients.includes("vitamin_d"),
    true
  );
  assert.equal(calls.includes("Egg, whole, cooked, hard-boiled"), true);
  assert.doesNotMatch(JSON.stringify(result), /<tool_call>|function\.arguments/i);
});

test("golden: I'm having brisket asks only for the genuinely missing quantity", async () => {
  const result = await resolveFood("I'm having brisket", {
    parseFoodFn: parserReturning({
      food_query: "brisket",
      amount: 1,
      unit: "serving",
      grams_estimate: null,
    }),
    foodSearchFn: searchReturning({
      fdcId: 168612,
      description:
        'Beef, brisket, whole, separable lean and fat, trimmed to 0" fat, all grades, cooked, braised',
      dataType: "SR Legacy",
      _src: "usda",
      score: 100,
      nutrients: FULL_NUTRIENTS,
    }),
  });

  assert.equal(result.row, null);
  assert.match(result.note, /give me grams, ounces, pounds/i);
  assert.doesNotMatch(result.note, /brand|recipe|cut|sauce|temperature/i);
});

test("golden: I had one pound of brisket resolves one exact mass once", async () => {
  const result = await resolveFood("I had one pound of brisket", {
    parseFoodFn: parserReturning({
      food_query: "brisket",
      amount: 1,
      unit: "serving",
      grams_estimate: null,
    }),
    foodSearchFn: searchReturning({
      fdcId: 168612,
      description:
        'Beef, brisket, whole, separable lean and fat, trimmed to 0" fat, all grades, cooked, braised',
      dataType: "SR Legacy",
      _src: "usda",
      score: 100,
      nutrients: FULL_NUTRIENTS,
    }),
  });

  assert.equal(result.parsed.amount, 1);
  assert.equal(result.parsed.unit, "lb");
  assert.ok(Math.abs(result.row.grams - 453.6) < 0.01);
  assert.equal(result.row.extras.provenance.selected_portion_grams, 453.6);
  assert.equal(result.row.extras.provenance.preparation, "cooked");
  assert.equal(result.row.extras.known_nutrients.length, 20);
});

test("USDA nutrient normalization retains the complete supported nutrient set", () => {
  const rows = [
    [1008, "Energy", "KCAL", 155],
    [1003, "Protein", "G", 12.6],
    [1004, "Total lipid (fat)", "G", 10.6],
    [1005, "Carbohydrate, by difference", "G", 1.12],
    [1079, "Fiber, total dietary", "G", 0],
    [2000, "Sugars, total including NLEA", "G", 1.12],
    [1092, "Potassium, K", "MG", 126],
    [1090, "Magnesium, Mg", "MG", 10],
    [1093, "Sodium, Na", "MG", 124],
    [1087, "Calcium, Ca", "MG", 50],
    [1089, "Iron, Fe", "MG", 1.19],
    [1095, "Zinc, Zn", "MG", 1.05],
    [1106, "Vitamin A, RAE", "UG", 149],
    [1162, "Vitamin C, total ascorbic acid", "MG", 0],
    [1110, "Vitamin D (D2 + D3), International Units", "IU", 87],
    [1109, "Vitamin E (alpha-tocopherol)", "MG", 1.03],
    [1185, "Vitamin K (phylloquinone)", "UG", 0.3],
    [1178, "Vitamin B-12", "UG", 1.11],
    [1190, "Folate, DFE", "UG", 44],
    [1272, "PUFA 22:6 n-3 (DHA)", "G", 0.038],
    [1278, "PUFA 20:5 n-3 (EPA)", "G", 0.005],
  ].map(([nutrientId, nutrientName, unitName, value]) => ({
    nutrientId,
    nutrientName,
    unitName,
    value,
  }));

  assert.deepEqual(pickNutrients(rows), FULL_NUTRIENTS);
});

test("spoken quantities override a generic model serving fallback", () => {
  assert.deepEqual(
    normalizeParsedFoodQuantity("four large hard-boiled eggs", {
      food_query: "eggs",
      amount: 1,
      unit: "serving",
      grams_estimate: null,
    }),
    {
      food_query: "hard-boiled egg",
      amount: 4,
      unit: "eggs",
      grams_estimate: 200,
    }
  );
  const brisket = normalizeParsedFoodQuantity("one pound of brisket", {
    food_query: "brisket",
    amount: 1,
    unit: "serving",
    grams_estimate: null,
  });
  assert.equal(brisket.amount, 1);
  assert.equal(brisket.unit, "lb");
  assert.equal(brisket.grams_estimate, 453.592);
});
