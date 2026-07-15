import crypto from "crypto";

import { requireUser, sendJson } from "./_auth.js";
import {
  foodRowFromPer100,
  lookupBarcode,
  normalizeBarcode,
  readBody,
  resolveFoodAtGrams,
  round,
} from "./_lib.js";
import { llmChat } from "./_llm.js";
import {
  findSavedFood,
  getProfile,
  logLlmUsage,
  mergeProfilePrefs,
  reserveLlmTurn,
  rowFromSavedFood,
} from "./_supabase.js";
import {
  WEB_NUTRITION_RESPONSE_FORMAT,
  barcodeFoodToItem,
  calibrationHints,
  labelAnalysisToItem,
  mergeVisionCorrections,
  normalizeVisionAnalysis,
  normalizeVisionMode,
  normalizeWebNutrition,
  parseVisionJson,
  responseFormatForVision,
  sanitizeVisionCorrections,
  validateImageDataUrl,
  visionModels,
  visionPrompt,
} from "./_vision.js";

const IMAGE_REQUEST_LIMIT = 4_100_000;

function responseSummary(mode, items, analysis) {
  if (mode === "meal") {
    if (!items.length) {
      return analysis.questions?.[0] || "I couldn't identify a loggable food in that photo.";
    }
    const unresolved = items.filter((item) => item.status !== "ready").length;
    return unresolved
      ? `I found ${items.length} possible items. ${unresolved} still need your help before logging.`
      : `I found ${items.length} item${items.length === 1 ? "" : "s"}. Check the portions before logging.`;
  }
  if (mode === "label") {
    return items[0]?.status === "ready"
      ? "I copied the visible per-serving values. Check them against the package before logging."
      : "I couldn't read enough of that label to create a safe draft.";
  }
  return items.length
    ? "I found an exact barcode match. Check how much you ate before logging."
    : "I couldn't verify that barcode in the product databases. Try a closer barcode photo or photograph the Nutrition Facts label.";
}

function analysisNeedsFallback(mode, analysis) {
  if (mode === "meal") return !analysis.items?.length && !analysis.questions?.length;
  if (mode === "label") {
    return !Object.values(analysis.nutrients_per_serving || {}).some(
      (value) => value != null
    );
  }
  return !normalizeBarcode(analysis.barcode);
}

async function trackedChat(email, options, purpose, conversationId) {
  const output = await llmChat(options);
  await logLlmUsage(email, output.usage, {
    model: output.model,
    provider: output.provider,
    purpose,
    conversation_id: conversationId,
  });
  return output;
}

async function analyzePhoto(email, mode, image, { calibration, conversationId } = {}) {
  const models = visionModels();
  const candidates = [...new Set([models.primary, models.fallback].filter(Boolean))];
  let lastError = null;
  for (const model of candidates) {
    try {
      const output = await trackedChat(
        email,
        {
          model,
          title: `BigBricey-${mode}-photo`,
          temperature: 0,
          maxTokens: mode === "meal" ? 1_800 : 1_200,
          responseFormat: responseFormatForVision(mode),
          messages: [
            { role: "system", content: visionPrompt(mode, { calibration }) },
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text:
                    mode === "meal"
                      ? "Analyze this meal photo for a draft food log."
                      : mode === "label"
                        ? "Read this Nutrition Facts label."
                        : "Read the complete barcode digits in this photo.",
                },
                { type: "image_url", image_url: { url: image } },
              ],
            },
          ],
        },
        `vision_${mode}`,
        conversationId
      );
      const analysis = normalizeVisionAnalysis(mode, parseVisionJson(output.content));
      if (!analysisNeedsFallback(mode, analysis) || model === candidates.at(-1)) {
        return { analysis, model: output.model, provider: output.provider };
      }
      lastError = new Error("vision_result_incomplete");
    } catch (error) {
      lastError = error;
    }
  }
  const error = new Error("I couldn't read that photo clearly enough. Try again with brighter light and the food or label filling the frame.");
  error.code = "vision_analysis_failed";
  error.status = lastError?.status === 429 ? 429 : 502;
  throw error;
}

