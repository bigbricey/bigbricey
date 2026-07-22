import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { COACH_BEHAVIOR_RULES } from "../api/_coach_context.js";
import { DOMAIN_CONTRACT } from "../api/_llm.js";
import {
  abilitiesReplyText,
  capabilitiesForSystemPrompt,
} from "../api/_capabilities.js";

const WRAPPER_MODULE = "../api/_chat_wrapper.js";

async function loadWrapperModule() {
  return import(WRAPPER_MODULE);
}

test("every injected buddy-policy fragment allows ordinary questions while app tools stay scoped", () => {
  const conversationalPermission =
    /(?:answer|allow)[^\n]{0,80}(?:normal|ordinary|general|trivia)|(?:normal|ordinary|general|trivia)[^\n]{0,80}(?:answer|allow)/i;
  const conversationalRedirect =
    /(?:off[ -]?topic|trivia)[^\n]{0,100}(?:redirect|return|stay)[^\n]{0,60}(?:health|fitness|logging)/i;

  for (const policyFragment of [DOMAIN_CONTRACT, COACH_BEHAVIOR_RULES]) {
    assert.match(policyFragment, conversationalPermission);
    assert.doesNotMatch(policyFragment, conversationalRedirect);
  }

  assert.match(DOMAIN_CONTRACT, /use native app tools when reading or changing the app/i);
  assert.doesNotMatch(DOMAIN_CONTRACT, /use JSON actions/i);
  assert.match(DOMAIN_CONTRACT, /this product can't run that/i);
});

test("core buddy identity defines natural behavior instead of pretending to be human", () => {
  assert.match(DOMAIN_CONTRACT, /respond to the person/i);
  assert.match(DOMAIN_CONTRACT, /match (?:their|the user['’]?s) (?:energy|tone)/i);
  assert.match(DOMAIN_CONTRACT, /never (?:claim|pretend) (?:to be|you are) human/i);
  assert.match(DOMAIN_CONTRACT, /don['’]?t dump a feature menu/i);
});

test("capability copy scopes app actions without lobotomizing conversation", () => {
  const systemCopy = capabilitiesForSystemPrompt();
  const userCopy = abilitiesReplyText();

  assert.match(systemCopy, /(?:actions|tools)[^\n]{0,80}(?:limited|scoped)/i);
  assert.match(systemCopy, /conversation[^\n]{0,100}(?:ordinary|normal|general)/i);
  assert.doesNotMatch(userCopy, /not a general assistant/i);
});

test("chat reaches the model before any capability-question fallback", () => {
  const source = readFileSync(new URL("../api/chat.js", import.meta.url), "utf8");
  const modelTurn = source.indexOf("let intent = await interpretIntent");

  assert.ok(modelTurn > 0, "chat handler should call the model");
  assert.doesNotMatch(source.slice(0, modelTurn), /isAbilitiesQuestion\(text\)/);
  assert.doesNotMatch(source, /totals are exact/i);
  assert.match(source, /buildCurrentLogContext\(next\)/);
});

test("only real executor receipts can override the model reply", () => {
  const source = readFileSync(new URL("../api/chat.js", import.meta.url), "utf8");

  assert.doesNotMatch(source, /notes\.push\(action\.text\)/);
  assert.doesNotMatch(source, /if\s*\(!notes\.length\s*\|\|/);
  assert.match(
    source,
    /type === "add_food_phrase"[\s\S]{0,1000}else\s*\{[\s\S]{0,240}notes\.push\(/
  );
  assert.match(source, /unsupported action/i);
});

test("a verified empty food read answers directly without inventing totals", async () => {
  const { recordedDayReply } = await loadWrapperModule();
  assert.equal(
    recordedDayReply({
      day: "2026-07-22",
      food: [],
      totals: { kcal: 0, protein: 0 },
    }),
    "You haven’t logged any food today. Nothing changed."
  );
  assert.equal(
    recordedDayReply({ unavailable: ["food"] }),
    ""
  );
});

test("current log context preserves and totals fiber and key minerals", async () => {
  const { buildCurrentLogContext } = await loadWrapperModule();
  const context = buildCurrentLogContext([
    {
      id: "spinach",
      label: "Spinach",
      grams: 100,
      kcal: 23,
      protein: 3,
      fat: 0.4,
      carbs: 4,
      fiber: 2.2,
      potassium: 558,
      magnesium: 79,
      sodium: 79,
      calcium: 99,
      iron: 2.7,
    },
    {
      id: "avocado",
      label: "Avocado",
      grams: 50,
      kcal: 80,
      protein: 1,
      fat: 7.4,
      carbs: 4.3,
      fiber: 3.4,
      potassium: 243,
      magnesium: 15,
      sodium: 4,
      calcium: 6,
      iron: 0.3,
    },
  ]);

  assert.deepEqual(
    {
      fiber: context.items[0].fiber,
      potassium: context.items[0].potassium,
      magnesium: context.items[0].magnesium,
      sodium: context.items[0].sodium,
      calcium: context.items[0].calcium,
      iron: context.items[0].iron,
    },
    {
      fiber: 2.2,
      potassium: 558,
      magnesium: 79,
      sodium: 79,
      calcium: 99,
      iron: 2.7,
    }
  );
  assert.deepEqual(
    {
      fiber: context.totals.fiber,
      potassium: context.totals.potassium,
      magnesium: context.totals.magnesium,
      sodium: context.totals.sodium,
      calcium: context.totals.calcium,
      iron: context.totals.iron,
    },
    {
      fiber: 5.6,
      potassium: 801,
      magnesium: 94,
      sodium: 83,
      calcium: 105,
      iron: 3,
    }
  );
  assert.equal(context.data_quality.zero_may_mean_unreported, true);
});

test("null nutrients stay unknown and net carbs can be derived", async () => {
  const { buildCurrentLogContext } = await loadWrapperModule();
  const context = buildCurrentLogContext([
    {
      label: "Known carbs, unknown sodium",
      carbs: 20,
      fiber: 5,
      net_carbs: null,
      sodium: null,
    },
  ]);

  assert.equal(context.items[0].net_carbs, 15);
  assert.equal("sodium" in context.items[0], false);
  assert.equal("sodium" in context.totals, false);
  assert.deepEqual(context.coverage.sodium, {
    reported_items: 0,
    unreported_items: 1,
    all_rows_report_value: false,
  });
});

test("net carbs derive from nutrients stored in extras", async () => {
  const { buildCurrentLogContext } = await loadWrapperModule();
  const context = buildCurrentLogContext([
    {
      label: "Saved meal",
      extras: { carbs: 20, fiber: 5 },
    },
  ]);

  assert.equal(context.items[0].net_carbs, 15);
  assert.equal(context.totals.net_carbs, 15);
});

test("partial nutrient coverage is labeled as a known subtotal, not an exact total", async () => {
  const { buildCurrentLogContext } = await loadWrapperModule();
  const context = buildCurrentLogContext([
    { label: "Known sodium", sodium: 100 },
    { label: "Unknown sodium", sodium: null },
  ]);

  assert.equal("sodium" in context.totals, false);
  assert.equal(context.known_subtotals.sodium, 100);
  assert.deepEqual(context.coverage.sodium, {
    reported_items: 1,
    unreported_items: 1,
    all_rows_report_value: false,
  });
});

test("extra vitamins use the same exact-versus-partial coverage rule", async () => {
  const { buildCurrentLogContext } = await loadWrapperModule();
  const context = buildCurrentLogContext([
    { label: "Known D", nutrients: { vitamin_d: 10 } },
    { label: "Unknown D" },
  ]);

  assert.equal(context.extra_nutrient_totals?.vitamin_d, undefined);
  assert.equal(context.extra_nutrient_known_subtotals.vitamin_d, 10);
  assert.deepEqual(context.extra_nutrient_coverage.vitamin_d, {
    reported_items: 1,
    unreported_items: 1,
    all_rows_report_value: false,
  });
});

test("model history drops every trailing unanswered user turn", async () => {
  const { prepareModelHistory } = await loadWrapperModule();
  const prepared = prepareModelHistory([
    { role: "user", content: "Log two eggs." },
    { role: "assistant", content: "Added two eggs." },
    { role: "user", content: "Wait, I also meant to ask something." },
    { role: "user", content: "Never mind." },
  ]);

  assert.deepEqual(prepared, [
    { role: "user", content: "Log two eggs." },
    { role: "assistant", content: "Added two eggs." },
  ]);
});

test("a clear retry keeps only the last unanswered turn it refers to", async () => {
  const { prepareModelHistory } = await loadWrapperModule();
  const prepared = prepareModelHistory(
    [
      { role: "user", content: "Old failed request." },
      { role: "user", content: "Log two eggs." },
    ],
    { currentText: "Try that again." }
  );

  assert.deepEqual(prepared, [{ role: "user", content: "Log two eggs." }]);
});

test("common short retry phrases retain the failed turn", async () => {
  const { prepareModelHistory } = await loadWrapperModule();
  const history = [{ role: "user", content: "Log two eggs." }];

  for (const currentText of ["Try again.", "Do it.", "Go ahead.", "Same thing."]) {
    assert.deepEqual(prepareModelHistory(history, { currentText }), history);
  }
});

test("history capping never starts context with an orphan assistant reply", async () => {
  const { prepareModelHistory } = await loadWrapperModule();
  const history = [];
  for (let i = 0; i < 12; i++) {
    history.push({ role: "user", content: `Question ${i}` });
    history.push({ role: "assistant", content: `Answer ${i}` });
  }
  history.push({ role: "user", content: "Failed request" });

  const prepared = prepareModelHistory(history, {
    maxMessages: 24,
    currentText: "Try again.",
  });

  assert.equal(prepared[0]?.role, "user");
  assert.deepEqual(prepared.at(-1), { role: "user", content: "Failed request" });
});

test("history capping also enforces a total character budget", async () => {
  const { prepareModelHistory } = await loadWrapperModule();
  const history = Array.from({ length: 24 }, (_, index) => ({
    role: index % 2 ? "assistant" : "user",
    content: `${index}:` + "x".repeat(7_000),
  }));
  const prepared = prepareModelHistory(history, {
    maxMessages: 24,
    maxChars: 24_000,
  });

  assert.ok(
    prepared.reduce((sum, message) => sum + message.content.length, 0) <= 24_000
  );
  assert.ok(prepared.length < history.length);
  assert.equal(prepared[0]?.role, "user");
});

test("reply composition uses executor truth over a pre-action success claim", async () => {
  const { composeActionReply } = await loadWrapperModule();
  const reply = composeActionReply({
    modelReply: "Done — I logged Mystery Meal.",
    executionNotes: [
      "Couldn't find solid nutrition data for \u201cMystery Meal\u201d, so nothing was logged.",
    ],
  });

  assert.equal(
    reply,
    "Couldn't find solid nutrition data for \u201cMystery Meal\u201d, so nothing was logged."
  );
  assert.doesNotMatch(reply, /\b(?:done|logged mystery meal)\b/i);
});

test("validation and partial failures also override a blanket success claim", async () => {
  const { composeActionReply } = await loadWrapperModule();
  const validationNotes = [
    "Steps need a number.",
    "Metric needs a name and number.",
    "Add requested but no food specified.",
    "No custom box matched “water”.",
    "Try a preset: midnight, light, neon, forest, pink, terminal.",
  ];

  for (const note of validationNotes) {
    assert.equal(
      composeActionReply({ modelReply: "Done — all set.", executionNotes: [note] }),
      note
    );
  }

  assert.equal(
    composeActionReply({
      modelReply: "Done — I handled both.",
      executionNotes: ["Added: Eggs", "Steps need a number."],
    }),
    "Added: Eggs Steps need a number."
  );
});

test("reply composition keeps the model's conversational answer when no tool ran", async () => {
  const { composeActionReply } = await loadWrapperModule();
  const reply = composeActionReply({
    modelReply: "Rome is the capital of Italy; Paris is the capital of France.",
    executionNotes: [],
  });

  assert.equal(
    reply,
    "Rome is the capital of Italy; Paris is the capital of France."
  );
});
