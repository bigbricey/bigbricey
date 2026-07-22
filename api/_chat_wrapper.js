/**
 * Pure helpers for the chat wrapper.
 *
 * Keep these free of network/database calls so the context and reply contracts
 * can be regression-tested without talking to the model.
 */

const CORE_NUTRIENTS = [
  "kcal",
  "protein",
  "fat",
  "carbs",
  "net_carbs",
  "fiber",
  "sugars",
  "potassium",
  "magnesium",
  "sodium",
  "calcium",
  "iron",
];

function finiteNumber(value) {
  if (value == null) return null;
  if (typeof value === "string" && !value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function roundTotal(value) {
  return Math.round((Number(value) + Number.EPSILON) * 1000) / 1000;
}

function safeNutrientMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out = {};
  for (const [rawKey, rawValue] of Object.entries(value)) {
    if (Object.keys(out).length >= 40) break;
    const key = String(rawKey || "")
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9_ -]/g, "_")
      .slice(0, 60);
    const number = finiteNumber(rawValue);
    if (key && number != null) out[key] = number;
  }
  return out;
}

/**
 * Preserve the nutrition data already present in today's ledger and provide
 * deterministic totals for factual questions such as "how much fiber?".
 */
export function buildCurrentLogContext(rows = []) {
  const items = [];
  const knownSubtotals = Object.fromEntries(CORE_NUTRIENTS.map((key) => [key, 0]));
  const knownCounts = Object.fromEntries(CORE_NUTRIENTS.map((key) => [key, 0]));
  const extraTotals = {};
  const extraCounts = {};

  for (const raw of Array.isArray(rows) ? rows : []) {
    if (!raw || typeof raw !== "object") continue;
    const extras =
      raw.extras && typeof raw.extras === "object" && !Array.isArray(raw.extras)
        ? raw.extras
        : {};
    const nestedNutrients = {
      ...safeNutrientMap(extras.nutrients),
      ...safeNutrientMap(raw.nutrients),
    };
    const item = {
      id: String(raw.id || "").slice(0, 120),
      label: String(raw.label || "Unknown food").slice(0, 240),
    };

    const source = String(raw.source || "").trim();
    if (source) item.source = source.slice(0, 80);

    const grams = finiteNumber(raw.grams);
    if (grams != null) item.grams = grams;

    const directValue = (key) => {
      let number = finiteNumber(raw[key]);
      if (number == null) number = finiteNumber(extras[key]);
      if (number == null) number = finiteNumber(nestedNutrients[key]);
      return number;
    };

    for (const key of CORE_NUTRIENTS.filter((name) => name !== "net_carbs")) {
      const number = directValue(key);
      if (number == null) continue;
      item[key] = number;
      knownSubtotals[key] += number;
      knownCounts[key] += 1;
      delete nestedNutrients[key];
    }

    let netCarbs = directValue("net_carbs");
    if (netCarbs == null && item.carbs != null && item.fiber != null) {
      netCarbs = Math.max(0, item.carbs - item.fiber);
    }
    if (netCarbs != null) {
      item.net_carbs = netCarbs;
      knownSubtotals.net_carbs += netCarbs;
      knownCounts.net_carbs += 1;
      delete nestedNutrients.net_carbs;
    }

    if (Object.keys(nestedNutrients).length) {
      item.nutrients = nestedNutrients;
      for (const [key, number] of Object.entries(nestedNutrients)) {
        extraTotals[key] = (extraTotals[key] || 0) + number;
        extraCounts[key] = (extraCounts[key] || 0) + 1;
      }
    }
    items.push(item);
  }

  const totals = {};
  const known_subtotals = {};
  const coverage = {};
  for (const key of CORE_NUTRIENTS) {
    const known = knownCounts[key];
    const unknown = items.length - known;
    const subtotal = roundTotal(knownSubtotals[key]);
    const complete = unknown === 0;
    coverage[key] = {
      reported_items: known,
      unreported_items: unknown,
      all_rows_report_value: complete,
    };
    if (known > 0) known_subtotals[key] = subtotal;
    if (complete) totals[key] = subtotal;
  }
  const extra_nutrient_totals = {};
  const extra_nutrient_known_subtotals = {};
  const extra_nutrient_coverage = {};
  for (const key of Object.keys(extraTotals)) {
    const known = extraCounts[key] || 0;
    const unknown = items.length - known;
    const subtotal = roundTotal(extraTotals[key]);
    const complete = unknown === 0;
    extra_nutrient_known_subtotals[key] = subtotal;
    extra_nutrient_coverage[key] = {
      reported_items: known,
      unreported_items: unknown,
      all_rows_report_value: complete,
    };
    if (complete) extra_nutrient_totals[key] = subtotal;
  }

  return {
    items,
    totals,
    known_subtotals,
    coverage,
    data_quality: {
      zero_may_mean_unreported: true,
      note:
        "Older imported records may not distinguish an exact zero from an unreported nutrient. Use coverage fields and avoid claiming completeness when rows are unreported.",
    },
    ...(Object.keys(extraTotals).length
      ? {
          extra_nutrient_totals,
          extra_nutrient_known_subtotals,
          extra_nutrient_coverage,
        }
      : {}),
  };
}

