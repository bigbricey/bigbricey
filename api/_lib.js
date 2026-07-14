/** Shared BigBricey helpers for Vercel serverless */

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
  if (word === "half") return 0.5;
  if (word === "quarter") return 0.25;
  if (word === "one" || word === "a" || word === "an") return 1;
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
  const amountToken = "(half|quarter|one|a|an|[\\d.]+\\/[\\d.]+|[\\d.]+)";
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
  if (/^egg/.test(t)) return "Eggs, Grade A, Large, egg whole";
  if (/brisket/.test(t)) return "beef brisket";
  return q;
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
  };
}

export function pickNutrients(list) {
  const byId = {};
  const byName = {};
  for (const n of list) {
    const id = n.nutrientId || n.nutrientNumber;
    const name = (n.nutrientName || n.nutrient || "").toLowerCase();
    const raw = n.value ?? n.amount;
    if (raw == null || raw === "") continue;
    const val = Number(raw);
    if (!Number.isFinite(val)) continue;
    if (id != null) byId[id] = val;
    if (name) byName[name] = val;
  }
  const get = (...keys) => {
    for (const k of keys) {
      if (byId[k] != null) return byId[k];
      if (byName[k] != null) return byName[k];
    }
    return null;
  };
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
  const nutrients = {
    kcal,
    protein: finiteOrNull(n.proteins_100g, n.proteins),
    fat: finiteOrNull(n.fat_100g, n.fat),
    carbs: finiteOrNull(n.carbohydrates_100g, n.carbohydrates),
    fiber: finiteOrNull(n.fiber_100g, n.fiber),
    sugars: finiteOrNull(n.sugars_100g, n.sugars),
    potassium: finiteOrNull(n.potassium_100g, n.potassium),
    magnesium: finiteOrNull(n.magnesium_100g, n.magnesium),
    sodium: finiteOrNull(n.sodium_100g, n.sodium),
  };
  // OFF often stores minerals in grams when value is small (< ~5)
  for (const k of ["potassium", "magnesium", "sodium"]) {
    if (nutrients[k] > 0 && nutrients[k] < 5) nutrients[k] = nutrients[k] * 1000;
  }
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

/**
 * Resolve food text → nutrition row.
 * @param {string} text
 * @param {{ email?: string, findSavedFood?: Function, rowFromSavedFood?: Function }} opts
 *   Optional saved-foods lookup (injected to avoid circular imports).
 */
export async function resolveFood(text, opts = {}) {
  const parseResult = await parseFood(text);
  const parsed = normalizeParsedFoodQuantity(text, parseResult.parsed);
  if (parsed?.error === "off_topic") {
    return { error: "off_topic" };
  }

  const q = parsed?.food_query || text;
  const custom = matchCustomFood(q);
  if (custom) {
    return {
      parsed,
      match: { description: custom.description, source: "custom" },
      row: rowFromCustom(parsed, custom),
      note: "custom food",
    };
  }

  // Personal library (shakes, recipes) before USDA
  if (opts.email && typeof opts.findSavedFood === "function") {
    try {
      const saved = await opts.findSavedFood(opts.email, q);
      if (saved && typeof opts.rowFromSavedFood === "function") {
        const amount = Number(parsed?.amount) || 1;
        return {
          parsed,
          match: { description: saved.name, source: "saved" },
          row: opts.rowFromSavedFood(saved, amount),
          note: "saved food",
        };
      }
    } catch {
      /* fall through to USDA */
    }
  }

  const searchQ = expandQuery(q);
  let search;
  try {
    const queries =
      searchQ.toLowerCase() === String(q).toLowerCase()
        ? [searchQ]
        : [searchQ, q];
    const searches = await Promise.all(queries.map((query) => foodSearch(query)));
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
  const scale = grams / 100;
  const n = best.nutrients || {};
  const scaledNutrient = (value) => {
    if (value == null || value === "") return undefined;
    const number = Number(value);
    return Number.isFinite(number) ? round(number * scale) : undefined;
  };
  const row = {
    id: crypto.randomUUID(),
    label: `${formatAmount(parsed)} ${best.description}`.trim(),
    source: best._src || best.dataType || "lookup",
    fdcId: best.fdcId,
    grams,
    kcal: scaledNutrient(n.kcal),
    protein: scaledNutrient(n.protein),
    fat: scaledNutrient(n.fat),
    carbs: scaledNutrient(n.carbs),
    fiber: scaledNutrient(n.fiber),
    sugars: scaledNutrient(n.sugars),
    potassium: scaledNutrient(n.potassium),
    magnesium: scaledNutrient(n.magnesium),
    sodium: scaledNutrient(n.sodium),
  };

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

  return { parsed, match: best, row, note: null };
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

export async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
