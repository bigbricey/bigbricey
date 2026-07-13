/**
 * Pure coach context builders — testable without OpenRouter.
 * Used by chat.js; diet style fragments keep the model non-prescriptive.
 */

/** Short knowledge addenda by onboarding eating_style. Never force a tribe. */
export const EATING_STYLE_GUIDANCE = {
  no_pref: `EATING STYLE: no special diet label. Log whatever they eat. Don't push vegan, carnivore, keto, or any tribe. If they say "I like pizza," log pizza and note macros/minerals factually.`,
  flexible: `EATING STYLE: flexible / mixed. Meat and plants both fine. Match their plate; don't moralize.`,
  low_carb: `EATING STYLE: they prefer lower carb. Prefer lower-carb food suggestions only if they ask for ideas; still log any food they ate without shame. Facts OK: refined carbs can spike insulin more than equal protein/fat for many people — not medical advice.`,
  higher_protein: `EATING STYLE: high-protein focus (often animal foods, eggs, dairy). Support protein-forward logging. Don't ban plants if they eat them. Facts OK: protein helps satiety and muscle retention — not a prescription.`,
  plant_forward: `EATING STYLE: plant-forward (not necessarily strict vegan). Prefer plant options when they ask; still log meat if they eat it. Facts OK: watch protein completeness, B12/iron/zinc if diet is very plant-heavy — as general nutrition facts, not diagnosis.`,
  vegan: `EATING STYLE: vegan — no animal products. Never suggest meat, fish, eggs, or dairy as foods to eat. Log vegan items accurately. Facts OK: protein from legumes/soy/seitan, B12 usually needs fortified foods/supplements, iron absorption, etc. — facts only, not medical orders. Don't smuggle carnivore framing.`,
  carnivore: `EATING STYLE: carnivore / animal-based preference. Don't push grains, seed oils lectures as moralizing; don't force vegan options. Log animal foods accurately. Facts OK: organ meats are nutrient-dense; fiber is low on pure carnivore — state as data, not "you must change." Don't smuggle vegan framing.`,
  other: `EATING STYLE: they will describe later in chat. Ask once if unclear; don't assign a tribe.`,
  pizza: `EATING STYLE: plain-language preference (e.g. likes pizza). Log what they eat. No diet lecture. Facts about refined flour/sugar vs protein density only if relevant to their question.`,
};

/**
 * Map free-text or id to a guidance key.
 * @param {string|null|undefined} style
 */
export function normalizeEatingStyle(style) {
  const raw = String(style || "no_pref").toLowerCase().trim();
  const s = raw.replace(/\s+/g, "_");
  if (!s || s === "none" || s === "no_preference") return "no_pref";
  if (EATING_STYLE_GUIDANCE[s]) return s;
  // plain language on original string (spaces ok)
  if (/vegan|plant.?only|no animal/.test(raw)) return "vegan";
  if (/carnivore|animal.?based|meat.?only/.test(raw)) return "carnivore";
  if (/keto|low.?carb|lchf/.test(raw)) return "low_carb";
  if (/high.?protein|protein.?first/.test(raw)) return "higher_protein";
  if (/plant.?forward|vegetarian|flexitarian/.test(raw)) return "plant_forward";
  if (/pizza|whatever|normal|omnivore|mixed|no special/.test(raw)) return "flexible";
  return "no_pref";
}

/**
 * @param {string|null|undefined} style
 * @returns {string}
 */
export function eatingStyleGuidance(style) {
  const key = normalizeEatingStyle(style);
  return EATING_STYLE_GUIDANCE[key] || EATING_STYLE_GUIDANCE.no_pref;
}

/** Shared non-prescriptive rules (must not contradict DOMAIN_CONTRACT). */
export const COACH_BEHAVIOR_RULES = `COACH BEHAVIOR (non-negotiable):
- User picks their food pattern. NEVER force vegan, carnivore, keto, or any diet.
- If they have no label ("I just like pizza"), treat as no_pref / flexible — log and move on.
- You may state general nutrition FACTS (protein, minerals, refined carbs vs whole food insulin response patterns) with "not medical advice / discuss with a professional for personal decisions."
- No diagnosis, no "you must eat X," no crash diets as long-term plans.
- Log stress notes as data; no relationship counseling.
- Metabolic-health lens (Bikman, D'Agostino, Volek, Phinney) for food quality facts — never Ancel Keys fat-scare sermons.
- Off-topic (taxes, SaaS, trivia): short friendly redirect to health logging.`;

/**
 * Build the "who you're coaching" system block from onboarding person prefs.
 * @param {{ person?: object, name?: string, email?: string }} ctx
 * @returns {string}
 */
export function formatPersonBlock(ctx = {}) {
  const p = ctx.person;
  if (!p?.complete) {
    return `Person: ${ctx.name || ctx.email || "member"} — onboarding not finished yet. Keep replies general until they complete profile.\n\n${COACH_BEHAVIOR_RULES}`;
  }
  const goalMap = {
    lose: "lose weight (fat loss)",
    maintain: "maintain weight",
    muscle: "build muscle (lean — not dirty bulk)",
    gain: "build muscle (legacy; treat as lean muscle, never fat gain)",
  };
  const confMap = {
    very: "very confident they'll stick with it",
    somewhat: "somewhat confident",
    not_very: "not very confident",
    not_sure: "not sure about sticking with the plan",
  };
  const obstacleMap = {
    lack_of_time: "lack of time",
    lack_of_motivation: "lack of motivation",
    not_sure_what_to_eat: "not sure what to eat",
    hard_to_stay_consistent: "hard to stay consistent",
    social_pressure: "social pressure",
    cravings: "cravings / emotional eating",
  };
  const obstacles = (p.obstacles || [])
    .map((o) => obstacleMap[o] || o)
    .join("; ");
  const heightFt =
    p.height_in != null
      ? `${Math.floor(p.height_in / 12)}'${Math.round(p.height_in % 12)}"`
      : "?";
  const goals = p.goals || {};
  const styleKey = normalizeEatingStyle(p.eating_style);
  const styleBlock = eatingStyleGuidance(p.eating_style);

  return `WHO YOU'RE COACHING (from onboarding — use this, don't re-ask):
- Name: ${p.first_name || ctx.name || "friend"}
- Primary goal: ${goalMap[p.primary_goal] || p.primary_goal || "unspecified"}
${
  p.primary_goal === "lose" && p.lose_rate_lb_week
    ? `- Target loss rate: ${p.lose_rate_lb_week} lb per week`
    : ""
}
- Day activity: ${p.activity_level || "?"} · Training: ${p.training_level || "?"}
- Eating style id: ${styleKey}
- Obstacles: ${obstacles || "none listed"}
- Confidence: ${confMap[p.confidence] || p.confidence || "unknown"}
- Birthday: ${p.birthday || "?"} (age ~${goals.age ?? "?"})
- Sex: ${p.sex || "?"} (biological — for energy math)
- Height: ${heightFt}
- Current weight: ${p.current_weight_lb ?? "?"} lb
- Goal weight: ${p.goal_weight_lb ?? "?"} lb
- Daily targets (user-confirmed energy): ${goals.kcal || "?"} kcal · protein ${goals.protein || "?"}g · fat ${goals.fat || "?"}g · carbs ${goals.carbs || "?"}g
- Est. TDEE from onboarding: ${goals.tdee || "?"} · formula before floor: ${goals.formula_kcal || "?"}

${styleBlock}

${COACH_BEHAVIOR_RULES}`;
}


