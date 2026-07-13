/**
 * Single source of truth: what BigBricey can do.
 * Injected into the system prompt (short) + full text for "what can you do?".
 * Implementation stays in code; the model only picks named actions.
 */

export const CAPABILITY_CATALOG = [
  {
    id: "food_log",
    title: "Food log",
    summary: "Add/update/remove/clear today's food with real nutrition lookup.",
    examples: ["1 lb bacon", "remove eggs", "clear the day"],
  },
  {
    id: "saved_foods",
    title: "Saved foods (up to 200)",
    summary: "Remember shakes/recipes and log by name.",
    examples: ["save my morning shake …", "log my shake"],
  },
  {
    id: "goals",
    title: "Daily goals & diet style",
    summary: "Change kcal/macros/net carbs/eating style any day.",
    examples: ["low carb today", "2200 calories 180 protein"],
  },
  {
    id: "activity",
    title: "Workouts, steps, metrics",
    summary: "Log exercise, steps, weight, custom measures.",
    examples: ["50 push-ups", "30000 steps", "210 lb"],
  },
  {
    id: "layout",
    title: "Move & resize boxes",
    summary: "Reorder Today panels; full/half/third sizes; drag ⠿ in UI.",
    examples: ["put chat at the bottom", "protein half width"],
  },
  {
    id: "theme",
    title: "Colors, fonts, corners",
    summary: "Presets, ring colors, text size, square/round corners, density.",
    examples: ["eaten rings black", "bigger text", "pastel vibe", "square corners"],
  },
  {
    id: "scenes",
    title: "Scenes & ambient effects",
    summary:
      "Named visual worlds: rain, snow, desert dust, ocean, matrix, stars, confetti, fireflies, aurora, none. Not freeform 3D engines.",
    examples: ["make it rain", "desert dust", "matrix rain", "clear effects"],
  },
  {
    id: "custom_boxes",
    title: "Custom trackers",
    summary: "Add goal boxes (water, push-ups) with rings.",
    examples: ["add water box goal 100 oz"],
  },
  {
    id: "charts",
    title: "Chart boxes",
    summary: "Line/bar/pie charts from history for any measure/range.",
    examples: ["graph magnesium 6 months", "pie macros this week"],
  },
  {
    id: "export",
    title: "Export packs",
    summary: "Data pack for doctor or another AI.",
    examples: ["export 30 days for my doctor"],
  },
  {
    id: "memory",
    title: "Permanent notes",
    summary: "Short facts across all chats when user asks to remember.",
    examples: ["remember I prefer black eaten rings"],
  },
  {
    id: "chat_history",
    title: "Chat history",
    summary: "Multi-conversation threads; History/New in UI; long context + compact.",
    examples: ["(use History / New buttons)"],
  },
  {
    id: "feedback",
    title: "Product suggestions",
    summary: "App ideas go to owner backlog (clustered). Not auto-built.",
    examples: ["I wish the app had …"],
  },
];

/** Compact block for every system prompt */
export function capabilitiesForSystemPrompt() {
  const lines = CAPABILITY_CATALOG.map(
    (c) => `- ${c.id}: ${c.title} — ${c.summary}`
  );
  return `CAPABILITIES (you CAN do these via JSON actions / UI; stay in this list):\n${lines.join("\n")}
SCENES you may set: none, rain, snow, desert, ocean, matrix, stars, confetti, fireflies, aurora, mist, neon_city.
If user asks "what can you do / abilities", reply with the full friendly list — empty actions.
You do NOT invent freeform website code. You pick named themes/scenes/actions we already support.`;
}

/** Full user-facing abilities text */
export function abilitiesReplyText() {
  const body = CAPABILITY_CATALOG.map((c) => {
    const ex = (c.examples || []).map((e) => `   e.g. “${e}”`).join("\n");
    return `• ${c.title}\n  ${c.summary}\n${ex}`;
  }).join("\n\n");

  return `I'm your private BigBricey fitness data ledger — not a general assistant. Your data stays on your account.

Here's what you can do here:

${body}

I cannot (yet): upload photos as live wallpaper, invent unlimited freeform 3D games, browse the open web, or diagnose medical conditions.

Try: “make it rain”, “desert dust”, “eaten rings pink”, “add water box 100oz”, “chart protein 30 days”.`;
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
