import "dotenv/config";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3847;

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

// Health
app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    openrouter: Boolean(process.env.OPENROUTER_API_KEY),
    model: process.env.OPENROUTER_MODEL || null,
  });
});

/**
 * Parse natural language food into structured amount.
 * Uses OpenRouter when key is set; otherwise a tiny offline guesser.
 */
app.post("/api/parse-food", async (req, res) => {
  const text = String(req.body?.text || "").trim();
  if (!text) return res.status(400).json({ error: "text required" });

  // Offline fallback so the app works before API key
  if (!process.env.OPENROUTER_API_KEY) {
    return res.json({
      source: "offline-stub",
      parsed: offlineParse(text),
      note: "No OPENROUTER_API_KEY yet — stub parser only. Add key to .env for DeepSeek.",
    });
  }

  try {
    const model = process.env.OPENROUTER_MODEL || "deepseek/deepseek-chat";
    const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://nutri-table.local",
        "X-Title": "BigBricey",
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [
          {
            role: "system",
            content: `You are BigBricey's food parser ONLY.
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
}`,
          },
          { role: "user", content: text },
        ],
      }),
    });

    const data = await r.json();
    if (!r.ok) {
      return res.status(502).json({ error: "openrouter_failed", detail: data });
    }
    const raw = data.choices?.[0]?.message?.content || "";
    const parsed = extractJson(raw);
    return res.json({ source: "openrouter", model, parsed, raw });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
});

/**
 * USDA FoodData Central search (free, no key required for basic search).
 */
app.get("/api/usda-search", async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (!q) return res.status(400).json({ error: "q required" });

  try {
    const url = new URL("https://api.nal.usda.gov/fdc/v1/foods/search");
    url.searchParams.set("query", q);
    url.searchParams.set("pageSize", "8");
    url.searchParams.set("dataType", "Foundation,SR Legacy,Survey (FNDDS)");
    if (process.env.USDA_API_KEY) {
      url.searchParams.set("api_key", process.env.USDA_API_KEY);
    } else {
      url.searchParams.set("api_key", "DEMO_KEY");
    }

    const r = await fetch(url);
    const data = await r.json();
    if (!r.ok) {
      return res.status(502).json({ error: "usda_failed", detail: data });
    }

    let foods = (data.foods || []).map((f) => ({
      fdcId: f.fdcId,
      description: f.description,
      brandOwner: f.brandOwner || null,
      dataType: f.dataType,
      score: scoreFood(q, f),
      nutrients: pickNutrients(f.foodNutrients || []),
    }));
    foods.sort((a, b) => b.score - a.score);
    res.json({ query: q, foods });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

/** Full resolve: parse text → USDA search → scale nutrients to amount */
app.post("/api/resolve", async (req, res) => {
  const text = String(req.body?.text || "").trim();
  if (!text) return res.status(400).json({ error: "text required" });

  // Reuse parse
  let parsed;
  if (!process.env.OPENROUTER_API_KEY) {
    parsed = offlineParse(text);
  } else {
    const pr = await fetch(`http://127.0.0.1:${PORT}/api/parse-food`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    }).then((r) => r.json());
    parsed = pr.parsed;
    if (parsed?.error === "off_topic") {
      return res.status(400).json({ error: "off_topic" });
    }
  }

  const q = expandQuery(parsed?.food_query || text);
  const search = await fetch(
    `http://127.0.0.1:${PORT}/api/usda-search?q=${encodeURIComponent(q)}`
  ).then((r) => r.json());

  const best = search.foods?.[0] || null;
  if (!best) {
    return res.json({
      parsed,
      match: null,
      row: null,
      note: "No USDA match — add manually or refine name",
    });
  }

  const grams = Number(parsed?.grams_estimate) || guessGrams(parsed) || 100;
  const scale = grams / 100;
  const n = best.nutrients;
  const row = {
    id: crypto.randomUUID(),
    label: `${formatAmount(parsed)} ${best.description}`.trim(),
    source: "usda",
    fdcId: best.fdcId,
    grams,
    kcal: round(n.kcal * scale),
    protein: round(n.protein * scale),
    fat: round(n.fat * scale),
    carbs: round(n.carbs * scale),
    fiber: round(n.fiber * scale),
    sugars: round(n.sugars * scale),
    potassium: round(n.potassium * scale),
    magnesium: round(n.magnesium * scale),
    sodium: round(n.sodium * scale),
  };

  res.json({ parsed, match: best, row, note: null });
});

app.listen(PORT, () => {
  console.log(`BigBricey → http://127.0.0.1:${PORT}`);
});

// ---------- helpers ----------

function extractJson(text) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return { error: "no_json", raw: text };
  try {
    return JSON.parse(m[0]);
  } catch {
    return { error: "bad_json", raw: text };
  }
}

