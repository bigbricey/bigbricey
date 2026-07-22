import assert from "node:assert/strict";
import test from "node:test";

import {
  authorizeBuddyContinuationPlan,
  classifyBuddyTurn,
  requiredAppInspection,
  toolsForBuddyTurn,
} from "../api/_buddy_tool_routing.js";
import { BIGBRICEY_TOOLS } from "../api/_tool_contracts.js";

const MESSY_SWEET_POTATO_QUESTION =
  "So if I have one, so like what's the add like on my thing, one sweet potato? I wanna see all the stuff that's in that one, like say, what is the average size of a sweet potato? cause I know it can vary a lot, but I guess one potato must be around what like 3/4 of a pound or something";

function classifierReturning(value, calls = []) {
  return async (options) => {
    calls.push(options);
    return {
      content: JSON.stringify(value),
      toolCalls: [],
      usage: { total_tokens: 1 },
    };
  };
}

function selectedToolNames(route) {
  return toolsForBuddyTurn({ route, tools: BIGBRICEY_TOOLS }).map(
    (tool) => tool.function.name
  );
}

test("Brice's exact sweet-potato question is a non-mutating nutrition read", async () => {
  const calls = [];
  const route = await classifyBuddyTurn({
    llm: classifierReturning(
      {
        mode: "read",
        tool_names: ["lookup_food", "add_food"],
        evidence: "He asks what one sweet potato contains; he never asks to log it.",
      },
      calls
    ),
    userText: MESSY_SWEET_POTATO_QUESTION,
    history: [],
  });

  assert.equal(route.mode, "read");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].temperature, 0);
  assert.equal(calls[0].toolChoice, "none");
  assert.equal(calls[0].responseFormat.type, "json_schema");
  assert.equal(calls[0].responseFormat.json_schema.strict, true);
  assert.deepEqual(
    calls[0].responseFormat.json_schema.schema.properties.mode.enum,
    ["conversation", "read", "write_explicit", "write_ambiguous"]
  );
  assert.equal(
    calls[0].messages.at(-1).content,
    MESSY_SWEET_POTATO_QUESTION
  );

  const names = selectedToolNames(route);
  assert.deepEqual(names, ["lookup_food"]);
  assert.equal(names.includes("add_food"), false);
});

test("an explicit request to log 3/4 lb of sweet potato permits add_food", async () => {
  const route = await classifyBuddyTurn({
    llm: classifierReturning({
      mode: "write_explicit",
      tool_names: ["add_food"],
      evidence: "The user directly says to log a specific food and amount.",
    }),
    userText: "Log 3/4 lb sweet potato.",
    history: [],
  });

  assert.equal(route.mode, "write_explicit");
  assert.deepEqual(selectedToolNames(route), ["add_food"]);
});

test("put that in my diary is an explicit mutation when prior food context supplies the referent", async () => {
  const calls = [];
  const history = [
    {
      role: "user",
      content: "What would 3/4 lb of baked sweet potato come to?",
    },
    {
      role: "assistant",
      content:
        "Three-quarters of a pound is about 340 grams of baked sweet potato.",
    },
  ];
  const route = await classifyBuddyTurn({
    llm: classifierReturning(
      {
        mode: "write_explicit",
        tool_names: ["add_food"],
        evidence:
          "That refers to the sweet potato in history, and putting it in the diary is a direct logging request.",
      },
      calls
    ),
    userText: "Put that in my diary.",
    history,
  });

  assert.equal(route.mode, "write_explicit");
  assert.deepEqual(selectedToolNames(route), ["add_food"]);
  assert.deepEqual(calls[0].messages.slice(-3), [
    ...history,
    { role: "user", content: "Put that in my diary." },
  ]);
});

test("an ambiguous nutrition question cannot expose or use a write tool", async () => {
  const route = await classifyBuddyTurn({
    llm: classifierReturning({
      mode: "write_ambiguous",
      tool_names: ["lookup_food", "add_food"],
      evidence:
        "The user asks what it would add up to, which is not permission to change the diary.",
    }),
    userText:
      "What would one medium sweet potato add up to for calories and macros?",
    history: [],
  });

  assert.equal(route.mode, "write_ambiguous");
  const names = selectedToolNames(route);
  assert.deepEqual(names, ["lookup_food"]);
  assert.equal(names.includes("add_food"), false);
});

test("invalid classifier output fails closed to read-only tools", async () => {
  const route = await classifyBuddyTurn({
    llm: async () => ({ content: "I think maybe log it", toolCalls: [] }),
    userText: "Could you do that with the potato?",
    history: [],
  });

  assert.equal(route.mode, "write_ambiguous");
  const names = selectedToolNames(route);
  assert.equal(names.includes("lookup_food"), true);
  assert.equal(names.includes("add_food"), false);
  assert.equal(
    names.every((name) =>
      ["inspect_app", "read_today", "lookup_food", "list_saved_foods"].includes(
        name
      )
    ),
    true
  );
});

test("conversation mode exposes no app tools even if the classifier requests one", () => {
  const names = selectedToolNames({
    mode: "conversation",
    toolNames: ["add_food"],
    evidence: "No app action was requested.",
  });

  assert.deepEqual(names, []);
});

test("the newest route context survives the router character cap", async () => {
  const calls = [];
  const history = Array.from({ length: 6 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `${index === 5 ? "NEWEST FOOD REFERENT: baked sweet potato. " : `older-${index} `}${"x".repeat(1_450)}`,
  }));
  await classifyBuddyTurn({
    llm: classifierReturning(
      {
        mode: "write_explicit",
        tool_names: ["add_food"],
        evidence: "The newest context resolves the diary referent.",
      },
      calls
    ),
    userText: "Put that in my diary.",
    history,
  });

  const routedHistory = calls[0].messages.slice(1, -1);
  assert.equal(
    routedHistory.some((message) =>
      message.content.includes("NEWEST FOOD REFERENT: baked sweet potato")
    ),
    true
  );
});

test("read turns cannot authorize a later mutation continuation", () => {
  const plan = {
    kind: "saved_food_log",
    allowedToolNames: ["log_saved_food"],
    allowedSavedFoodIds: ["saved_1"],
    blockedReason: null,
  };
  assert.deepEqual(
    authorizeBuddyContinuationPlan({ writeAuthorized: false, plan }),
    {
      kind: null,
      allowedToolNames: [],
      allowedSavedFoodIds: [],
      allowedTrackerIds: [],
      sourceData: null,
      blockedReason: null,
    }
  );
  assert.equal(
    authorizeBuddyContinuationPlan({ writeAuthorized: true, plan }),
    plan
  );
});

test("a visible panel question requires inspection when the model forgets the tool", () => {
  assert.deepEqual(
    requiredAppInspection({
      userText: "What is this Weight 30-Day thing? Don't change or remove anything.",
      evaluations: [],
    }),
    {
      focus: "What is this Weight 30-Day thing? Don't change or remove anything.",
      allow_removal: false,
    }
  );
  assert.equal(
    requiredAppInspection({
      userText: "What nutrients are in a sweet potato?",
      evaluations: [],
    }),
    null
  );
  assert.equal(
    requiredAppInspection({
      userText: "Explain this chart",
      evaluations: [{ ok: true, tool_name: "inspect_app" }],
    }),
    null
  );
});
