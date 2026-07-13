/**
 * Unit tests for shipped coach context (real module — no reimplementation).
 * Run: node scripts/test-coach-context.mjs
 */
import {
  formatPersonBlock,
  eatingStyleGuidance,
  normalizeEatingStyle,
} from "../api/_coach_context.js";
import { DOMAIN_CONTRACT } from "../api/_llm.js";
import { knowledgeForSystemPrompt } from "../api/_knowledge.js";

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    failed++;
  } else {
    console.log("ok:", msg);
  }
}

// normalize
assert(normalizeEatingStyle("vegan") === "vegan", "normalize vegan");
assert(normalizeEatingStyle("CARNIVORE") === "carnivore", "normalize carnivore");
assert(normalizeEatingStyle("no_pref") === "no_pref", "normalize no_pref");
assert(normalizeEatingStyle("I like pizza") === "flexible" || normalizeEatingStyle("pizza") === "flexible" || normalizeEatingStyle("pizza") === "pizza", "pizza-ish maps");

// guidance content
const veganG = eatingStyleGuidance("vegan");
assert(/never suggest meat/i.test(veganG) || /no animal/i.test(veganG), "vegan guidance forbids animal recs");
assert(!/eat steak/i.test(veganG), "vegan guidance no steak");

const carnG = eatingStyleGuidance("carnivore");
assert(/carnivore|animal/i.test(carnG), "carnivore guidance present");
assert(!/push vegan/i.test(carnG) || /don't push vegan/i.test(carnG), "carnivore not pushing vegan");

const noneG = eatingStyleGuidance("no_pref");
assert(/no special|no diet|pizza|whatever/i.test(noneG), "no_pref is open");

// person blocks
const base = {
  complete: true,
  first_name: "Test",
  primary_goal: "lose",
  lose_rate_lb_week: 1,
  activity_level: "high",
  training_level: "most",
  sex: "male",
  height_in: 74,
  current_weight_lb: 220,
  goal_weight_lb: 200,
  birthday: "1980-01-01",
  obstacles: ["lack_of_time"],
  confidence: "somewhat",
  goals: { kcal: 2800, protein: 180, fat: 100, carbs: 50, tdee: 3200, age: 46 },
};

const veganBlock = formatPersonBlock({
  person: { ...base, eating_style: "vegan" },
  name: "Test",
});
assert(veganBlock.includes("vegan"), "vegan block has style id");
assert(/never recommend animal|never suggest meat|no animal/i.test(veganBlock), "vegan block no animal recs");
assert(/not medical advice|Not medical|not a prescription|not diagnosis/i.test(veganBlock), "medical disclaimer in block");
assert(/NEVER force vegan, carnivore/i.test(veganBlock) || /never force/i.test(veganBlock), "no force tribe");

const carnBlock = formatPersonBlock({
  person: { ...base, eating_style: "carnivore" },
  name: "Test",
});
assert(carnBlock.includes("carnivore"), "carnivore block style");
assert(/Don't push vegan|don't push vegan|Don't smuggle vegan/i.test(carnBlock), "carnivore no vegan push");

const openBlock = formatPersonBlock({
  person: { ...base, eating_style: "no_pref" },
  name: "Test",
});
assert(/no_pref|no special/i.test(openBlock), "open style");
assert(/2800/.test(openBlock), "includes kcal target from goals");

// domain contract coherence
assert(/BigBricey/.test(DOMAIN_CONTRACT), "contract brands BigBricey");
assert(/NEVER force|Never force|forcing any diet tribe/i.test(DOMAIN_CONTRACT), "contract no force tribe");
assert(/not medical advice/i.test(DOMAIN_CONTRACT), "contract not medical advice");
assert(/vegan/i.test(DOMAIN_CONTRACT) && /carnivore/i.test(DOMAIN_CONTRACT), "contract mentions both styles");
assert(!/always low.?carb for everyone/i.test(DOMAIN_CONTRACT), "no always-low-carb contradiction");

// incomplete onboarding
const inc = formatPersonBlock({ person: { complete: false }, email: "a@b.com" });
assert(/not finished/i.test(inc), "incomplete onboarding message");

// knowledge base
const kb = knowledgeForSystemPrompt();
assert(/not medical advice/i.test(kb), "kb not medical advice");
assert(/protein/i.test(kb) && /insulin|glucose/i.test(kb), "kb has protein/insulin facts");
assert(/vegan/i.test(kb) && /carnivore/i.test(kb), "kb covers both styles");

if (failed) {
  console.error(`\n${failed} failure(s)`);
  process.exit(1);
}
console.log("\nAll coach-context tests passed.");
