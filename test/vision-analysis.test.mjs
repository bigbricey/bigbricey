import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  foodRowFromPer100,
  normalizeBarcode,
} from "../api/_lib.js";
import {
  barcodeFoodToItem,
  calibrationHints,
  labelAnalysisToItem,
  mergeVisionCorrections,
  normalizeVisionAnalysis,
  responseFormatForVision,
  sanitizeVisionCorrections,
  validateImageDataUrl,
  visionPrompt,
} from "../api/_vision.js";

test("vision image input accepts raster data only and enforces a hard byte cap", () => {
  assert.equal(
    validateImageDataUrl("data:image/jpeg;base64," + "a".repeat(200)),
    "data:image/jpeg;base64," + "a".repeat(200)
  );
  assert.throws(
    () => validateImageDataUrl("data:image/svg+xml;base64,PHN2Zz4="),
    (error) => error.code === "invalid_image" && error.status === 400
  );
  assert.throws(
    () => validateImageDataUrl("data:image/jpeg;base64," + "a".repeat(4_100_000)),
    (error) => error.code === "image_too_large" && error.status === 413
  );
});

test("meal analysis keeps an honest bounded range and never contains model macros", () => {
  const analysis = normalizeVisionAnalysis("meal", {
    summary: "Chicken and vegetables",
    overall_confidence: "high",
    items: [
      {
        name: "grilled chicken breast",
        visual_description: "sliced chicken",
        preparation: "grilled",
        brand_hint: null,
        estimated_grams: 180,
        min_grams: 240,
        max_grams: 120,
        confidence: "medium",
        uncertainty: "partly covered",
        kcal: 9999,
      },
    ],
    questions: [],
  });
  assert.equal(analysis.items.length, 1);
  assert.equal(analysis.items[0].estimated_grams, 180);
  assert.equal(analysis.items[0].min_grams, 120);
  assert.equal(analysis.items[0].max_grams, 240);
  assert.equal("kcal" in analysis.items[0], false);
  assert.match(visionPrompt("meal"), /Do not calculate calories or nutrition/);
  assert.equal(responseFormatForVision("meal").json_schema.strict, true);
});

test("label rows preserve printed zeroes while omitting unread nutrients", () => {
  const analysis = normalizeVisionAnalysis("label", {
    product_name: "Plain seltzer",
    brand: "Example",
    serving_size_text: "1 can (355 g)",
    serving_grams: 355,
    servings_per_container: 1,
    confidence: "high",
    nutrients_per_serving: {
      kcal: 0,
      protein: 0,
      fat: 0,
      carbs: 0,
      fiber: null,
      sugars: null,
      potassium: null,
      magnesium: null,
      sodium: 10,
    },
    warnings: [],
  });
  const item = labelAnalysisToItem(analysis);
  assert.equal(item.status, "ready");
  assert.equal(item.row.kcal, 0);
  assert.equal(item.row.carbs, 0);
  assert.equal(item.row.sodium, 10);
  assert.equal("fiber" in item.row, false);
  assert.deepEqual(item.row.extras.known_nutrients, [
    "kcal",
    "protein",
    "fat",
    "carbs",
    "sodium",
  ]);
});

test("barcode validation checks GTIN check digits and exact items require an amount when absent", () => {
  assert.equal(normalizeBarcode("0 12345 67890 5"), "012345678905");
  assert.equal(normalizeBarcode("4006381333931"), "4006381333931");
  assert.equal(normalizeBarcode("012345678906"), null);
  assert.equal(normalizeBarcode("1234"), null);

  const food = {
    fdcId: "012345678905",
    description: "Example food",
    brandOwner: "Example",
    nutrients: { kcal: 200, protein: 10, fat: 8, carbs: 20 },
    servingGrams: null,
    servingText: null,
    sourceUrl: "https://world.openfoodfacts.org/product/012345678905",
    _src: "openfoodfacts-barcode",
  };
  const item = barcodeFoodToItem(food, "012345678905");
  assert.equal(item.status, "needs_amount");
  assert.equal(item.proposed_quantity, null);
  assert.equal(item.base_quantity, 100);
  assert.equal(item.row.kcal, 200);

  const empty = barcodeFoodToItem(
    { ...food, servingGrams: 30, nutrients: {} },
    "012345678905"
  );
  assert.equal(empty.status, "unresolved");
  assert.match(empty.note, /Nutrition Facts label/);
});

test("per-100g rows retain nutrient knownness and scale only known values", () => {
  const row = foodRowFromPer100(
    {
      description: "Test food",
      nutrients: { kcal: 100, protein: 0, fat: null, carbs: 20 },
      _src: "usda",
      fdcId: 1,
    },
    50
  );
  assert.equal(row.kcal, 50);
  assert.equal(row.protein, 0);
  assert.equal(row.carbs, 10);
  assert.equal("fat" in row, false);
  assert.deepEqual(row.extras.known_nutrients, ["kcal", "protein", "carbs"]);
});

test("portion correction memory is bounded, sanitized, and summarized as hints", () => {
  const corrections = sanitizeVisionCorrections(
    [
      { food_name: "chicken breast", estimated_grams: 100, final_grams: 125 },
      { food_name: "bad", estimated_grams: 0, final_grams: 100 },
      { food_name: "wild", estimated_grams: 10, final_grams: 1000 },
    ],
    new Date("2026-07-14T12:00:00.000Z")
  );
  assert.equal(corrections.length, 1);
  assert.equal(corrections[0].ratio, 1.25);
  assert.match(calibrationHints(corrections), /chicken breast: past corrections averaged \+25%/);
  assert.equal(mergeVisionCorrections(Array.from({ length: 50 }, (_, i) => ({ i })), corrections).length, 40);
});

test("photo logging UI is confirmation-gated, state-bound, and never renders model HTML", async () => {
  const [browser, app, html, route, policy] = await Promise.all([
    readFile(new URL("../public/vision.js", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/app.html", import.meta.url), "utf8"),
    readFile(new URL("../api/vision.js", import.meta.url), "utf8"),
    readFile(new URL("../vercel.json", import.meta.url), "utf8"),
  ]);
  assert.match(html, /id="photoBtn"/);
  assert.match(html, /data-vision-mode="meal"/);
  assert.match(html, /data-vision-mode="label"/);
  assert.match(html, /data-vision-mode="barcode"/);
  assert.match(browser, /adapter\.contextMatches\(context\)/);
  assert.match(browser, /await adapter\.commitRows\(proposedRows, context\)/);
  assert.match(browser, /PHOTO DRAFT · NOT LOGGED/);
  assert.doesNotMatch(browser, /innerHTML/);
  assert.match(app, /await syncCloud/);
  assert.match(app, /Logged from your photo after your review/);
  assert.match(route, /requireUser\(req, res\)/);
  assert.match(route, /validateImageDataUrl/);
  assert.match(policy, /camera=\(self\)/);
});