/**
 * Normalize model history, remove failed/unanswered tail turns, and keep the
 * active context small enough that stale bot wording does not dominate voice.
 */
export function prepareModelHistory(
  messages = [],
  { maxMessages = 24, maxChars = 24_000, currentText = "" } = {}
) {
  const prepared = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    const role =
      message?.role === "assistant" || message?.role === "bot"
        ? "assistant"
        : message?.role === "user"
          ? "user"
          : null;
    const content = String(message?.content || "").trim();
    if (!role || !content) continue;
    prepared.push({ role, content: content.slice(0, 8000) });
  }

  const continuation =
    /^(?:(?:please\s+)?try(?:\s+(?:that|it))?\s+again\b|(?:please\s+)?(?:do|run|send|log|add|change|make|set)\s+(?:that|it)(?:\s+again)?\b|go\s+ahead\b|same\s+thing\b|again\b|retry\b|(?:and|also|plus|actually|wait)\b)/i.test(
      String(currentText || "").trim()
    );
  let mostRecentUnanswered = null;
  while (prepared.at(-1)?.role === "user") {
    const removed = prepared.pop();
    if (!mostRecentUnanswered) mostRecentUnanswered = removed;
  }
  if (continuation && mostRecentUnanswered) prepared.push(mostRecentUnanswered);

  const limit = Math.max(0, Number(maxMessages) || 0);
  const messageCapped =
    limit && prepared.length > limit ? prepared.slice(-limit) : prepared;
  const charBudget = Math.max(1_000, Math.min(40_000, Number(maxChars) || 24_000));
  const capped = [];
  let usedChars = 0;
  for (let index = messageCapped.length - 1; index >= 0; index -= 1) {
    const message = messageCapped[index];
    const cost = message.content.length + 20;
    if (capped.length && usedChars + cost > charBudget) break;
    capped.unshift(message);
    usedChars += cost;
  }
  while (capped[0]?.role === "assistant") capped.shift();
  return capped;
}

/**
 * A pre-action model sentence never overrules the executor. The current
 * one-pass wrapper makes the model speak before tools run, so only executor
 * receipts know whether a read or mutation actually succeeded. Pure chat has
 * no receipts and keeps the model's natural answer.
 */
export function composeActionReply({ modelReply = "", executionNotes = [] } = {}) {
  const voice = String(modelReply || "").trim();
  const notes = (Array.isArray(executionNotes) ? executionNotes : [])
    .map((note) => String(note || "").trim())
    .filter(Boolean);
  const receipt = notes.join(" ");

  return receipt || voice;
}

export function recordedDayReply(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return "";
  if (Array.isArray(data.unavailable) && data.unavailable.length) return "";
  const foods = Array.isArray(data.food) ? data.food : null;
  if (!foods) return "";
  if (!foods.length) {
    return "You haven’t logged any food today. Nothing changed.";
  }
  const labels = foods
    .map((item) => String(item?.label || "").trim())
    .filter(Boolean)
    .slice(0, 8);
  let reply = `You logged ${foods.length} food item${foods.length === 1 ? "" : "s"} today`;
  if (labels.length) reply += `: ${labels.join(", ")}`;
  reply += ".";
  const totals =
    data.totals && typeof data.totals === "object" && !Array.isArray(data.totals)
      ? data.totals
      : {};
  const summary = [];
  if (finiteNumber(totals.kcal) != null) summary.push(`${roundTotal(totals.kcal)} kcal`);
  if (finiteNumber(totals.protein) != null) {
    summary.push(`${roundTotal(totals.protein)} g protein`);
  }
  if (summary.length) reply += ` Verified total: ${summary.join(" and ")}.`;
  return `${reply} Nothing changed.`.slice(0, 1_200);
}
