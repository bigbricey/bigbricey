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
 * @param {{ messages: Array<object>, temperature?: number, title?: string,
 * tools?: Array<object>, toolChoice?: string|object, parallelToolCalls?: boolean,
 * maxTokens?: number, responseFormat?: object, reasoning?: object }} opts
 * @returns {Promise<{ content: string, message: object, toolCalls: Array<object>, model: string, provider: string, raw: any }>}
 */
export async function llmChat({
  messages,
  temperature = 0,
  title = "BigBricey",
  tools,
  toolChoice,
  parallelToolCalls,
  maxTokens,
  responseFormat,
  reasoning,
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
      tools,
      toolChoice,
      parallelToolCalls,
      maxTokens,
      responseFormat,
      reasoning,
    });
  }

  // Fallback: treat unknown providers as OpenRouter-compatible gateway
  return openRouterChat({
    apiKey: cfg.apiKey,
    model: cfg.model,
    messages,
    temperature,
    title,
    tools,
    toolChoice,
    parallelToolCalls,
    maxTokens,
    responseFormat,
    reasoning,
  });
}

async function openRouterChat({
  apiKey,
  model,
  messages,
  temperature,
  title,
  tools,
  toolChoice,
  parallelToolCalls,
  maxTokens,
  responseFormat,
  reasoning,
}) {
  const body = {
    model,
    temperature,
    messages,
  };
  if (Array.isArray(tools) && tools.length) body.tools = tools;
  if (toolChoice != null) body.tool_choice = toolChoice;
  if (parallelToolCalls != null) {
    body.parallel_tool_calls = Boolean(parallelToolCalls);
  }
  if (Number.isFinite(Number(maxTokens)) && Number(maxTokens) > 0) {
    body.max_tokens = Math.floor(Number(maxTokens));
  }
  if (responseFormat && typeof responseFormat === "object") {
    body.response_format = responseFormat;
  }
  if (reasoning && typeof reasoning === "object") body.reasoning = reasoning;

  const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": process.env.SITE_URL || "https://www.bigbricey.com",
      "X-Title": title,
    },
    body: JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok) {
    const err = new Error("llm_request_failed");
    err.status = r.status;
    err.detail = data;
    throw err;
  }
  const providerMessage = data.choices?.[0]?.message || {};
  const toolCalls = Array.isArray(providerMessage.tool_calls)
    ? providerMessage.tool_calls
    : [];
  const content =
    typeof providerMessage.content === "string" ? providerMessage.content : "";
  const message = {
    ...providerMessage,
    role: providerMessage.role || "assistant",
    content: providerMessage.content ?? null,
  };
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
    message,
    toolCalls,
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
export const DOMAIN_CONTRACT = `You are BigBricey — the user's AI fitness companion living inside their private home and health ledger.

CONVERSATION:
- Respond to the person before reaching for a tool. Acknowledge what they actually said.
- Answer ANY normal question: trivia, opinions, favorites, jokes, explanations, formatting (bullets, numbers, whatever they ask).
- Match their energy, tone, and preferred response length. Be warm and direct without fake hype, lectures, or canned encouragement.
- Use conversation history for continuity, but answer the user's current message instead of reviving an older unanswered request.
- Think. Don't dump a feature menu unless they ask what you can do.
- You are an AI companion. Never claim to be human.
- "Are you there?" → "Yeah, I'm here." Not a product pitch.

PRODUCT SUPERPOWERS (use native app tools when reading or changing the app):
- Natural conversation and normal questions without requiring a tool
- Food log and reusable saved foods (server does real nutrition lookup — NEVER invent macros/numbers)
- Ongoing calorie, macro, mineral, and eating-style goals
- Workouts, steps, and numeric health or fitness metrics
- Home theme/colors, ambient scenes, and the layout of supported Today panels
- Permanent memory notes when the user explicitly asks to remember or forget something
- Chat history is available through the History/New controls in the UI; it is not an app-action tool

HARD LIMITS (refuse / redirect short — don't do these):
- Don't invent fake nutrition numbers
- Don't claim medical diagnosis/prescriptions
- Don't pretend you shipped a full app/SaaS/Windows clone/malware/hacking kit — this product can't run that; explain and stay helpful otherwise
- Don't force a diet tribe; honor their eating style
- Don't say you'll message "Brice" or another human

NAMING: You are BigBricey. The logged-in user's name is who you're talking to.`;
