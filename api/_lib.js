/** Shared BigBricey helpers for Vercel serverless */

import { applyLearnedUsualPortion } from "./_food_corrections.js";

export const SYSTEM_PROMPT = `You are BigBricey's food parser ONLY.
You convert a user's food phrase into JSON. You do NOT invent nutrition numbers.
You do NOT answer questions about history, code, or anything except food + amount.
If the message is not about logging food, return {"error":"off_topic"}.

Return ONLY valid JSON:
{
  "food_query": "short searchable food name",
  "amount": number,
  "unit": "g"|"oz"|"lb"|"kg"|"scoop"|"scoops"|"egg"|"eggs"|"cup"|"tbsp"|"tsp"|"stick"|"sticks"|"piece"|"serving",
  "grams_estimate": number only for an exact g/oz/lb/kg conversion, otherwise null,
  "notes": "optional short note"
}`;

/** Custom foods not in USDA (per Brice's known products) */
export const CUSTOM_FOODS = {
  "hlth code": {
    description: "HLTH Code shake (2 scoops standard serving)",
    per100: null,
    perServing: {
      grams: 60,
      kcal: 400,
      protein: 27,
      fat: 27,
      carbs: 4,
      fiber: 9,
      sugars: 0,
      potassium: 0,
      magnesium: 0,
      sodium: 0,
    },
    servingName: "2 scoops",
    scoopGrams: 30,
    scoopScale: {
      kcal: 200,
      protein: 13.5,
      fat: 13.5,
      carbs: 2,
      fiber: 4.5,
      sugars: 0,
      potassium: 0,
      magnesium: 0,
      sodium: 0,
    },
  },
};

export function extractJson(text) {
  const m = String(text || "").match(/\{[\s\S]*\}/);
  if (!m) return { error: "no_json", raw: text };
  try {
    return JSON.parse(m[0]);
  } catch {
    return { error: "bad_json", raw: text };
  }
}

export function offlineParse(text) {
  const t = text.toLowerCase().trim();
  let amount = 1;
  let unit = "serving";
  let food = t;

  const m = t.match(
    /^(half|quarter|one|a|an|[\d.]+\/[\d.]+|[\d.]+)\s*(?:of\s+an?\s+|an?\s+)?(pounds|pound|lbs|lb|ounces|ounce|oz|grams|gram|kg|g|scoops|scoop|eggs|egg|cups|cup|tbsp|tsp|sticks|stick|pieces|piece)?\s*(?:of\s+)?(.*)$/i
  );
  if (m) {
    amount = evalFraction(m[1]);
    unit = (m[2] || "serving").toLowerCase();
    food = (m[3] || "").trim();
  }

  const unitMap = {
    lb: "lb",
    lbs: "lb",
    pound: "lb",
    pounds: "lb",
    oz: "oz",
    ounce: "oz",
    ounces: "oz",
    g: "g",
    gram: "g",
    grams: "g",
    scoop: "scoop",
    scoops: "scoops",
    egg: "eggs",
    eggs: "eggs",
    cup: "cup",
    cups: "cup",
    stick: "stick",
    sticks: "stick",
  };
  unit = unitMap[unit] || unit;

  if (unit === "eggs") food = "eggs, grade a, large, egg whole";

  return {
    food_query: (food || t).replace(/\s+/g, " ").trim(),
    amount,
    unit,
    grams_estimate: toGrams(amount, unit),
    notes: "offline stub parse",
  };
}

function evalFraction(s) {
  const word = String(s).toLowerCase();
  const wordNumbers = {
    zero: 0,
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
    eleven: 11,
    twelve: 12,
  };
  if (word === "half") return 0.5;
  if (word === "quarter") return 0.25;
  if (/^three[- ]quarters?$/.test(word)) return 0.75;
  if (word === "a" || word === "an") return 1;
  if (wordNumbers[word] != null) return wordNumbers[word];
  if (String(s).includes("/")) {
    const [a, b] = String(s).split("/").map(Number);
    return a / b;
  }
  return Number(s) || 1;
}

export function toGrams(amount, unit) {
  switch (unit) {
    case "g":
      return amount;
    case "oz":
      return amount * 28.3495;
    case "lb":
      return amount * 453.592;
    case "kg":
      return amount * 1000;
    case "egg":
    case "eggs":
      return amount * 50;
    default:
      return null;
  }
}

/**
 * Prefer explicit quantity words in the user's own phrase over a model's
 * generic serving fallback for the few household units with a fixed basis.
 */
export function normalizeParsedFoodQuantity(text, parsed = {}) {
  const next = { ...parsed };
  const raw = String(text || "").toLowerCase().trim();
  const amountToken =
    "(three[- ]quarters?|half|quarter|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|a|an|[\\d.]+\\/[\\d.]+|[\\d.]+)";
  const explicitMass = raw.match(
    new RegExp(
      `(?:^|\\b)${amountToken}\\s*(?:of\\s+(?:a|an)\\s+)?(pounds?|lbs?|ounces?|oz|kilograms?|kg|grams?|g)\\b`,
      "i"
    )
  );
  if (explicitMass) {
    const unit = String(explicitMass[2] || "").toLowerCase();
    const unitMap = {
      pound: "lb",
      pounds: "lb",
      lb: "lb",
      lbs: "lb",
      ounce: "oz",
      ounces: "oz",
      oz: "oz",
      kilogram: "kg",
      kilograms: "kg",
      kg: "kg",
      gram: "g",
      grams: "g",
      g: "g",
    };
    next.amount = evalFraction(explicitMass[1]);
    next.unit = unitMap[unit];
    next.grams_estimate = toConvertibleGrams(next.amount, next.unit);
  }
  const countedEggs = raw.match(
    new RegExp(
      `(?:^|\\b)${amountToken}\\s+(?:(small|medium|large|extra[- ]large|jumbo)\\s+)?(?:(hard[- ]?boiled|soft[- ]?boiled|boiled|fried|scrambled|poached)\\s+)?eggs?\\b`,
      "i"
    )
  );
  if (countedEggs) {
    next.amount = evalFraction(countedEggs[1]);
    next.unit = "eggs";
    next.grams_estimate = next.amount * 50;
    const preparation = countedEggs[3]
      ? countedEggs[3].replace(/\s+/g, "-")
      : "";
    next.food_query = [preparation, "egg"].filter(Boolean).join(" ");
  }
  const butterStick = raw.match(
    new RegExp(
      `(?:^|\\b)${amountToken}\\s*(?:of\\s+an?\\s+|an?\\s+)?sticks?\\s*(?:of\\s+)?(?:[a-z]+\\s+){0,3}butter\\b`,
      "i"
    )
  );
  if (butterStick) {
    next.amount = evalFraction(butterStick[1]);
    next.unit = "stick";
    next.grams_estimate = null;
  }
  return next;
}

