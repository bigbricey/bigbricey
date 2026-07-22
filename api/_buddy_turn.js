import { llmChat } from "./_llm.js";
import { safeAssistantReply } from "./_native_tool_loop.js";

const EXPLICIT_FOOD_AMOUNT =
  /\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|half|quarter|three[- ]quarters?|\d+(?:\.\d+)?|\d+\/\d+)\b|\b(?:grams?|g|ounces?|oz|pounds?|lbs?|lb|kilograms?|kg|cups?|tbsp|tsp|scoops?|servings?|pieces?)\b/i;

/**
 * Keep a vague food report to one useful question. The LLM still receives and
 * answers the turn first; this only removes extra interrogation when quantity
 * is the one fact the ledger genuinely needs.
 */
export function minimalFoodQuantityReply({
  userText = "",
  routeMode = "conversation",
  toolCallCount = 0,
  reply = "",
} = {}) {
  if (
    !["write_explicit", "write_ambiguous"].includes(routeMode) ||
    Number(toolCallCount) > 0
  ) {
    return reply;
  }
  const text = String(userText || "").trim();
  if (
    !text ||
    text.includes("?") ||
    /\b(?:tomorrow|later|next week|planning|plan to|thinking of|might|maybe)\b/i.test(
      text
    )
  ) {
    return reply;
  }
  const present = text.match(/^\s*i(?:['’]?m| am)\s+(?:having|eating)\s+(.+?)\s*[.!]*\s*$/i);
  const past = text.match(/^\s*i\s+(?:had|ate)\s+(.+?)\s*[.!]*\s*$/i);
  const match = present || past;
  if (!match || EXPLICIT_FOOD_AMOUNT.test(match[1])) return reply;
  const food = String(match[1] || "")
    .replace(/^\s*(?:some|a|an)\s+/i, "")
    .replace(/[.!]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  if (!food) return reply;
  return past
    ? `About how much ${food} did you have?`
    : `About how much ${food} are you having?`;
}

export async function callBuddyFirstPass({
  llm = llmChat,
  systemPrompt,
  history = [],
  userText,
  tools = [],
} = {}) {
  const activeTools = Array.isArray(tools) ? tools : [];
  const baseMessages = [
    { role: "system", content: String(systemPrompt || "") },
    ...(Array.isArray(history) ? history : []),
    { role: "user", content: String(userText || "") },
  ];
  const output = await llm({
    temperature: 0.6,
    title: "BigBricey-Chat",
    messages: baseMessages,
    tools: activeTools,
    toolChoice: activeTools.length ? "auto" : "none",
    parallelToolCalls: false,
    maxTokens: 900,
  });

  return {
    baseMessages,
    reply: safeAssistantReply(output?.content),
    toolCalls: Array.isArray(output?.toolCalls) ? output.toolCalls : [],
    output,
  };
}

export async function callBuddyAfterTools({
  llm = llmChat,
  baseMessages = [],
  assistantMessage,
  toolResultMessages = [],
  tools = [],
  fallbackReply = "",
  allowToolCalls = false,
} = {}) {
  const messages = [
    ...(Array.isArray(baseMessages) ? baseMessages : []),
    assistantMessage,
    ...(Array.isArray(toolResultMessages) ? toolResultMessages : []),
  ].filter(Boolean);
  const output = await llm({
    temperature: 0.6,
    title: "BigBricey-Chat-After-Tools",
    messages,
    tools,
    toolChoice: allowToolCalls ? "auto" : "none",
    parallelToolCalls: false,
    maxTokens: 700,
  });

  return {
    reply: safeAssistantReply(output?.content, fallbackReply),
    toolCalls:
      allowToolCalls && Array.isArray(output?.toolCalls)
        ? output.toolCalls
        : [],
    output,
  };
}
