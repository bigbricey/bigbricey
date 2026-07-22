import { llmChat } from "./_llm.js";
import {
  BIGBRICEY_TOOL_NAMES,
  getToolPolicy,
} from "./_tool_contracts.js";

export const BUDDY_TURN_MODES = Object.freeze([
  "conversation",
  "read",
  "write_explicit",
  "write_ambiguous",
]);

const SAFE_READ_TOOL_NAMES = Object.freeze([
  "inspect_app",
  "read_today",
  "lookup_food",
  "list_saved_foods",
]);

const ROUTE_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    mode: {
      type: "string",
      enum: BUDDY_TURN_MODES,
      description: "The current user's app-action intent.",
    },
    tool_names: {
      type: "array",
      items: { type: "string", enum: BIGBRICEY_TOOL_NAMES },
      maxItems: 6,
      uniqueItems: true,
      description: "The smallest exact tool set needed for this turn.",
    },
    evidence: {
      type: "string",
      maxLength: 300,
      description: "One short reason grounded in the current request and recent context.",
    },
  },
  required: ["mode", "tool_names", "evidence"],
  additionalProperties: false,
});

const ROUTER_SYSTEM_PROMPT = `You route one message inside BigBricey, a private AI nutrition and fitness companion.

Classify the CURRENT user message. Recent messages exist only to resolve references such as “that” or “my usual.”

MODES:
- conversation: normal talk or a question that needs no private app data, verified nutrition database data, or app change.
- read: the user asks about private app state or asks for verified food calories, macros, nutrients, weight, or portion calculations. Questions, comparisons, hypotheticals, and “what would this add up to?” are reads, never permission to log.
- write_explicit: the current message clearly asks to record, add, log, save, update, remove, delete, clear, remember, customize, or otherwise change the app. “I ate 3 eggs” can mean log them in this dedicated tracker unless it is plainly a story, hypothetical, or question. “Put that in my diary” is explicit when recent context identifies the food.
- write_ambiguous: a change may be implied, but the user did not clearly authorize one or the referent is missing. Fail safe; no mutation tool.

TOOL RULES:
- Choose the smallest exact set. Never include a mutation tool for conversation, read, or write_ambiguous.
- lookup_food is read-only. Use it for verified nutrition or food-portion questions. It never logs.
- add_food is write-only. Use it only for a clear request to put food in the diary.
- A messy sentence about the average size or nutrition of one sweet potato, even if it mentions what it would “add” to macros, is lookup_food/read unless the user directly says to log it.
- “Log 3/4 lb sweet potato” is write_explicit/add_food.
- “Back off on reminders,” “be more direct,” or a nickname request is write_explicit/set_companion_settings.
- For a vague named saved meal that the user explicitly wants logged, start with list_saved_foods so the exact private item can be verified.
- Do not choose tools merely because they exist. Return an empty tool list for ordinary conversation.

Return only the required JSON object.`;

function boundedRouteHistory(history = []) {
  const selected = [];
  let characters = 0;
  for (const message of (Array.isArray(history) ? history : [])
    .slice(-6)
    .reverse()) {
    if (!["user", "assistant"].includes(message?.role)) continue;
    const content = String(message?.content || "")
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, " ")
      .trim()
      .slice(0, 1_500);
    if (!content) continue;
    if (characters + content.length > 6_000) break;
    characters += content.length;
    selected.push({ role: message.role, content });
  }
  return selected.reverse();
}

function safeReadFallback(output = null) {
  return {
    mode: "write_ambiguous",
    toolNames: [...SAFE_READ_TOOL_NAMES],
    evidence: "The intent router did not return one valid, safely bounded decision.",
    valid: false,
    output,
  };
}

function normalizeRoute(value, output) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return safeReadFallback(output);
  }
  const keys = Object.keys(value).sort();
  if (
    keys.length !== 3 ||
    !keys.includes("mode") ||
    !keys.includes("tool_names") ||
    !keys.includes("evidence") ||
    !BUDDY_TURN_MODES.includes(value.mode) ||
    !Array.isArray(value.tool_names) ||
    value.tool_names.length > 6 ||
    typeof value.evidence !== "string" ||
    !value.evidence.trim() ||
    value.evidence.length > 300
  ) {
    return safeReadFallback(output);
  }

  const known = new Set(BIGBRICEY_TOOL_NAMES);
  const toolNames = [...new Set(value.tool_names)]
    .filter((name) => typeof name === "string" && known.has(name))
    .filter((name) => {
      if (value.mode === "write_explicit") return true;
      return getToolPolicy(name)?.mutates === false;
    });

  return {
    mode: value.mode,
    toolNames: value.mode === "conversation" ? [] : toolNames,
    evidence: value.evidence.trim(),
    valid: true,
    output,
  };
}

/** One small semantic routing pass. Invalid output fails closed to reads only. */
export async function classifyBuddyTurn({
  llm = llmChat,
  userText = "",
  history = [],
} = {}) {
  let output = null;
  try {
    output = await llm({
      temperature: 0,
      title: "BigBricey-Route",
      messages: [
        { role: "system", content: ROUTER_SYSTEM_PROMPT },
        ...boundedRouteHistory(history),
        { role: "user", content: String(userText || "") },
      ],
      tools: [],
      toolChoice: "none",
      parallelToolCalls: false,
      responseFormat: {
        type: "json_schema",
        json_schema: {
          name: "bigbricey_turn_route",
          strict: true,
          schema: ROUTE_SCHEMA,
        },
      },
      maxTokens: 180,
    });
    return normalizeRoute(JSON.parse(String(output?.content || "")), output);
  } catch {
    return safeReadFallback(output);
  }
}

/** Enforce the route again at the server boundary; provider exposure is not authorization. */
export function toolsForBuddyTurn({ route = {}, tools = [] } = {}) {
  if (route?.mode === "conversation") return [];
  const requested = new Set(
    Array.isArray(route?.toolNames) ? route.toolNames : []
  );
  return (Array.isArray(tools) ? tools : []).filter((tool) => {
    const name = tool?.function?.name;
    if (!requested.has(name)) return false;
    if (route?.mode === "write_explicit") return true;
    return getToolPolicy(name)?.mutates === false;
  });
}

/**
 * A read may help answer a question, but it may never become permission for a
 * later write. Keep that authorization attached to the original user turn.
 */
export function authorizeBuddyContinuationPlan({
  writeAuthorized = false,
  plan = null,
} = {}) {
  if (writeAuthorized === true) return plan;
  return {
    kind: null,
    allowedToolNames: [],
    allowedSavedFoodIds: [],
    allowedTrackerIds: [],
    sourceData: null,
    blockedReason: null,
  };
}