/** Exact mass basis only; no generic cup, scoop, piece, or serving guesses. */
export function verifiedFoodGrams(parsed, query) {
  const amount = Number(parsed?.amount);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const unit = String(parsed?.unit || "").toLowerCase();
  const exact = toConvertibleGrams(amount, unit);
  if (exact != null) return exact;
  if ((unit === "egg" || unit === "eggs") && /\begg\b/i.test(String(query || ""))) {
    return amount * 50;
  }
  if ((unit === "stick" || unit === "sticks") && /\bbutter\b/i.test(String(query || ""))) {
    return amount * 113.398;
  }
  return null;
}

/**
 * Exact mass conversion for rescaling an already-recorded food row.
 * Household measures and generic servings need a verified food-specific basis,
 * so they intentionally return null here instead of inventing one.
 */
export function toConvertibleGrams(amount, unit) {
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) return null;
  switch (String(unit || "").trim().toLowerCase()) {
    case "g":
    case "gram":
    case "grams":
      return value;
    case "oz":
    case "ounce":
    case "ounces":
      return value * 28.3495;
    case "lb":
    case "lbs":
    case "pound":
    case "pounds":
      return value * 453.592;
    case "kg":
    case "kilogram":
    case "kilograms":
      return value * 1000;
    default:
      return null;
  }
}

export function expandQuery(q) {
  const t = q.toLowerCase().trim();
  if (t === "bacon" || t === "pork bacon") return "Pork, cured, bacon, unprepared";
  if (/\b(?:hard[- ]?boiled|boiled)\b.*\beggs?\b|\beggs?\b.*\b(?:hard[- ]?boiled|boiled)\b/.test(t)) {
    return "Egg, whole, cooked, hard-boiled";
  }
  if (/^egg/.test(t)) return "Eggs, Grade A, Large, egg whole";
  if (/^sweet (?:potato|potatoes)$/.test(t)) return "Sweet potato, raw, unprepared";
  if (/brisket/.test(t) && !/\braw|uncooked|unprepared\b/.test(t)) {
    return "Beef, brisket, cooked, braised";
  }
  if (/brisket/.test(t)) return "Beef, brisket, raw";
  return q;
}

function formatLookupAmount(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "";
  return String(Math.round(number * 1000) / 1000);
}

export function matchCustomFood(query) {
  const q = query.toLowerCase();
  for (const [key, val] of Object.entries(CUSTOM_FOODS)) {
    if (q.includes(key) || q.includes("hlth")) return { key, ...val };
  }
  return null;
}

export function rowFromCustom(parsed, custom) {
  const amount = Number(parsed?.amount) || 1;
  const unit = parsed?.unit || "serving";
  let scale = 1;
  let grams = custom.perServing?.grams || 100;

  if (unit === "scoop" || unit === "scoops") {
    // 1 scoop = half of 2-scoop serving
    const n = custom.scoopScale;
    grams = amount * (custom.scoopGrams || 30);
    return {
      id: crypto.randomUUID(),
      label: `${amount} scoop${amount === 1 ? "" : "s"} ${custom.description}`,
      source: "custom",
      fdcId: null,
      grams,
      kcal: round(n.kcal * amount),
      protein: round(n.protein * amount),
      fat: round(n.fat * amount),
      carbs: round(n.carbs * amount),
      fiber: round(n.fiber * amount),
      sugars: round(n.sugars * amount),
      potassium: round(n.potassium * amount),
      magnesium: round(n.magnesium * amount),
      sodium: round(n.sodium * amount),
      extras: {
        known_nutrients: Object.keys(n).filter(
          (key) => n[key] != null && Number.isFinite(Number(n[key]))
        ),
        provenance: {
          source: "custom",
          nutrition_basis: "saved_custom_serving",
          selected_portion_grams: round(grams),
          confidence: "high",
          estimate_status: "user_confirmed",
          portion_estimated: false,
        },
      },
    };
  }

  // default: treat as N standard servings
  scale = amount;
  const s = custom.perServing;
  return {
    id: crypto.randomUUID(),
    label: `${amount} × ${custom.description}`,
    source: "custom",
    fdcId: null,
    grams: s.grams * scale,
    kcal: round(s.kcal * scale),
    protein: round(s.protein * scale),
    fat: round(s.fat * scale),
    carbs: round(s.carbs * scale),
    fiber: round(s.fiber * scale),
    sugars: round(s.sugars * scale),
    potassium: round(s.potassium * scale),
    magnesium: round(s.magnesium * scale),
    sodium: round(s.sodium * scale),
    extras: {
      known_nutrients: Object.keys(s).filter(
        (key) =>
          key !== "grams" &&
          s[key] != null &&
          Number.isFinite(Number(s[key]))
      ),
      provenance: {
        source: "custom",
        nutrition_basis: "saved_custom_serving",
        selected_portion_grams: round(s.grams * scale),
        confidence: "high",
        estimate_status: "user_confirmed",
        portion_estimated: false,
      },
    },
  };
}

export function pickNutrients(list) {
  const byId = {};
  const byName = {};
  const omega3Components = [];
  for (const n of list) {
    const id = n.nutrientId || n.nutrientNumber;
    const name = (n.nutrientName || n.nutrient || "").toLowerCase();
    const raw = n.value ?? n.amount;
    if (raw == null || raw === "") continue;
    const val = Number(raw);
    if (!Number.isFinite(val)) continue;
    if (id != null) byId[id] = val;
    if (name) byName[name] = val;
    if (
      /(?:\bn-3\b|omega-3|alpha-linolenic)/i.test(name) &&
      !/ratio|added/i.test(name)
    ) {
      omega3Components.push(val);
    }
  }
  const get = (...keys) => {
    for (const k of keys) {
      if (byId[k] != null) return byId[k];
      if (byName[k] != null) return byName[k];
    }
    return null;
  };
  const vitaminDIu = get(
    1110,
    "vitamin d (d2 + d3), international units"
  );
  const vitaminDMcg = get(1114, "vitamin d (d2 + d3)");
  const omega3Total = get("fatty acids, total n-3", "omega-3 fatty acids");
  return {
    kcal: get(1008, "energy", "energy (kcal)"),
    protein: get(1003, "protein"),
    fat: get(1004, "total lipid (fat)", "fat"),
    carbs: get(1005, "carbohydrate, by difference", "carbohydrate"),
    fiber: get(1079, "fiber, total dietary"),
    sugars: get(2000, "sugars, total including nlea", "total sugars"),
    potassium: get(1092, "potassium, k"),
    magnesium: get(1090, "magnesium, mg"),
    sodium: get(1093, "sodium, na"),
    calcium: get(1087, "calcium, ca"),
    iron: get(1089, "iron, fe"),
    zinc: get(1095, "zinc, zn"),
    vitamin_a: get(1106, "vitamin a, rae"),
    vitamin_c: get(1162, "vitamin c, total ascorbic acid"),
    vitamin_d:
      vitaminDIu != null
        ? vitaminDIu
        : vitaminDMcg != null
          ? vitaminDMcg * 40
          : null,
    vitamin_e: get(1109, "vitamin e (alpha-tocopherol)"),
    vitamin_k: get(1185, "vitamin k (phylloquinone)"),
    b12: get(1178, "vitamin b-12"),
    folate: get(1190, "folate, dfe", 1177, "folate, total"),
    omega3:
      omega3Total != null
        ? omega3Total
        : omega3Components.length
          ? omega3Components.reduce((sum, value) => sum + value, 0)
          : null,
  };
}