async function mapWithLimit(values, limit, mapper) {
  const results = new Array(values.length);
  let next = 0;
  async function worker() {
    while (next < values.length) {
      const index = next;
      next += 1;
      results[index] = await mapper(values[index], index);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, () => worker())
  );
  return results;
}

async function officialWebNutrition(email, item, grams, conversationId) {
  if (!item.brand_hint) return null;
  const models = visionModels();
  try {
    const output = await trackedChat(
      email,
      {
        model: process.env.OPENROUTER_WEB_MODEL || models.primary,
        title: "BigBricey-official-nutrition-search",
        temperature: 0,
        maxTokens: 900,
        responseFormat: WEB_NUTRITION_RESPONSE_FORMAT,
        tools: [
          {
            type: "openrouter:web_search",
            parameters: {
              engine: "exa",
              max_results: 3,
              max_total_results: 3,
              search_context_size: "low",
            },
          },
        ],
        messages: [
          {
            role: "system",
            content:
              "Find nutrition only on an official manufacturer or restaurant page. Return per-100g values only when the source supports them or provides a serving weight that makes the conversion exact. Never use a blog, calorie-estimate site, search snippet alone, or an unrelated product. If an official match is not certain, found must be false.",
          },
          {
            role: "user",
            content: `Official nutrition for ${item.brand_hint} ${item.name}${item.preparation ? `, ${item.preparation}` : ""}.`,
          },
        ],
      },
      "vision_official_web_lookup",
      conversationId
    );
    const food = normalizeWebNutrition(parseVisionJson(output.content));
    if (!food) return null;
    const row = foodRowFromPer100(food, grams);
    if (!row) return null;
    return { food, row };
  } catch {
    return null;
  }
}

function mealItemResult(item, resolved, index) {
  const row = resolved?.row || null;
  if (row) {
    row.extras = {
      ...(row.extras || {}),
      photo_estimate: true,
      visual_food_name: item.name,
      estimated_grams: item.estimated_grams,
      estimated_grams_min: item.min_grams,
      estimated_grams_max: item.max_grams,
    };
  }
  const match = resolved?.match;
  return {
    id: crypto.randomUUID(),
    status: row ? "ready" : "unresolved",
    name: item.name,
    identified_as: match?.description || item.visual_description || item.name,
    confidence: item.confidence,
    quantity_kind: "grams",
    quantity_label: "Estimated grams",
    base_quantity: item.estimated_grams,
    proposed_quantity: item.estimated_grams,
    min_quantity: item.min_grams,
    max_quantity: item.max_grams,
    original_estimated_grams: item.estimated_grams,
    row,
    source_label:
      match?.source === "saved"
        ? "Your saved foods"
        : row?.source === "custom"
          ? "Your custom food"
          : row?.source?.startsWith("usda")
            ? "USDA FoodData Central"
            : row
              ? "Open Food Facts / USDA"
              : "No verified nutrition match",
    source_url: null,
    note:
      resolved?.note ||
      item.uncertainty ||
      `Photo estimate ${round(item.min_grams)}–${round(item.max_grams)} g.`,
    selection_order: index,
  };
}

async function resolveMealItems(email, analysis, conversationId) {
  const results = await mapWithLimit(analysis.items || [], 3, async (item, index) => {
    const query = [item.preparation, item.name].filter(Boolean).join(" ");
    const resolved = await resolveFoodAtGrams(query, item.estimated_grams, {
      email,
      findSavedFood,
      rowFromSavedFood,
    });
    return mealItemResult(item, resolved, index);
  });

  // A branded item may not exist in USDA/OFF. Search only official sources,
  // and cap this expensive fallback at two items per photo.
  const unresolved = results
    .map((result, index) => ({ result, index }))
    .filter(({ result }) => result.status !== "ready")
    .slice(0, 2);
  for (const { result, index } of unresolved) {
    const sourceItem = analysis.items[index];
    const web = await officialWebNutrition(
      email,
      sourceItem,
      sourceItem.estimated_grams,
      conversationId
    );
    if (!web) continue;
    web.row.extras = {
      ...(web.row.extras || {}),
      photo_estimate: true,
      web_estimate: true,
      visual_food_name: sourceItem.name,
      estimated_grams: sourceItem.estimated_grams,
      estimated_grams_min: sourceItem.min_grams,
      estimated_grams_max: sourceItem.max_grams,
      source_url: web.food.sourceUrl,
    };
    results[index] = {
      ...result,
      status: "ready",
      row: web.row,
      identified_as: web.food.description,
      confidence: result.confidence === "high" ? "medium" : result.confidence,
      source_label: "Official web nutrition",
      source_url: web.food.sourceUrl,
      note:
        web.food.warning ||
        "Official nutrition source found; the portion is still a photo estimate.",
    };
  }
  return results;
}

