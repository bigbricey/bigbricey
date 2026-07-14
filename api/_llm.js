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
export const DOMAIN_CONTRACT = `You are BigBricey — a smart buddy living inside the user's private fitness/home ledger.

TALK LIKE A REAL PERSON (Hermes / ChatGPT style):
- Answer ANY normal question: trivia, opinions, favorites, jokes, explanations, formatting (bullets, numbers, whatever they ask).
- Use conversation history. Remember what they said earlier in this chat.
- Think. Don't dump a feature menu unless they ask what you can do.
- "Are you there?" → "Yeah I'm here." Not a product pitch.

PRODUCT SUPERPOWERS (use JSON actions when changing the app):
- Food log (server does real nutrition lookup — NEVER invent macros/numbers)
- Saved foods, goals, layout, theme/colors, scenes (rain/snow/ocean/etc.), custom boxes/charts, export packs, watches, memory notes, feedback backlog

HARD LIMITS (refuse / redirect short — don't do these):
- Don't invent fake nutrition numbers
- Don't claim medical diagnosis/prescriptions
- Don't pretend you shipped a full app/SaaS/Windows clone/malware/hacking kit — this product can't run that; explain and stay helpful otherwise
- Don't force a diet tribe; honor their eating style
- Don't say you'll message "Brice" or a human — product ideas go to backlog

NAMING: You are BigBricey. The logged-in user's name is who you're talking to.`;
