/** Shared BigBricey helpers for Vercel serverless */

export const SYSTEM_PROMPT = `You are BigBricey's food parser ONLY.
You convert a user's food phrase into JSON. You do NOT invent nutrition numbers.
You do NOT answer questions about history, code, or anything except food + amount.
If the message is not about logging food, return {"error":"off_topic"}.

Return ONLY valid JSON:
{
  "food_query": "short searchable food name",
  "amount": number,
  "unit": "g"|"oz"|"lb"|"scoop"|"scoops"|"egg"|"eggs"|"cup"|"tbsp"|"tsp"|"piece"|"serving",
  "grams_estimate": number or null,
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
    /^([\d./]+)\s*(pounds|pound|lbs|lb|ounces|ounce|oz|grams|gram|kg|g|scoops|scoop|eggs|egg|cups|cup|tbsp|tsp|pieces|piece)?\s*(.*)$/i
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
    case "scoop":
    case "scoops":
      return amount * 30;
    case "cup":
    case "cups":
      return amount * 150;
    case "tbsp":
      return amount * 15;
    case "tsp":
      return amount * 5;
    default:
      return 100;
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
    const val = n.value ?? n.amount ?? 0;
    if (id != null) byId[id] = val;
    byName[name] = val;
  }
  const get = (...keys) => {
    for (const k of keys) {
      if (byId[k] != null) return byId[k];
      if (byName[k] != null) return byName[k];
    }
    return 0;
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
  if (kcal > 0) s += 12;
  else s -= 40; // hard penalty — user sees blank calories
  if (protein > 0 || fat > 0 || carbs > 0) s += 6;
  if (kcal > 0 && protein > 0) s += 4;
  // garbage OFF entries sometimes claim fat/kcal with zero carbs for veggies
  if (/artichoke|berry|vegetable|fruit/i.test(q) && fat > 8 && carbs < 1) s -= 8;

  return s;
}

/** Normalize Open Food Facts nutriments → per-100g macros */
export function offNutrients(n) {
  n = n || {};
  let kcal =
    Number(n["energy-kcal_100g"] ?? n.energy_kcal_100g ?? n["energy-kcal"] ?? 0) || 0;
  if (!kcal) {
    const kj = Number(n["energy-kj_100g"] ?? n.energy_100g ?? n["energy-kj"] ?? 0) || 0;
    if (kj > 0) kcal = kj / 4.184;
  }
  const nutrients = {
    kcal,
    protein: Number(n.proteins_100g ?? n.proteins ?? 0) || 0,
    fat: Number(n.fat_100g ?? n.fat ?? 0) || 0,
    carbs: Number(n.carbohydrates_100g ?? n.carbohydrates ?? 0) || 0,
    fiber: Number(n.fiber_100g ?? n.fiber ?? 0) || 0,
    sugars: Number(n.sugars_100g ?? n.sugars ?? 0) || 0,
    potassium: Number(n.potassium_100g ?? n.potassium ?? 0) || 0,
    magnesium: Number(n.magnesium_100g ?? n.magnesium ?? 0) || 0,
    sodium: Number(n.sodium_100g ?? n.sodium ?? 0) || 0,
  };
  // OFF often stores minerals in grams when value is small (< ~5)
  for (const k of ["potassium", "magnesium", "sodium"]) {
    if (nutrients[k] > 0 && nutrients[k] < 5) nutrients[k] = nutrients[k] * 1000;
  }
  return nutrients;
}

export function pickBestFood(foods) {
  if (!foods?.length) return null;
  const sorted = [...foods].sort((a, b) => b.score - a.score);
  // Prefer first with real calories
  const withCals = sorted.find((f) => (Number(f.nutrients?.kcal) || 0) > 0);
  return withCals || sorted[0];
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
        f.nutrients.carbs > 0
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

export async function resolveFood(text) {
  const parseResult = await parseFood(text);
  const parsed = parseResult.parsed;
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

  const searchQ = expandQuery(q);
  let search;
  try {
    search = await foodSearch(searchQ);
  } catch (e) {
    return {
      parsed,
      match: null,
      row: null,
      note: "Food lookup failed — try again",
      detail: e.detail || String(e.message || e),
    };
  }

  const best = pickBestFood(search.foods || []);
  if (!best) {
    return {
      parsed,
      match: null,
      row: null,
      note: "No match in food databases — try a different name",
      detail: search.errors || null,
    };
  }

  const grams =
    Number(parsed?.grams_estimate) ||
    toGrams(Number(parsed?.amount) || 1, parsed?.unit || "serving") ||
    100;
  const scale = grams / 100;
  const n = best.nutrients || {};
  const row = {
    id: crypto.randomUUID(),
    label: `${formatAmount(parsed)} ${best.description}`.trim(),
    source: best._src || best.dataType || "lookup",
    fdcId: best.fdcId,
    grams,
    kcal: round((Number(n.kcal) || 0) * scale),
    protein: round((Number(n.protein) || 0) * scale),
    fat: round((Number(n.fat) || 0) * scale),
    carbs: round((Number(n.carbs) || 0) * scale),
    fiber: round((Number(n.fiber) || 0) * scale),
    sugars: round((Number(n.sugars) || 0) * scale),
    potassium: round((Number(n.potassium) || 0) * scale),
    magnesium: round((Number(n.magnesium) || 0) * scale),
    sodium: round((Number(n.sodium) || 0) * scale),
  };

  // Never ship a blank-calorie row if we can avoid it
  if (row.kcal <= 0 && row.protein <= 0 && row.fat <= 0) {
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
  res.setHeader("Access-Control-Allow-Origin", "*");
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
