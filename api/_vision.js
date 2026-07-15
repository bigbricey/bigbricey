import crypto from "crypto";

import { foodRowFromPer100, round } from "./_lib.js";

export const VISION_MODEL_DEFAULT = "google/gemini-3.1-flash-lite";
export const VISION_MODEL_FALLBACK_DEFAULT = "google/gemini-2.5-flash";

const CONFIDENCE = new Set(["low", "medium", "high"]);
const NUTRIENT_KEYS = [
  "kcal",
  "protein",
  "fat",
  "carbs",
  "fiber",
  "sugars",
  "potassium",
  "magnesium",
  "sodium",
];

const nullableNumber = { type: ["number", "null"] };
const nullableString = { type: ["string", "null"] };

const mealSchema = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "overall_confidence", "items", "questions"],
  properties: {
    summary: { type: "string" },
    overall_confidence: { type: "string", enum: ["low", "medium", "high"] },
    items: {
      type: "array",
      minItems: 0,
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "name",
          "visual_description",
          "preparation",
          "brand_hint",
          "estimated_grams",
          "min_grams",
          "max_grams",
          "confidence",
          "uncertainty",
        ],
        properties: {
          name: { type: "string" },
          visual_description: { type: "string" },
          preparation: nullableString,
          brand_hint: nullableString,
          estimated_grams: { type: "number" },
          min_grams: { type: "number" },
          max_grams: { type: "number" },
          confidence: { type: "string", enum: ["low", "medium", "high"] },
          uncertainty: { type: "string" },
        },
      },
    },
    questions: { type: "array", maxItems: 3, items: { type: "string" } },
  },
};

const labelSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "product_name",
    "brand",
    "serving_size_text",
    "serving_grams",
    "servings_per_container",
    "confidence",
    "nutrients_per_serving",
    "warnings",
  ],
  properties: {
    product_name: { type: "string" },
    brand: nullableString,
    serving_size_text: nullableString,
    serving_grams: nullableNumber,
    servings_per_container: nullableNumber,
    confidence: { type: "string", enum: ["low", "medium", "high"] },
    nutrients_per_serving: {
      type: "object",
      additionalProperties: false,
      required: NUTRIENT_KEYS,
      properties: Object.fromEntries(NUTRIENT_KEYS.map((key) => [key, nullableNumber])),
    },
    warnings: { type: "array", maxItems: 4, items: { type: "string" } },
  },
};

const barcodeSchema = {
  type: "object",
  additionalProperties: false,
  required: ["barcode", "product_name_hint", "confidence", "warning"],
  properties: {
    barcode: nullableString,
    product_name_hint: nullableString,
    confidence: { type: "string", enum: ["low", "medium", "high"] },
    warning: nullableString,
  },
};

export function visionModels() {
  const primary =
    process.env.OPENROUTER_VISION_MODEL ||
    process.env.VISION_MODEL ||
    VISION_MODEL_DEFAULT;
  const fallback =
    process.env.OPENROUTER_VISION_FALLBACK_MODEL ||
    process.env.VISION_FALLBACK_MODEL ||
    VISION_MODEL_FALLBACK_DEFAULT;
  return {
    primary: String(primary).trim(),
    fallback: String(fallback).trim(),
  };
}

export function normalizeVisionMode(value) {
  const mode = String(value || "").trim().toLowerCase();
  if (["meal", "plate", "food"].includes(mode)) return "meal";
  if (["label", "nutrition-label", "nutrition_label"].includes(mode)) return "label";
  if (["barcode", "upc", "ean", "gtin"].includes(mode)) return "barcode";
  return null;
}

export function validateImageDataUrl(value) {
  const image = String(value || "");
  const match = image.match(/^data:image\/(jpeg|jpg|png|webp);base64,([a-z0-9+/=]+)$/i);
  if (!match) {
    const error = new Error("Use a JPEG, PNG, or WebP photo.");
    error.code = "invalid_image";
    error.status = 400;
    throw error;
  }
  const bytes = Math.floor((match[2].length * 3) / 4);
  if (bytes < 100 || bytes > 3_000_000) {
    const error = new Error("That photo is too large. Try a closer, simpler photo.");
    error.code = "image_too_large";
    error.status = 413;
    throw error;
  }
  return image;
}