export function scoreFood(query, f) {
  const q = query.toLowerCase();
  const d = (f.description || "").toLowerCase();
  const n = f.nutrients || {};
  let s = 0;
  for (const word of q.split(/\s+/)) {
    if (word.length > 2 && d.includes(word)) s += 3;
  }
  if (d.startsWith(q.split(",")[0])) s += 5;
  if (f.dataType === "Foundation") s += 8;
  if (f.dataType === "SR Legacy") s += 6;
  if (f.dataType === "Survey (FNDDS)") s += 5;
  if (f.dataType === "Branded") s += 2;
  if (f._src === "usda" || f.dataType === "Foundation" || f.dataType === "SR Legacy") s += 6;
  if (/cereal|candy|cookie|cracker|oh!s|bits|imitation|soup|dressing|sandwich|sticks/i.test(d))
    s -= 10;
  if (/meatless|vegetarian|vegan/i.test(d)) s -= 15;
  if (/raw|whole|fresh|uncooked|unprepared|canned/i.test(d)) s += 3;
  if (/bacon/i.test(q) && /pork.*bacon|bacon.*unprepared|cured, bacon/i.test(d)) s += 10;
  if (/bacon/i.test(q) && /unprepared|raw/i.test(d)) s += 8;
  if (/bacon/i.test(q) && /meatless|salt pork|bits|restaurant|turkey/i.test(d)) s -= 12;
  if (/egg/i.test(q) && /grade a|large|whole/i.test(d)) s += 6;
  if (/brisket/i.test(q) && /brisket/i.test(d)) s += 8;
  // Real artichoke hearts ≠ Jerusalem artichokes (sunchokes)
  if (/artichoke/i.test(q) && /jerusalem/i.test(d)) s -= 25;
  if (/artichoke heart/i.test(q) && /artichoke heart|coeur d.artichaut|corazon.*alcachofa|cuori di carciof/i.test(d))
    s += 15;
  if (/artichoke heart/i.test(q) && /artichoke/i.test(d) && !/jerusalem/i.test(d)) s += 8;

  // Completeness: never prefer mineral-only / empty macro rows
  const kcal = Number(n.kcal) || 0;
  const protein = Number(n.protein) || 0;
  const fat = Number(n.fat) || 0;
  const carbs = Number(n.carbs) || 0;
  const exactMineralIngredient =
    /\bsalt\b/i.test(q) &&
    /\bsalt\b/i.test(d) &&
    !/popcorn|chips|snack|seasoning|rub|sauce|dip/i.test(d) &&
    Number(n.sodium) > 0;
  if (kcal > 0) s += 12;
  else if (exactMineralIngredient) s += 18;
  else s -= 40; // hard penalty — user sees blank calories
  if (protein > 0 || fat > 0 || carbs > 0) s += 6;
  else if (exactMineralIngredient) s += 6;
  if (kcal > 0 && protein > 0) s += 4;
  // garbage OFF entries sometimes claim fat/kcal with zero carbs for veggies
  if (/artichoke|berry|vegetable|fruit/i.test(q) && fat > 8 && carbs < 1) s -= 8;

  return s;
}

const FOOD_QUERY_STOP_WORDS = new Set([
  "a", "an", "and", "the", "of", "with", "for", "my", "some",
  "half", "quarter", "one", "piece", "pieces", "serving", "servings",
  "stick", "sticks", "cup", "cups", "tbsp", "tsp", "oz", "ounce",
  "ounces", "lb", "lbs", "pound", "pounds", "g", "gram", "grams", "kg",
  "fresh", "frozen", "organic", "canned", "drained",
]);
const FOREIGN_FOOD_FORMS = new Set([
  "popcorn", "candy", "cereal", "cookie", "cookies", "cracker", "crackers",
  "chips", "soup", "dressing", "sandwich", "sauce", "seasoning", "snack",
  "dip", "bar", "bars", "bits", "imitation", "meatless", "vegetarian", "vegan",
  "tot", "tots", "fry", "fries", "paste", "puree", "pureed", "casserole",
  "mashed", "candied", "nfs", "leaf", "leaves", "bread", "pie", "pakora",
  "pudding", "flour", "gnocchi", "puffs",
]);

