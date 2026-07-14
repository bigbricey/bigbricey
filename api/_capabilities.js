/**
 * Single source of truth: what BigBricey can do.
 * Injected into the system prompt (short) + full text for "what can you do?".
 * Native entries map to tools; conversation and UI-only entries are labeled.
 */

export const CAPABILITY_CATALOG = [
  {
    id: "normal_chat",
    title: "Normal conversation",
    summary: "Talk naturally, ask normal questions, joke around, or ask for explanations.",
    examples: ["help me think this through", "tell me a joke"],
    kind: "conversation",
  },
  {
    id: "food_log",
    title: "Food log",
    summary: "Add, update, remove, or clear the selected day's food with real nutrition lookup.",
    examples: ["1 lb bacon", "remove eggs", "clear the day"],
    kind: "tool",
  },
  {
    id: "saved_foods",
    title: "Saved foods (up to 200)",
    summary: "Save reusable foods or recipes and log them by name.",
    examples: ["save my morning shake …", "log my shake"],
    kind: "tool",
  },
  {
    id: "goals",
    title: "Ongoing goals & eating style",
    summary: "Change ongoing calorie, macro, mineral, and eating-style targets.",
    examples: ["set low carb", "set my target to 2200 calories and 180g protein"],
    kind: "tool",
  },
  {
    id: "activity",
    title: "Workouts, steps, metrics",
    summary: "Log workouts, steps, weight, and numeric health or fitness metrics.",
    examples: ["50 push-ups", "30000 steps", "210 lb"],
    kind: "tool",
  },
  {
    id: "layout",
    title: "Today layout",
    summary: "Reorder supported Today panels and set full, half, or third widths.",
    examples: ["put chat at the bottom", "protein half width"],
    kind: "tool",
  },
  {
    id: "theme",
    title: "Colors, fonts, corners",
    summary: "Presets, ring colors, text size, square/round corners, density.",
    examples: ["eaten rings black", "bigger text", "pastel vibe", "square corners"],
    kind: "tool",
  },
  {
    id: "scenes",
    title: "Scenes & ambient effects",
    summary:
      "Named visual worlds: rain, snow, desert dust, ocean, matrix, stars, confetti, fireflies, aurora, none. Not freeform 3D engines.",
    examples: ["make it rain", "desert dust", "matrix rain", "clear effects"],
    kind: "tool",
  },
  {
    id: "memory",
    title: "Permanent notes",
    summary: "Remember short preferences or facts across chats when the user asks.",
    examples: ["remember I prefer black eaten rings"],
    kind: "tool",
  },
  {
    id: "chat_history",
    title: "Chat history",
    summary: "Open earlier conversations or start a new one with the History/New UI controls.",
    examples: ["use History or New"],
    kind: "ui",
  },
];

/** Compact block for every system prompt */
export function capabilitiesForSystemPrompt() {
  const conversation = CAPABILITY_CATALOG.find(
    (capability) => capability.kind === "conversation"
  );
  const toolLines = CAPABILITY_CATALOG.filter(
    (capability) => capability.kind === "tool"
  ).map((c) => `- ${c.id}: ${c.title} — ${c.summary}`);
  return `CONVERSATION: ${conversation?.summary || "Talk naturally and answer normal questions."}
APP ACTIONS ARE LIMITED to these native tools (this scopes actions, not conversation):\n${toolLines.join("\n")}
SCENES you may set: none, rain, snow, desert, ocean, matrix, stars, confetti, fireflies, aurora, mist, neon_city.
UI-ONLY: Chat history is managed with the History/New controls; do not claim a tool changed conversations.
If user asks "what can you do / abilities", reply with the full friendly list — empty actions.
Conversation remains broad: answer ordinary questions, jokes, explanations, and casual chat naturally.
You do NOT invent freeform website code. You pick named themes/scenes/actions we already support.`;
}

/** Full user-facing abilities text */
export function abilitiesReplyText() {
  const body = CAPABILITY_CATALOG.map((c) => {
    const ex = (c.examples || []).map((e) => `   e.g. “${e}”`).join("\n");
    return `• ${c.title}\n  ${c.summary}\n${ex}`;
  }).join("\n\n");

  return `I'm your private BigBricey fitness buddy and ledger. We can talk normally, and these are the things I can do here:

Here's what you can do here:

${body}

Chat history is controlled with the History/New buttons in the app; it is not a chat command.

I cannot (yet): upload photos as live wallpaper, invent unlimited freeform 3D games, browse the open web, or diagnose medical conditions.

Try: “make it rain”, “eaten rings pink”, “log 1 lb bacon”, or “remember that I prefer short answers”.`;
}

export const SCENE_IDS = [
  "none",
  "rain",
  "snow",
  "desert",
  "ocean",
  "matrix",
  "stars",
  "confetti",
  "fireflies",
  "aurora",
  "mist",
  "neon_city",
];