export function responseFormatForVision(mode) {
  const schema = mode === "meal" ? mealSchema : mode === "label" ? labelSchema : barcodeSchema;
  return {
    type: "json_schema",
    json_schema: {
      name: `bigbricey_${mode}_photo`,
      strict: true,
      schema,
    },
  };
}

function safeText(value, max = 180) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function nullableText(value, max = 180) {
  const text = safeText(value, max);
  return text || null;
}

function finite(value, { min = 0, max = 1_000_000, nullable = true } = {}) {
  if (value == null || value === "") return nullable ? null : min;
  const number = Number(value);
  if (!Number.isFinite(number)) return nullable ? null : min;
  return Math.min(max, Math.max(min, number));
}

function confidence(value) {
  const normalized = String(value || "").toLowerCase();
  return CONFIDENCE.has(normalized) ? normalized : "low";
}

export function visionPrompt(mode, { calibration = "" } = {}) {
  if (mode === "meal") {
    return `You analyze one meal photo for a private nutrition log.
Identify each visually distinct edible component, not the plate, utensils, packaging, or garnish unless it is meaningfully consumed.
Estimate edible grams for each component and give an honest minimum and maximum. One photo has no true scale: use visible plate/hand/utensil cues, food geometry, density, cooking method, and ordinary portions, but never pretend the weight is exact.
Use short database-searchable food names. Include cooking method and visible sauces/oils when supported by the image. Do not calculate calories or nutrition; the server will use food databases.
Return at most 8 items. If the image is unusable, return no items and one short question.
${calibration ? `This user's past portion corrections may help. Treat them as hints, not facts:\n${calibration}` : ""}`;
  }
  if (mode === "label") {
    return `Read the printed Nutrition Facts label in this photo.
Copy values from the per-serving column only. Do not infer, calculate, or fill missing nutrients. Use null for anything not clearly printed. Calories are kcal; protein, fat, carbs, fiber, and sugars are grams; potassium, magnesium, and sodium are milligrams.
If the label has multiple columns or the photo is cut off, state that in warnings. product_name may be "Packaged food" when the name is not visible.`;
  }
  return `Read the UPC-A, UPC-E, EAN-8, EAN-13, or GTIN-14 barcode digits visible in this photo.
Return digits only. Do not repair, invent, or guess a missing digit. If the complete code is not clearly visible, return null and explain briefly in warning. Product name is only a hint; the server will verify the code against exact product databases.`;
}

export function parseVisionJson(content) {
  const raw = String(content || "").trim();
  const unfenced = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(unfenced);
  } catch {
    const match = unfenced.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("vision_invalid_json");
    return JSON.parse(match[0]);
  }
}

export function normalizeVisionAnalysis(mode, value) {
  const data = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  if (mode === "meal") {
    const items = (Array.isArray(data.items) ? data.items : [])
      .slice(0, 8)
      .map((item) => {
        const name = safeText(item?.name, 120);
        const estimate = finite(item?.estimated_grams, { min: 1, max: 5_000 });
        if (!name || estimate == null) return null;
        let min = finite(item?.min_grams, { min: 1, max: 5_000 }) ?? estimate;
        let max = finite(item?.max_grams, { min: 1, max: 5_000 }) ?? estimate;
        if (min > max) [min, max] = [max, min];
        min = Math.min(min, estimate);
        max = Math.max(max, estimate);
        return {
          name,
          visual_description: safeText(item?.visual_description, 180),
          preparation: nullableText(item?.preparation, 100),
          brand_hint: nullableText(item?.brand_hint, 100),
          estimated_grams: round(estimate),
          min_grams: round(min),
          max_grams: round(max),
          confidence: confidence(item?.confidence),
          uncertainty: safeText(item?.uncertainty, 180),
        };
      })
      .filter(Boolean);
    return {
      mode,
      summary: safeText(data.summary, 240) || "Meal photo analyzed.",
      overall_confidence: confidence(data.overall_confidence),
      items,
      questions: (Array.isArray(data.questions) ? data.questions : [])
        .map((question) => safeText(question, 180))
        .filter(Boolean)
        .slice(0, 3),
    };
  }
  if (mode === "label") {
    const nutrients = {};
    for (const key of NUTRIENT_KEYS) {
      const max = key === "kcal" ? 10_000 : ["potassium", "magnesium", "sodium"].includes(key) ? 1_000_000 : 5_000;
      nutrients[key] = finite(data?.nutrients_per_serving?.[key], { min: 0, max });
    }
    return {
      mode,
      product_name: safeText(data.product_name, 160) || "Packaged food",
      brand: nullableText(data.brand, 120),
      serving_size_text: nullableText(data.serving_size_text, 120),
      serving_grams: finite(data.serving_grams, { min: 0.1, max: 10_000 }),
      servings_per_container: finite(data.servings_per_container, { min: 0.01, max: 100_000 }),
      confidence: confidence(data.confidence),
      nutrients_per_serving: nutrients,
      warnings: (Array.isArray(data.warnings) ? data.warnings : [])
        .map((warning) => safeText(warning, 180))
        .filter(Boolean)
        .slice(0, 4),
    };
  }
  return {
    mode: "barcode",
    barcode: nullableText(data.barcode, 32)?.replace(/\D/g, "") || null,
    product_name_hint: nullableText(data.product_name_hint, 160),
    confidence: confidence(data.confidence),
    warning: nullableText(data.warning, 200),
  };
}

