const USUAL_WORDS = /\b(?:my\s+)?(?:usual|regular|normal|same\s+as\s+(?:usual|last\s+time))\b/i;

function clean(value, limit = 240) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

/** Stable lookup key for user-confirmed food corrections. */
export function normalizeFoodCorrectionKey(value) {
  return clean(value, 300)
    .toLowerCase()
    .replace(
      /^\s*(?:\d+(?:\.\d+)?|\d+\s*\/\s*\d+|one|two|three|four|five|six|seven|eight|nine|ten|half|quarter)\s*(?:lb|lbs|pounds?|oz|ounces?|g|grams?|kg|kilograms?|cups?|tbsp|tsp|servings?|pieces?|large|medium|small)?\s+(?:of\s+)?/i,
      ""
    )
    .replace(/\b(?:log|add|ate|had|having|have|my|the|a|an|usual|regular|normal)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

function tokens(value) {
  return new Set(
    normalizeFoodCorrectionKey(value)
      .split(" ")
      .filter((token) => token.length >= 3)
  );
}

function matchScore(query, hint) {
  const queryKey = normalizeFoodCorrectionKey(query);
  const hintKey = normalizeFoodCorrectionKey(hint?.correction_key);
  if (!queryKey || !hintKey) return 0;
  if (queryKey === hintKey) return 100;
  if (queryKey.includes(hintKey) || hintKey.includes(queryKey)) return 80;
  const queryTokens = tokens(queryKey);
  const hintTokens = tokens(hintKey);
  if (!queryTokens.size || !hintTokens.size) return 0;
  let shared = 0;
  for (const token of queryTokens) if (hintTokens.has(token)) shared += 1;
  return (shared / Math.max(queryTokens.size, hintTokens.size)) * 60;
}

export function findUsualFoodCorrection(text, hints = []) {
  if (!USUAL_WORDS.test(String(text || ""))) return null;
  return (Array.isArray(hints) ? hints : [])
    .filter(
      (hint) =>
        hint?.active !== false &&
        hint?.kind === "usual_portion" &&
        Number(hint?.correction?.grams) > 0
    )
    .map((hint) => ({ hint, score: matchScore(text, hint) }))
    .filter((entry) => entry.score >= 25)
    .sort(
      (a, b) =>
        b.score - a.score ||
        Number(b.hint?.confirmations || 0) - Number(a.hint?.confirmations || 0)
    )[0]?.hint || null;
}

/** Apply only when the user explicitly says usual/regular and omits a quantity. */
export function applyLearnedUsualPortion(text, parsed, hints = []) {
  const hint = findUsualFoodCorrection(text, hints);
  if (!hint) return { parsed, correction: null };
  const grams = Number(hint.correction?.grams);
  if (!Number.isFinite(grams) || grams <= 0 || grams > 100_000) {
    return { parsed, correction: null };
  }
  const foodQuery = clean(
    hint.correction?.food_query || hint.correction_key,
    180
  );
  if (!foodQuery) return { parsed, correction: null };
  return {
    parsed: {
      ...(parsed || {}),
      food_query: foodQuery,
      amount: grams,
      unit: "g",
      grams_estimate: grams,
      notes: "Applied the user's confirmed usual portion.",
    },
    correction: {
      id: hint.id || null,
      correction_key: hint.correction_key,
      grams,
      food_query: foodQuery,
      confirmations: Number(hint.confirmations || 1),
    },
  };
}

/** Create a learnable usual portion from a successful explicit ledger edit. */
export function usualPortionCorrectionFromUpdate(oldRow, newRow) {
  const oldGrams = Number(oldRow?.grams);
  const grams = Number(newRow?.grams);
  if (!Number.isFinite(grams) || grams <= 0 || grams > 100_000) return null;
  if (Number.isFinite(oldGrams) && Math.abs(oldGrams - grams) < 0.05) return null;
  const sourceDescription = clean(
    newRow?.extras?.provenance?.source_description || newRow?.label,
    180
  );
  const correctionKey = normalizeFoodCorrectionKey(
    oldRow?.extras?.provenance?.source_description || oldRow?.label
  );
  if (!correctionKey || !sourceDescription) return null;
  return {
    correctionKey,
    kind: "usual_portion",
    correction: {
      food_query: sourceDescription,
      grams: Math.round(grams * 10) / 10,
      source: "confirmed_ledger_update",
    },
  };
}

export function foodCorrectionPrompt(hints = []) {
  const candidates = (Array.isArray(hints) ? hints : [])
    .filter((hint) => hint?.active !== false)
    .slice(0, 8)
    .map((hint) => ({
      food: clean(hint.correction_key, 120),
      kind: clean(hint.kind, 32),
      grams:
        Number.isFinite(Number(hint?.correction?.grams))
          ? Number(hint.correction.grams)
          : null,
      canonical_food: clean(hint?.correction?.food_query, 140) || null,
      confirmations: Math.max(1, Number(hint.confirmations || 1)),
    }));
  const safe = [];
  for (const candidate of candidates) {
    const next = [...safe, candidate];
    if (JSON.stringify(next).length > 900) break;
    safe.push(candidate);
  }
  return JSON.stringify(safe);
}
