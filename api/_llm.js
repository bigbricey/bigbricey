/**
 * Provider-swappable LLM wrapper.
 * Swap models with env only — no chat/tool rewrites:
 *   LLM_PROVIDER=openrouter (default)
 *   OPENROUTER_API_KEY / OPENROUTER_MODEL
 * Future: LLM_PROVIDER=xai | anthropic | openai with matching keys.
 */

export function llmConfig() {
  const provider = (process.env.LLM_PROVIDER || "openrouter").toLowerCase();
  const model =
    process.env.OPENROUTER_MODEL ||
    process.env.LLM_MODEL ||
    "z-ai/glm-5.2";
  const apiKey =
    process.env.OPENROUTER_API_KEY ||
    process.env.LLM_API_KEY ||
    "";
  return {
    provider,
    model,
    apiKey,
    ok: Boolean(apiKey),
  };
}

/**
 * Chat completion — OpenRouter-compatible shape for now.
 * @param {{ messages: Array<{role:string,content:string}>, temperature?: number, title?: string }} opts
 * @returns {Promise<{ content: string, model: string, provider: string, raw: any }>}
 */
export async function llmChat({
  messages,
  temperature = 0,
  title = "BigBricey",
} = {}) {
  const cfg = llmConfig();
  if (!cfg.ok) {
    const err = new Error("llm_not_configured");
    err.code = "llm_not_configured";
    throw err;
  }

  if (cfg.provider === "openrouter" || cfg.provider === "or") {
    return openRouterChat({
      apiKey: cfg.apiKey,
      model: cfg.model,
      messages,
      temperature,
      title,
    });
  }

  // Fallback: treat unknown providers as OpenRouter-compatible gateway
  return openRouterChat({
    apiKey: cfg.apiKey,
    model: cfg.model,
    messages,
    temperature,
    title,
  });
}

async function openRouterChat({ apiKey, model, messages, temperature, title }) {
  const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": process.env.SITE_URL || "https://www.bigbricey.com",
      "X-Title": title,
    },
    body: JSON.stringify({
      model,
      temperature,
      messages,
    }),
  });
  const data = await r.json();
  if (!r.ok) {
    const err = new Error("llm_request_failed");
    err.status = r.status;
    err.detail = data;
    throw err;
  }
  const content = data.choices?.[0]?.message?.content || "";
  const u = data.usage || {};
  const prompt_tokens = Number(u.prompt_tokens ?? u.input_tokens ?? 0) || 0;
  const completion_tokens =
    Number(u.completion_tokens ?? u.output_tokens ?? 0) || 0;
  const total_tokens =
    Number(u.total_tokens ?? prompt_tokens + completion_tokens) ||
    prompt_tokens + completion_tokens;
  // OpenRouter sometimes includes cost in usage or native fields
  let cost_usd = null;
  if (u.cost != null && Number.isFinite(Number(u.cost))) cost_usd = Number(u.cost);
  else if (data.usage?.total_cost != null) cost_usd = Number(data.usage.total_cost);
  return {
    content,
    model: data.model || model,
    provider: "openrouter",
    usage: {
      prompt_tokens,
      completion_tokens,
      total_tokens,
      cost_usd,
    },
    raw: data,
  };
}

/** Domain contract injected into every coach system prompt. */
export const DOMAIN_CONTRACT = `PRODUCT IDENTITY — BigBricey is a LIVING FITNESS DATA LEDGER (personal forever health/food log).
You are NOT a general assistant, therapist, tax advisor, app builder, diet guru, or marriage counselor.

IN SCOPE:
- Log food (real nutrition lookup on server — NEVER invent macros)
- Log exercise, steps, body metrics, sleep, stress notes as DATA
- Totals, averages, watches/alerts, profile goals
- Factual baselines as reference (e.g. common potassium/magnesium targets; protein density; refined carbs vs protein/fat insulin response patterns) — always "not medical advice"
- Export / summary packs the user can paste into another AI or give a doctor
- Metabolic-health framing for facts (Bikman, D'Agostino, Volek, Phinney). No Ancel Keys fat-scare sermons.

OUT OF SCOPE (short friendly redirect, no lecture):
- Building apps/SaaS, trading, taxes, general trivia
- Relationship advice — you may LOG "stress: argument" only
- Medical diagnosis, prescriptions, or "you must eat X" as clinical orders
- Forcing any diet tribe (vegan / carnivore / keto / etc.)

DIET PREFERENCE:
- Honor the user's onboarding eating style exactly.
- Vegan user → never recommend animal products to eat.
- Carnivore/animal-based → don't push vegan meals.
- No preference / "I like pizza" → log what they ate; no conversion campaign.
- Facts about insulin, protein, minerals are OK for everyone when relevant — framed as general knowledge, not personal medical advice.

CALORIES: User-confirmed targets win. Never push crash diets as normal long-term plans.
FOOD QUALITY: Energy is not the only story (beef vs donuts) — density/protein/minerals matter; state facts without moralizing.
OFF-TOPIC EXAMPLE: "I'm your BigBricey fitness data ledger, not a tax accountant. Want to log food, training, or pull a stats report?"

NAMING: You are BigBricey. Never say you will "message Brice/Bryce" or forward things to a human by name. Product ideas go to the product backlog, not a person.`;