export function labelAnalysisToItem(analysis) {
  const labelName = [analysis.brand, analysis.product_name].filter(Boolean).join(" ").trim();
  const row = {
    id: crypto.randomUUID(),
    label: `1 serving ${labelName || "Packaged food"}`,
    source: "nutrition-label",
    fdcId: null,
  };
  if (analysis.serving_grams != null) row.grams = round(analysis.serving_grams);
  const known = [];
  for (const key of NUTRIENT_KEYS) {
    const value = analysis.nutrients_per_serving?.[key];
    if (value == null || !Number.isFinite(Number(value))) continue;
    row[key] = round(value);
    known.push(key);
  }
  if (known.length) {
    row.extras = {
      known_nutrients: known,
      nutrition_basis: "printed per serving",
      serving_size_text: analysis.serving_size_text,
    };
  }
  const usable = ["kcal", "protein", "fat", "carbs"].some((key) => row[key] != null);
  return {
    id: crypto.randomUUID(),
    status: usable ? "ready" : "unresolved",
    name: labelName || "Packaged food",
    identified_as: analysis.serving_size_text || "1 printed serving",
    confidence: analysis.confidence,
    quantity_kind: "servings",
    quantity_label: "Servings",
    base_quantity: 1,
    proposed_quantity: 1,
    min_quantity: null,
    max_quantity: null,
    row,
    source_label: "Printed nutrition label",
    source_url: null,
    note: analysis.warnings.join(" ") || "Values copied from the visible per-serving column.",
  };
}