function foodWords(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/** Reject semantically contaminated search hits before they reach the ledger. */
export function foodMatchQuality(query, food) {
  const queryWords = foodWords(query).filter(
    (word) => word.length > 1 && !FOOD_QUERY_STOP_WORDS.has(word) && !/^\d/.test(word)
  );
  const descriptionWords = foodWords(food?.description);
  const querySet = new Set(queryWords);
  const descriptionSet = new Set(descriptionWords);
  const matched = queryWords.filter((word) => descriptionSet.has(word));
  const coverage = queryWords.length ? matched.length / queryWords.length : 0;
  const foreignForms = descriptionWords.filter(
    (word) => FOREIGN_FOOD_FORMS.has(word) && !querySet.has(word)
  );
  const butterMismatch =
    querySet.has("butter") &&
    descriptionWords.some((word) => ["light", "whipped", "spread", "margarine", "blend"].includes(word)) &&
    !descriptionWords.some((word) => querySet.has(word) && ["light", "whipped", "spread", "margarine", "blend"].includes(word));
  const requiredCoverage = queryWords.length <= 1 ? 1 : 0.66;
  return {
    credible:
      queryWords.length > 0 &&
      coverage >= requiredCoverage &&
      foreignForms.length === 0 &&
      !butterMismatch,
    coverage,
    foreignForms,
    butterMismatch,
  };
}

/** Normalize Open Food Facts nutriments → per-100g macros */
export function offNutrients(n) {
  n = n || {};
  const finiteOrNull = (...values) => {
    for (const raw of values) {
      if (raw == null || raw === "") continue;
      const value = Number(raw);
      if (Number.isFinite(value)) return value;
    }
    return null;
  };
  let kcal = finiteOrNull(
    n["energy-kcal_100g"],
    n.energy_kcal_100g,
    n["energy-kcal"]
  );
  if (kcal == null) {
    const kj = finiteOrNull(
      n["energy-kj_100g"],
      n.energy_100g,
      n["energy-kj"]
    );
    if (kj != null) kcal = kj / 4.184;
  }
  const nutrientIn = (key, targetUnit, aliases = []) => {
    const raw = finiteOrNull(
      n[`${key}_100g`],
      n[key],
      ...aliases.flatMap((alias) => [n[`${alias}_100g`], n[alias]])
    );
    if (raw == null) return null;
    const unit = String(
      n[`${key}_unit`] ||
        aliases.map((alias) => n[`${alias}_unit`]).find(Boolean) ||
        ""
    )
      .trim()
      .toLowerCase()
      .replace("μ", "µ");
    const toMicrograms = () => {
      if (unit === "g") return raw * 1_000_000;
      if (unit === "mg") return raw * 1_000;
      if (["µg", "ug", "mcg"].includes(unit)) return raw;
      return null;
    };
    if (targetUnit === "g") {
      if (unit === "mg") return raw / 1_000;
      if (["µg", "ug", "mcg"].includes(unit)) return raw / 1_000_000;
      return raw;
    }
    if (targetUnit === "mg") {
      if (unit === "g") return raw * 1_000;
      if (["µg", "ug", "mcg"].includes(unit)) return raw / 1_000;
      if (unit === "mg") return raw;
      // OFF historically normalized minerals to grams even when unit metadata
      // was absent. Preserve the existing conservative magnitude heuristic.
      return raw > 0 && raw < 5 ? raw * 1_000 : raw;
    }
    if (targetUnit === "µg") return toMicrograms();
    if (targetUnit === "IU") {
      if (unit === "iu") return raw;
      const micrograms = toMicrograms();
      return micrograms == null ? null : micrograms * 40;
    }
    return null;
  };
  const nutrients = {
    kcal,
    protein: finiteOrNull(n.proteins_100g, n.proteins),
    fat: finiteOrNull(n.fat_100g, n.fat),
    carbs: finiteOrNull(n.carbohydrates_100g, n.carbohydrates),
    fiber: finiteOrNull(n.fiber_100g, n.fiber),
    sugars: finiteOrNull(n.sugars_100g, n.sugars),
    potassium: nutrientIn("potassium", "mg"),
    magnesium: nutrientIn("magnesium", "mg"),
    sodium: nutrientIn("sodium", "mg"),
    calcium: nutrientIn("calcium", "mg"),
    iron: nutrientIn("iron", "mg"),
    zinc: nutrientIn("zinc", "mg"),
    vitamin_a: nutrientIn("vitamin-a", "µg"),
    vitamin_c: nutrientIn("vitamin-c", "mg"),
    vitamin_d: nutrientIn("vitamin-d", "IU"),
    vitamin_e: nutrientIn("vitamin-e", "mg"),
    vitamin_k: nutrientIn("vitamin-k", "µg"),
    b12: nutrientIn("vitamin-b12", "µg"),
    folate: nutrientIn("folates", "µg", ["folate"]),
    omega3: nutrientIn("omega-3-fat", "g", ["omega-3"]),
  };
  return nutrients;
}

export function pickBestFood(foods, query = "") {
  if (!foods?.length) return null;
  const credible = query
    ? foods.filter((food) => foodMatchQuality(query, food).credible)
    : [...foods];
  return credible.sort((a, b) => b.score - a.score)[0] || null;
}

export function round(n) {
  return Math.round((Number(n) || 0) * 10) / 10;
}

const FOOD_ROW_NUTRIENTS = [
  "kcal",
  "protein",
  "fat",
  "carbs",
  "fiber",
  "sugars",
  "potassium",
  "magnesium",
  "sodium",
  "calcium",
  "iron",
  "zinc",
  "vitamin_a",
  "vitamin_c",
  "vitamin_d",
  "vitamin_e",
  "vitamin_k",
  "b12",
  "folate",
  "omega3",
];

function foodPreparation(value) {
  const match = String(value || "").match(
    /\b(raw|unprepared|cooked|roasted|baked|boiled|braised|grilled|fried|smoked|canned|drained)\b/i
  );
  return match ? match[1].toLowerCase() : null;
}

function foodProvenance(food, weight) {
  const source = food?._src || food?.dataType || "lookup";
  const quality = foodMatchQuality(food?.description || "", food);
  return {
    source,
    source_food_id: food?.fdcId || null,
    source_description: String(food?.description || "Food").slice(0, 240),
    nutrition_basis: "database_per_100g",
    selected_portion_grams: round(weight),
    preparation: foodPreparation(food?.description),
    form: food?.brandOwner ? "branded" : "generic",
    confidence:
      String(source).includes("barcode") || quality.coverage === 1
        ? "high"
        : "medium",
    estimate_status: "verified_nutrition",
    portion_estimated: false,
  };
}

/** Build a ledger-ready row from verified per-100g nutrition. */
export function foodRowFromPer100(food, grams, { label } = {}) {
  const weight = Number(grams);
  if (!Number.isFinite(weight) || weight <= 0 || weight > 100_000) return null;
  const nutrients = food?.nutrients || {};
  const row = {
    id: crypto.randomUUID(),
    label: String(label || `${round(weight)} g ${food?.description || "Food"}`).slice(
      0,
      300
    ),
    source: food?._src || food?.dataType || "lookup",
    fdcId: food?.fdcId || null,
    grams: round(weight),
  };
  const known = [];
  for (const key of FOOD_ROW_NUTRIENTS) {
    const value = nutrients[key];
    if (value == null || value === "" || !Number.isFinite(Number(value))) continue;
    row[key] = round(Number(value) * (weight / 100));
    known.push(key);
  }
  row.extras = {
    known_nutrients: known,
    provenance: foodProvenance(food, weight),
  };
  return row;
}

function rowHasUsefulNutrition(row) {
  if (!row) return false;
  const energyOrMacro = [row.kcal, row.protein, row.fat, row.carbs];
  return (
    energyOrMacro.some((value) => Number(value) > 0) ||
    energyOrMacro.every(
      (value) => value != null && Number.isFinite(Number(value))
    )
  );
}

export async function parseFood(text) {
  try {
    const { llmChat, llmConfig } = await import("./_llm.js");
    const cfg = llmConfig();
    if (!cfg.ok) {
      return {
        source: "offline-stub",
        parsed: offlineParse(text),
        note: "No LLM API key",
      };
    }
    const out = await llmChat({
      temperature: 0,
      title: "BigBricey-ParseFood",
      maxTokens: 250,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: text },
      ],
    });
    const parsed = extractJson(out.content);
    return { source: out.provider, model: out.model, parsed, raw: out.content };
  } catch (e) {
    if (e?.code === "llm_not_configured") {
      return {
        source: "offline-stub",
        parsed: offlineParse(text),
        note: "No LLM API key",
      };
    }
    const err = new Error("llm_failed");
    err.detail = e.detail || e.message;
    throw err;
  }
}