function offlineParse(text) {
  const t = text.toLowerCase().trim();
  let amount = 1;
  let unit = "serving";
  let food = t;

  // Longer unit forms first so "eggs" doesn't become unit "egg" + leftover "s"
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

  if (unit === "eggs") {
    food = "eggs, grade a, large, egg whole";
  }

  return {
    food_query: (food || t).replace(/\s+/g, " ").trim(),
    amount,
    unit,
    grams_estimate: toGrams(amount, unit),
    notes: "offline stub parse",
  };
}

function evalFraction(s) {
  if (s.includes("/")) {
    const [a, b] = s.split("/").map(Number);
    return a / b;
  }
  return Number(s) || 1;
}

function toGrams(amount, unit) {
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
      return amount * 30; // placeholder until custom foods
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

function guessGrams(parsed) {
  if (!parsed) return 100;
  return toGrams(Number(parsed.amount) || 1, parsed.unit || "serving");
}

function formatAmount(parsed) {
  if (!parsed) return "";
  return `${parsed.amount || ""} ${parsed.unit || ""}`.trim();
}

function pickNutrients(list) {
  // USDA nutrient ids: 1008 energy, 1003 protein, 1004 fat, 1005 carb, 1079 fiber, 2000 sugars, 1092 K, 1090 Mg, 1093 Na
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

function round(n) {
  return Math.round((Number(n) || 0) * 10) / 10;
}

/** Prefer plain whole foods over candy/cereal brand hits */
function scoreFood(query, f) {
  const q = query.toLowerCase();
  const d = (f.description || "").toLowerCase();
  let s = 0;
  for (const word of q.split(/\s+/)) {
    if (word.length > 2 && d.includes(word)) s += 3;
  }
  if (d.startsWith(q.split(",")[0])) s += 5;
  if (f.dataType === "Foundation") s += 4;
  if (f.dataType === "SR Legacy") s += 3;
  if (f.dataType === "Survey (FNDDS)") s += 1;
  // demote junk / wrong matches
  if (/cereal|candy|cookie|cracker|oh!s|bits|imitation|soup|dressing|sandwich|sticks/i.test(d))
    s -= 10;
  if (/meatless|vegetarian|vegan/i.test(d)) s -= 15;
  if (/raw|whole|fresh|uncooked/i.test(d)) s += 3;
  if (/bacon/i.test(q) && /pork.*bacon|bacon.*unprepared|cured, bacon/i.test(d)) s += 10;
  if (/bacon/i.test(q) && /unprepared|raw/i.test(d)) s += 8;
  if (/bacon/i.test(q) && /meatless|salt pork|bits|restaurant|turkey/i.test(d)) s -= 12;
  if (/egg/i.test(q) && /grade a|large|whole/i.test(d)) s += 6;
  return s;
}

// Prefer better USDA queries for common shorthand
function expandQuery(q) {
  const t = q.toLowerCase().trim();
  if (t === "bacon" || t === "pork bacon") return "Pork, cured, bacon, unprepared";
  if (/^egg/.test(t)) return "Eggs, Grade A, Large, egg whole";
  return q;
}