export function barcodeFoodToItem(food, code) {
  if (!food) return null;
  const serving = Number(food.servingGrams);
  const hasServing = Number.isFinite(serving) && serving > 0;
  const basis = hasServing ? serving : 100;
  const row = foodRowFromPer100(food, basis, {
    label: `${round(basis)} g ${food.description}`,
  });
  if (!row) return null;
  const usableNutrition = ["kcal", "protein", "fat", "carbs"].some(
    (key) => row[key] != null && Number.isFinite(Number(row[key]))
  );
  row.extras = {
    ...(row.extras || {}),
    barcode: code,
    nutrition_basis: "database per 100 g",
    serving_text: food.servingText || null,
  };
  return {
    id: crypto.randomUUID(),
    status: !usableNutrition ? "unresolved" : hasServing ? "ready" : "needs_amount",
    name: [food.brandOwner, food.description]
      .filter(Boolean)
      .join(" · ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 280),
    identified_as: food.servingText || "Exact barcode match",
    confidence: "high",
    quantity_kind: "grams",
    quantity_label: "Grams eaten",
    base_quantity: round(basis),
    proposed_quantity: hasServing ? round(serving) : null,
    min_quantity: null,
    max_quantity: null,
    row,
    source_label:
      food._src === "usda-barcode" ? "USDA FoodData Central" : "Open Food Facts",
    source_url: food.sourceUrl || null,
    note: !usableNutrition
      ? "The exact product was found, but its database record has no usable nutrition. Photograph the Nutrition Facts label instead."
      : hasServing
        ? `Started with the database serving: ${food.servingText || `${round(serving)} g`}.`
        : "Exact product found. Enter how many grams you ate before logging.",
    barcode: code,
  };
}

export function sanitizeVisionCorrections(value, now = new Date()) {
  const items = Array.isArray(value) ? value : [];
  return items
    .slice(0, 12)
    .map((item) => {
      const food_name = safeText(item?.food_name, 100);
      const estimated_grams = finite(item?.estimated_grams, { min: 1, max: 5_000 });
      const final_grams = finite(item?.final_grams, { min: 1, max: 5_000 });
      if (!food_name || estimated_grams == null || final_grams == null) return null;
      const ratio = final_grams / estimated_grams;
      if (ratio < 0.2 || ratio > 5) return null;
      return {
        food_name,
        estimated_grams: round(estimated_grams),
        final_grams: round(final_grams),
        ratio: Math.round(ratio * 100) / 100,
        corrected_at: now.toISOString(),
      };
    })
    .filter(Boolean);
}

export function mergeVisionCorrections(existing, incoming) {
  const prior = Array.isArray(existing) ? existing : [];
  return [...prior, ...incoming]
    .filter((item) => item && typeof item === "object")
    .slice(-40);
}

export function calibrationHints(value) {
  const rows = (Array.isArray(value) ? value : []).slice(-20);
  const groups = new Map();
  for (const row of rows) {
    const name = safeText(row?.food_name, 100);
    const ratio = Number(row?.ratio);
    if (!name || !Number.isFinite(ratio) || ratio < 0.2 || ratio > 5) continue;
    const key = name.toLowerCase();
    const group = groups.get(key) || { name, ratios: [] };
    group.ratios.push(ratio);
    groups.set(key, group);
  }
  return [...groups.values()]
    .slice(-8)
    .map((group) => {
      const average = group.ratios.reduce((sum, ratio) => sum + ratio, 0) / group.ratios.length;
      const percent = Math.round((average - 1) * 100);
      return `${group.name}: past corrections averaged ${percent >= 0 ? "+" : ""}${percent}% versus the visual estimate`;
    })
    .join("\n");
}

export const WEB_NUTRITION_RESPONSE_FORMAT = {
  type: "json_schema",
  json_schema: {
    name: "bigbricey_official_web_nutrition",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["found", "name", "source_url", "serving_grams", "nutrients_per_100g", "warning"],
      properties: {
        found: { type: "boolean" },
        name: nullableString,
        source_url: nullableString,
        serving_grams: nullableNumber,
        nutrients_per_100g: {
          type: "object",
          additionalProperties: false,
          required: NUTRIENT_KEYS,
          properties: Object.fromEntries(NUTRIENT_KEYS.map((key) => [key, nullableNumber])),
        },
        warning: nullableString,
      },
    },
  },
};

export function normalizeWebNutrition(value) {
  if (!value?.found) return null;
  const name = safeText(value.name, 160);
  let source_url = null;
  try {
    const url = new URL(String(value.source_url || ""));
    if (url.protocol === "https:") source_url = url.toString().slice(0, 500);
  } catch {
    source_url = null;
  }
  if (!name || !source_url) return null;
  const nutrients = {};
  for (const key of NUTRIENT_KEYS) {
    const max = key === "kcal" ? 10_000 : ["potassium", "magnesium", "sodium"].includes(key) ? 1_000_000 : 5_000;
    nutrients[key] = finite(value?.nutrients_per_100g?.[key], { min: 0, max });
  }
  if (!["kcal", "protein", "fat", "carbs"].some((key) => nutrients[key] != null)) return null;
  return {
    description: name,
    nutrients,
    servingGrams: finite(value.serving_grams, { min: 0.1, max: 10_000 }),
    sourceUrl: source_url,
    warning: nullableText(value.warning, 180),
    dataType: "OfficialWebEstimate",
    _src: "official-web-estimate",
    fdcId: null,
  };
}