/**
 * Open Food Facts — free, no API key, any product/food name.
 * Primary lookup so we never depend on USDA DEMO_KEY rate limits.
 */
export async function openFoodFactsSearch(q) {
  // cgi search is the stable free endpoint (no API key). Try world then us.
  const hosts = [
    "https://world.openfoodfacts.org/cgi/search.pl",
    "https://us.openfoodfacts.org/cgi/search.pl",
  ];
  let raw = "";
  let data = null;
  let lastErr = null;

  for (const host of hosts) {
    const url = new URL(host);
    url.searchParams.set("search_terms", q);
    url.searchParams.set("search_simple", "1");
    url.searchParams.set("action", "process");
    url.searchParams.set("json", "1");
    url.searchParams.set("page_size", "15");

    try {
      const r = await fetch(url.toString(), {
        headers: {
          Accept: "application/json",
          "User-Agent": "BigBricey/1.0 (https://www.bigbricey.com; food log)",
        },
      });
      raw = await r.text();
      if (!r.ok || raw.trimStart().startsWith("<")) {
        lastErr = raw.slice(0, 180);
        continue;
      }
      data = JSON.parse(raw);
      break;
    } catch (e) {
      lastErr = String(e.message || e);
    }
  }

  if (!data) {
    const err = new Error("off_failed");
    err.detail = lastErr || raw.slice(0, 200);
    throw err;
  }

  const foods = (data.products || [])
    .map((p) => {
      const description =
        p.product_name || p.generic_name || p.brands || "Unknown product";
      const nutrients = offNutrients(p.nutriments || {});
      const item = {
        fdcId: p.code || null,
        description,
        brandOwner: p.brands || null,
        dataType: "OpenFoodFacts",
        categories: p.categories || "",
        nutrients,
        _src: "openfoodfacts",
      };
      item.score = scoreFood(q, item);
      return item;
    })
    .filter(
      (f) =>
        f.nutrients.kcal > 0 ||
        f.nutrients.protein > 0 ||
        f.nutrients.fat > 0 ||
        f.nutrients.carbs > 0 ||
        f.nutrients.sodium > 0 ||
        f.nutrients.potassium > 0 ||
        f.nutrients.magnesium > 0
    );

  foods.sort((a, b) => b.score - a.score);
  return { query: q, foods, source: "openfoodfacts" };
}

function normalizeFoodMeasures(value) {
  return (Array.isArray(value) ? value : [])
    .map((raw) => {
      const amount = Number(raw?.amount);
      const gramWeight = Number(raw?.gramWeight ?? raw?.gram_weight);
      const unit =
        raw?.measureUnit?.name ||
        raw?.measureUnit?.abbreviation ||
        raw?.measure_unit?.name ||
        raw?.measure_unit?.abbreviation ||
        "";
      const label = String(
        raw?.label ||
          raw?.disseminationText ||
          raw?.portionDescription ||
          raw?.modifier ||
          [Number.isFinite(amount) ? amount : "", unit].filter(Boolean).join(" ")
      )
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 180);
      if (!label || !Number.isFinite(gramWeight) || gramWeight <= 0) return null;
      return {
        amount: Number.isFinite(amount) && amount > 0 ? amount : 1,
        gramWeight,
        label,
      };
    })
    .filter(Boolean)
    .slice(0, 40);
}

/** USDA — only used when USDA_API_KEY is set (never DEMO_KEY; that rate-limits constantly). */
export async function usdaSearch(q) {
  const key = process.env.USDA_API_KEY;
  if (!key) {
    return { query: q, foods: [], source: "usda_skipped_no_key" };
  }

  const url = new URL("https://api.nal.usda.gov/fdc/v1/foods/search");
  url.searchParams.set("query", q);
  url.searchParams.set("pageSize", "15");
  // Don't over-restrict dataType — Branded has "ARTICHOKE HEARTS" etc.
  url.searchParams.set("api_key", key);

  const r = await fetch(url);
  const raw = await r.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    const err = new Error("usda_failed");
    err.detail = raw.slice(0, 200);
    throw err;
  }
  if (!r.ok || data.error) {
    const err = new Error("usda_failed");
    err.detail = data;
    throw err;
  }

  let foods = (data.foods || []).map((f) => {
    const item = {
      fdcId: f.fdcId,
      description: f.description,
      brandOwner: f.brandOwner || null,
      dataType: f.dataType,
      nutrients: pickNutrients(f.foodNutrients || []),
      foodMeasures: normalizeFoodMeasures(f.foodMeasures || f.foodPortions),
      _src: "usda",
    };
    item.score = scoreFood(q, item);
    return item;
  });
  foods.sort((a, b) => b.score - a.score);
  return { query: q, foods, source: "usda" };
}

/** Search all free sources; pick best hit. */
export async function foodSearch(q) {
  const results = [];
  const errors = [];

  try {
    const off = await openFoodFactsSearch(q);
    results.push(...(off.foods || []).map((f) => ({ ...f, _src: "openfoodfacts" })));
  } catch (e) {
    errors.push({ source: "openfoodfacts", detail: e.detail || String(e.message || e) });
  }

  try {
    const usda = await usdaSearch(q);
    results.push(...(usda.foods || []).map((f) => ({ ...f, _src: "usda" })));
  } catch (e) {
    errors.push({ source: "usda", detail: e.detail || String(e.message || e) });
  }

  // Also try a cleaned query without brand fluff
  const cleaned = q.replace(/\b(costco|organic|fresh|canned|drained)\b/gi, " ").replace(/\s+/g, " ").trim();
  if (cleaned && cleaned.toLowerCase() !== q.toLowerCase()) {
    try {
      const off2 = await openFoodFactsSearch(cleaned);
      results.push(...(off2.foods || []).map((f) => ({ ...f, _src: "openfoodfacts" })));
    } catch {
      /* ignore */
    }
  }

  results.sort((a, b) => b.score - a.score);
  return { query: q, foods: results, errors };
}

/** Fetch only the trusted USDA portion metadata needed for a reference-size lookup. */
export async function usdaFoodDetails(fdcId) {
  const key = process.env.USDA_API_KEY;
  const id = String(fdcId || "").trim();
  if (!key || !/^\d{1,20}$/.test(id)) return null;
  const url = new URL(
    `https://api.nal.usda.gov/fdc/v1/food/${encodeURIComponent(id)}`
  );
  url.searchParams.set("api_key", key);
  const response = await fetch(url);
  const data = await response.json().catch(() => null);
  if (!response.ok || !data) return null;
  return {
    foodMeasures: normalizeFoodMeasures(
      data.foodMeasures || data.foodPortions
    ),
  };
}

/**
 * Pick one explicitly named USDA whole-item size. Household forms never stand
 * in for a generic piece, and a requested size never silently falls back.
 */