async function rememberCorrections(email, body) {
  const incoming = sanitizeVisionCorrections(body.corrections);
  if (!incoming.length) return { ok: true, remembered: 0 };
  const profile = await getProfile(email);
  const prefs = profile?.prefs && typeof profile.prefs === "object" ? profile.prefs : {};
  const merged = mergeVisionCorrections(prefs.vision_calibration, incoming);
  await mergeProfilePrefs(email, { vision_calibration: merged });
  return { ok: true, remembered: incoming.length };
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.setHeader("Allow", "POST, OPTIONS");
    return res.status(204).end();
  }
  if (req.method !== "POST") return sendJson(res, 405, { error: "POST only" });

  const user = await requireUser(req, res);
  if (!user) return;

  try {
    const body = await readBody(req, { maxBytes: IMAGE_REQUEST_LIMIT });
    if (body?.op === "remember_correction") {
      return sendJson(res, 200, await rememberCorrections(user.email, body));
    }

    const mode = normalizeVisionMode(body?.mode);
    if (!mode) {
      return sendJson(res, 400, {
        error: "invalid_vision_mode",
        message: "Choose meal photo, nutrition label, or barcode.",
      });
    }

    const suppliedBarcode = normalizeBarcode(body?.barcode);
    let analyzed = null;
    let analysis = null;
    if (mode !== "barcode" || !suppliedBarcode) {
      const image = validateImageDataUrl(body?.image);
      await reserveLlmTurn(user.email);
      let calibration = "";
      if (mode === "meal") {
        const profile = await getProfile(user.email).catch(() => null);
        calibration = calibrationHints(profile?.prefs?.vision_calibration);
      }
      analyzed = await analyzePhoto(user.email, mode, image, {
        calibration,
        conversationId: body?.conversation_id,
      });
      analysis = analyzed.analysis;
    }

    let items = [];
    let questions = [];
    if (mode === "meal") {
      items = await resolveMealItems(user.email, analysis, body?.conversation_id);
      questions = analysis.questions || [];
    } else if (mode === "label") {
      items = [labelAnalysisToItem(analysis)];
      questions = analysis.warnings || [];
    } else {
      const code = suppliedBarcode || normalizeBarcode(analysis?.barcode);
      if (code) {
        const lookup = await lookupBarcode(code);
        const item = barcodeFoodToItem(lookup.food, code);
        if (item) items = [item];
        else questions = [
          "That code was readable, but it was not in Open Food Facts or USDA. Photograph the Nutrition Facts label instead.",
        ];
      } else {
        questions = [
          analysis?.warning ||
            "Move closer and keep the entire barcode sharp, flat, and free of glare.",
        ];
      }
    }

    return sendJson(res, 200, {
      ok: true,
      mode,
      summary: responseSummary(mode, items, analysis || {}),
      items,
      questions,
      model: analyzed?.model || null,
      privacy:
        "BigBricey does not add the image to your account or ledger; it is sent to the selected AI provider for this analysis.",
    });
  } catch (error) {
    const status = [400, 413, 429].includes(Number(error?.status))
      ? Number(error.status)
      : 502;
    return sendJson(res, status, {
      error: error?.code || "vision_failed",
      message:
        status === 429
          ? error.message
          : status === 413
            ? "That photo is too large. Try again and BigBricey will shrink it before sending."
            : error.message || "I couldn't analyze that photo. Try again with better light.",
    });
  }
}