export function pickWholeFoodReferenceMeasure(food, { size = "medium" } = {}) {
  const requestedSize = String(size || "").toLowerCase();
  if (
    food?._src !== "usda" ||
    !["small", "medium", "large"].includes(requestedSize)
  ) {
    return null;
  }
  const forbidden =
    /\b(?:cup|tablespoon|tbsp|teaspoon|tsp|slice|wedge|cube|diced|chopped|mashed|puree|pureed|serving|package|container)\b/i;
  const matchesRequestedSize = (label) => {
    if (new RegExp(`\\b${requestedSize}\\b`, "i").test(label)) return true;
    // FoodData Central labels the standard medium whole sweet potato as
    // `sweetpotato, 5" long` rather than spelling out the word "medium".
    // Keep this narrow so an arbitrary household length is never guessed into
    // a size category for unrelated foods.
    return (
      requestedSize === "medium" &&
      /\bsweet\s*potato\b[^\n]*\b5(?:\.0+)?\s*(?:"|in(?:ch(?:es)?)?)\s*long\b/i.test(
        String(label || "").replace("sweetpotato", "sweet potato")
      )
    );
  };
  const candidates = normalizeFoodMeasures(food.foodMeasures).filter(
    (measure) =>
      measure.amount === 1 &&
      measure.gramWeight >= 1 &&
      measure.gramWeight <= 2_000 &&
      matchesRequestedSize(measure.label) &&
      !forbidden.test(measure.label)
  );
  const uniqueWeights = [
    ...new Set(candidates.map((measure) => Math.round(measure.gramWeight * 1000))),
  ];
  if (uniqueWeights.length !== 1 || !candidates.length) return null;
  return {
    grams: candidates[0].gramWeight,
    label: candidates[0].label,
    size: requestedSize,
    estimated: true,
  };
}

function nutritionFromRow(row) {
  return Object.fromEntries(
    FOOD_ROW_NUTRIENTS.flatMap((key) =>
      row?.[key] != null && Number.isFinite(Number(row[key]))
        ? [[key, Number(row[key])]]
        : []
    )
  );
}

/** Verified, read-only nutrition resolution. This function never writes a ledger row. */
export async function resolveNutritionLookup(
  input = {},
  {
    foodSearchFn = foodSearch,
    usdaFoodDetailsFn = usdaFoodDetails,
  } = {}
) {
  const query = String(input?.query || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
  const noResult = (
    note,
    match = null,
    detail = null,
    code = "TOOL_NOT_FOUND"
  ) => ({
    match,
    portion_basis: null,
    nutrition_basis: null,
    nutrition: null,
    writes_ledger: false,
    note,
    detail,
    error: {
      code,
      message: note,
      retryable: code === "TOOL_UNAVAILABLE",
    },
  });
  if (!query) {
    return noResult(
      "A specific food name is required.",
      null,
      null,
      "TOOL_REQUIRED_DETAILS"
    );
  }

  let search;
  try {
    const expanded = expandQuery(query);
    const queries =
      expanded.toLowerCase() === query.toLowerCase()
        ? [query]
        : [expanded, query];
    const searches = await Promise.all(
      queries.map((candidate) => foodSearchFn(candidate))
    );
    search = {
      foods: searches
        .flatMap((result) => result?.foods || [])
        .sort((a, b) => b.score - a.score),
      errors: searches.flatMap((result) => result?.errors || []),
    };
  } catch (error) {
    return noResult(
      "Food lookup failed — try again.",
      null,
      error?.detail || String(error?.message || error),
      "TOOL_UNAVAILABLE"
    );
  }
  const foods = Array.isArray(search?.foods) ? search.foods : [];
  let match = pickBestFood(foods, query);
  if (!match) {
    return noResult(
      "No credible nutrition database match was found.",
      null,
      search?.errors || null
    );
  }

  const amount = input?.amount == null ? null : Number(input.amount);
  const unit = String(input?.unit || "").toLowerCase();
  const size = String(input?.size || "").toLowerCase();
  let grams;
  let portionBasis;

  if (amount == null && !unit) {
    grams = 100;
    portionBasis = {
      kind: "per_100g",
      grams,
      label: "100 g reference",
      estimated: false,
    };
  } else if (unit === "piece") {
    const usdaCandidates = foods
      .filter(
        (food) =>
          food?._src === "usda" && foodMatchQuality(query, food).credible
      )
      .sort((a, b) => b.score - a.score);
    let reference = null;
    for (const candidate of usdaCandidates) {
      let candidateWithMeasures = candidate;
      if (!normalizeFoodMeasures(candidate.foodMeasures).length && candidate.fdcId) {
        try {
          const details = await usdaFoodDetailsFn(candidate.fdcId);
          candidateWithMeasures = {
            ...candidate,
            foodMeasures: details?.foodMeasures || [],
          };
        } catch {
          /* try another credible USDA candidate */
        }
      }
      reference = pickWholeFoodReferenceMeasure(candidateWithMeasures, { size });
      if (reference) {
        match = candidateWithMeasures;
        break;
      }
    }
    if (!reference || !Number.isFinite(amount) || amount <= 0) {
      return noResult(
        `I found “${match.description}”, but USDA did not provide one unambiguous ${size || "requested"} whole-item weight for it. Use grams, ounces, pounds, or choose another size.`,
        {
          description: match.description,
          source: match._src || match.dataType || "lookup",
        },
        null,
        "TOOL_REQUIRED_DETAILS"
      );
    }
    grams = reference.grams * amount;
    portionBasis = {
      kind: "usda_reference_size",
      grams,
      label:
        amount === 1
          ? reference.label
          : `${formatLookupAmount(amount)} × ${reference.label}`,
      estimated: true,
    };
  } else {
    grams = toConvertibleGrams(amount, unit);
    if (grams == null) {
      return noResult(
        "That portion needs grams, ounces, pounds, kilograms, or a verified whole-food reference size.",
        {
          description: match.description,
          source: match._src || match.dataType || "lookup",
        },
        null,
        "TOOL_REQUIRED_DETAILS"
      );
    }
    portionBasis = {
      kind: "explicit_mass",
      grams,
      label: `${formatLookupAmount(amount)} ${unit}`,
      estimated: false,
    };
  }

  const row = foodRowFromPer100(match, grams);
  if (!rowHasUsefulNutrition(row)) {
    return noResult(
      "The matching database entry did not contain usable nutrition.",
      {
        description: match.description,
        source: match._src || match.dataType || "lookup",
      },
      null,
      "TOOL_UNAVAILABLE"
    );
  }
  return {
    match: {
      description: String(match.description || "Food").slice(0, 240),
      source: match._src || match.dataType || "lookup",
      food_id: match.fdcId || null,
    },
    portion_basis: {
      ...portionBasis,
      grams: Math.round(Number(portionBasis.grams) * 1000) / 1000,
    },
    nutrition_basis: {
      kind: "database_per_100g",
      source: match._src || match.dataType || "lookup",
      food_id: match.fdcId || null,
    },
    nutrition: nutritionFromRow(row),
    writes_ledger: false,
    note: null,
  };
}

/** Resolve a visually estimated food at a known gram amount without reparsing it. */
export async function resolveFoodAtGrams(query, grams, opts = {}) {
  const q = String(query || "").replace(/\s+/g, " ").trim().slice(0, 160);
  const weight = Number(grams);
  if (!q || !Number.isFinite(weight) || weight <= 0 || weight > 100_000) {
    return { match: null, row: null, note: "A food name and a valid gram amount are required." };
  }

  const custom = matchCustomFood(q);
  if (custom?.perServing?.grams > 0) {
    const servings = weight / Number(custom.perServing.grams);
    const row = rowFromCustom({ amount: servings, unit: "serving" }, custom);
    row.label = `${round(weight)} g ${custom.description}`;
    row.grams = round(weight);
    return {
      match: { description: custom.description, source: "custom" },
      row,
      note: null,
    };
  }

  if (opts.email && typeof opts.findSavedFood === "function") {
    try {
      const saved = await opts.findSavedFood(opts.email, q);
      const savedGrams = Number(saved?.grams);
      if (
        saved &&
        Number.isFinite(savedGrams) &&
        savedGrams > 0 &&
        typeof opts.rowFromSavedFood === "function"
      ) {
        const row = opts.rowFromSavedFood(saved, weight / savedGrams);
        row.label = `${round(weight)} g ${saved.name}`;
        row.grams = round(weight);
        return {
          match: { description: saved.name, source: "saved" },
          row,
          note: null,
        };
      }
    } catch {
      /* continue to public food databases */
    }
  }

  const expanded = expandQuery(q);
  const queries =
    expanded.toLowerCase() === q.toLowerCase() ? [q] : [expanded, q];
  try {
    const searches = await Promise.all(queries.map((value) => foodSearch(value)));
    const foods = searches
      .flatMap((result) => result.foods || [])
      .sort((a, b) => b.score - a.score);
    const best = pickBestFood(foods, q);
    if (!best) {
      return {
        match: null,
        row: null,
        note: "No credible nutrition database match was found.",
        detail: searches.flatMap((result) => result.errors || []),
      };
    }
    const row = foodRowFromPer100(best, weight);
    if (!rowHasUsefulNutrition(row)) {
      return {
        match: best,
        row: null,
        note: "The matching database entry did not contain usable nutrition.",
      };
    }
    return { match: best, row, note: null };
  } catch (error) {
    return {
      match: null,
      row: null,
      note: "Food lookup failed — try again.",
      detail: error?.detail || String(error?.message || error),
    };
  }
}

/** Normalize and validate a UPC/EAN/GTIN, including its check digit. */
export function normalizeBarcode(value) {
  const code = String(value || "").replace(/[^0-9]/g, "");
  if (![8, 12, 13, 14].includes(code.length)) return null;
  const digits = code.split("").map(Number);
  const supplied = digits.pop();
  let sum = 0;
  for (let i = digits.length - 1, position = 0; i >= 0; i -= 1, position += 1) {
    sum += digits[i] * (position % 2 === 0 ? 3 : 1);
  }
  const expected = (10 - (sum % 10)) % 10;
  return supplied === expected ? code : null;
}

function gramsFromServing(value, unit, text) {
  const amount = Number(value);
  const normalizedUnit = String(unit || "").trim().toLowerCase();
  if (Number.isFinite(amount) && amount > 0) {
    if (["g", "gram", "grams", "grm"].includes(normalizedUnit)) return amount;
    if (["oz", "ounce", "ounces"].includes(normalizedUnit)) return amount * 28.3495;
  }
  const match = String(text || "").match(/([0-9]+(?:\.[0-9]+)?)\s*(g|grams?|oz|ounces?)\b/i);
  if (!match) return null;
  const parsed = Number(match[1]);
  return /^oz|ounce/i.test(match[2]) ? parsed * 28.3495 : parsed;
}

function barcodeFoodScore(food) {
  const nutrients = food?.nutrients || {};
  const macroCount = ["kcal", "protein", "fat", "carbs"].filter((key) =>
    Number.isFinite(Number(nutrients[key]))
  ).length;
  const detailCount = FOOD_ROW_NUTRIENTS.filter((key) =>
    Number.isFinite(Number(nutrients[key]))
  ).length;
  return macroCount * 20 + detailCount + (food?.servingGrams ? 8 : 0);
}

export async function openFoodFactsBarcode(value) {
  const code = normalizeBarcode(value);
  if (!code) return null;
  const fields = [
    "code",
    "product_name",
    "generic_name",
    "brands",
    "quantity",
    "serving_size",
    "serving_quantity",
    "serving_quantity_unit",
    "nutriments",
  ].join(",");
  const url = `https://world.openfoodfacts.org/api/v3/product/${encodeURIComponent(code)}?fields=${encodeURIComponent(fields)}`;
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "BigBricey/1.0 (https://www.bigbricey.com; barcode lookup)",
    },
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || data?.status !== "success" || !data?.product) return null;
  const product = data.product;
  const description =
    product.product_name || product.generic_name || product.brands || "Packaged food";
  return {
    fdcId: String(product.code || code),
    description,
    brandOwner: product.brands || null,
    dataType: "OpenFoodFactsBarcode",
    nutrients: offNutrients(product.nutriments || {}),
    servingGrams: gramsFromServing(
      product.serving_quantity,
      product.serving_quantity_unit,
      product.serving_size
    ),
    servingText: product.serving_size || null,
    packageQuantity: product.quantity || null,
    sourceUrl: `https://world.openfoodfacts.org/product/${encodeURIComponent(code)}`,
    _src: "openfoodfacts-barcode",
  };
}

function sameGtin(a, b) {
  const left = String(a || "").replace(/\D/g, "").replace(/^0+/, "");
  const right = String(b || "").replace(/\D/g, "").replace(/^0+/, "");
  return Boolean(left && right && left === right);
}

export async function usdaBarcodeSearch(value) {
  const code = normalizeBarcode(value);
  const key = process.env.USDA_API_KEY;
  if (!code || !key) return null;
  const url = new URL("https://api.nal.usda.gov/fdc/v1/foods/search");
  url.searchParams.set("query", code);
  url.searchParams.set("pageSize", "10");
  url.searchParams.set("dataType", "Branded");
  url.searchParams.set("api_key", key);
  const response = await fetch(url);
  const data = await response.json().catch(() => null);
  if (!response.ok || !Array.isArray(data?.foods)) return null;
  const food = data.foods.find((item) => sameGtin(item.gtinUpc, code));
  if (!food) return null;
  return {
    fdcId: food.fdcId,
    description: food.description || "Packaged food",
    brandOwner: food.brandOwner || food.brandName || null,
    dataType: "USDABarcode",
    nutrients: pickNutrients(food.foodNutrients || []),
    servingGrams: gramsFromServing(
      food.servingSize,
      food.servingSizeUnit,
      food.householdServingFullText
    ),
    servingText: food.householdServingFullText || null,
    sourceUrl: `https://fdc.nal.usda.gov/food-details/${encodeURIComponent(food.fdcId)}/nutrients`,
    _src: "usda-barcode",
  };
}

const barcodeCache = new Map();

/** Exact product lookup. This never substitutes a fuzzy text-search result. */
export async function lookupBarcode(value) {
  const code = normalizeBarcode(value);
  if (!code) return { code: null, food: null, errors: ["invalid_barcode"] };
  const cached = barcodeCache.get(code);
  if (cached && Date.now() - cached.at < 10 * 60 * 1000) return cached.value;
  const settled = await Promise.allSettled([
    openFoodFactsBarcode(code),
    usdaBarcodeSearch(code),
  ]);
  const foods = settled
    .filter((result) => result.status === "fulfilled" && result.value)
    .map((result) => result.value)
    .sort((a, b) => barcodeFoodScore(b) - barcodeFoodScore(a));
  const result = {
    code,
    food: foods[0] || null,
    alternatives: foods.slice(1),
    errors: settled
      .filter((entry) => entry.status === "rejected")
      .map((entry) => String(entry.reason?.message || entry.reason)),
  };
  barcodeCache.set(code, { at: Date.now(), value: result });
  return result;
}

/**
 * Resolve food text → nutrition row.
 * @param {string} text
 * @param {{ email?: string, findSavedFood?: Function, rowFromSavedFood?: Function }} opts
 *   Optional saved-foods lookup (injected to avoid circular imports).
 */
export async function resolveFood(text, opts = {}) {
  const parseFoodFn =
    typeof opts.parseFoodFn === "function" ? opts.parseFoodFn : parseFood;
  const foodSearchFn =
    typeof opts.foodSearchFn === "function" ? opts.foodSearchFn : foodSearch;
  const parseResult = await parseFoodFn(text);
  const normalized = normalizeParsedFoodQuantity(text, parseResult.parsed);
  if (normalized?.error === "off_topic") {
    return { error: "off_topic" };
  }

  const originalQuery = normalized?.food_query || text;
  const custom = matchCustomFood(originalQuery);
  if (custom) {
    return {
      parsed: normalized,
      match: { description: custom.description, source: "custom" },
      row: rowFromCustom(normalized, custom),
      note: "custom food",
    };
  }

  // Personal library (shakes, recipes) before USDA
  if (opts.email && typeof opts.findSavedFood === "function") {
    try {
      const saved = await opts.findSavedFood(opts.email, originalQuery);
      if (saved && typeof opts.rowFromSavedFood === "function") {
        const amount = Number(normalized?.amount) || 1;
        return {
          parsed: normalized,
          match: { description: saved.name, source: "saved" },
          row: opts.rowFromSavedFood(saved, amount),
          note: "saved food",
        };
      }
    } catch {
      /* fall through to USDA */
    }
  }

  const learned = applyLearnedUsualPortion(
    text,
    normalized,
    opts.foodCorrections
  );
  const parsed = learned.parsed;
  const q = parsed?.food_query || text;

  const searchQ = expandQuery(q);
  let search;
  try {
    const queries =
      searchQ.toLowerCase() === String(q).toLowerCase()
        ? [searchQ]
        : [searchQ, q];
    const searches = await Promise.all(
      queries.map((query) => foodSearchFn(query))
    );
    search = {
      query: q,
      foods: searches
        .flatMap((result) => result.foods || [])
        .sort((a, b) => b.score - a.score),
      errors: searches.flatMap((result) => result.errors || []),
    };
  } catch (e) {
    return {
      parsed,
      match: null,
      row: null,
      note: "Food lookup failed — try again",
      detail: e.detail || String(e.message || e),
    };
  }

  // Search expansion improves ranking, but semantic acceptance is checked
  // against what the user actually named so "bacon" does not require every
  // word from the USDA-oriented expansion.
  const best = pickBestFood(search.foods || [], q);
  if (!best) {
    const saltNote = /\bsalt\b/i.test(q)
      ? "I couldn't find a credible pure-salt nutrition match, so I did not substitute a snack or seasoning product. Give me the package label or an exact gram amount."
      : "No credible match in the food databases — try a more specific name or package label";
    return {
      parsed,
      match: null,
      row: null,
      note: saltNote,
      detail: search.errors || null,
    };
  }

  const grams = verifiedFoodGrams(parsed, q);
  if (grams == null) {
    return {
      parsed,
      match: best,
      row: null,
      note: `I found “${best.description}”, but I couldn't verify the weight of “${formatAmount(parsed) || "that serving"}” for this exact food. Give me grams, ounces, pounds, or the package serving weight.`,
    };
  }
  const row = foodRowFromPer100(best, grams, {
    label: `${formatAmount(parsed)} ${best.description}`.trim(),
  });
  if (row?.extras?.provenance && learned.correction) {
    row.extras.provenance.portion_source = "user_confirmed_usual";
    row.extras.provenance.food_correction_id = learned.correction.id;
    row.extras.provenance.portion_estimated = false;
  }

  // Never ship a blank-calorie row if we can avoid it
  const positiveEnergyOrMacro = [row.kcal, row.protein, row.fat, row.carbs].some(
    (value) => Number(value) > 0
  );
  const explicitMacroSet = [row.kcal, row.protein, row.fat, row.carbs].every(
    (value) => value != null && Number.isFinite(Number(value))
  );
  if (!positiveEnergyOrMacro && !explicitMacroSet) {
    return {
      parsed,
      match: best,
      row: null,
      note: "Found a match but nutrition data was incomplete — try a more specific name (e.g. canned artichoke hearts)",
    };
  }

  return {
    parsed,
    match: best,
    row,
    note: null,
    learned_correction: learned.correction,
  };
}

function formatAmount(parsed) {
  if (!parsed) return "";
  return `${parsed.amount || ""} ${parsed.unit || ""}`.trim();
}

export function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Vary", "Cookie");
  res.end(JSON.stringify(body));
}

export async function readBody(req, { maxBytes = Infinity } = {}) {
  if (req.body && typeof req.body === "object") {
    if (Buffer.byteLength(JSON.stringify(req.body), "utf8") > maxBytes) {
      const error = new Error("Request body is too large.");
      error.code = "request_too_large";
      error.status = 413;
      throw error;
    }
    return req.body;
  }
  const chunks = [];
  let total = 0;
  for await (const c of req) {
    total += c.length;
    if (total > maxBytes) {
      const error = new Error("Request body is too large.");
      error.code = "request_too_large";
      error.status = 413;
      throw error;
    }
    chunks.push(c);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
