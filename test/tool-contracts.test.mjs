import test from "node:test";
import assert from "node:assert/strict";

import {
  BIGBRICEY_TOOL_NAMES,
  BIGBRICEY_TOOLS,
  buildNativeToolResultMessage,
  buildToolResultEnvelope,
  getToolPolicy,
  validateNativeToolCall,
} from "../api/_tool_contracts.js";

function call(name, args, id = `call_${name}`) {
  return {
    id,
    type: "function",
    function: {
      name,
      arguments: JSON.stringify(args),
    },
  };
}

const EXPECTED_TOOLS = [
  "inspect_app",
  "read_today",
  "lookup_food",
  "add_food",
  "update_food",
  "remove_food",
  "clear_food_day",
  "save_food",
  "log_saved_food",
  "list_saved_foods",
  "delete_saved_food",
  "set_goals",
  "log_workout",
  "log_steps",
  "log_metric",
  "set_tracker",
  "remove_tracker",
  "set_theme",
  "set_scene",
  "set_layout",
  "remember",
  "forget_memory",
];

test("inspect_app is a bounded read-only tool for exact interface questions", () => {
  const valid = validateNativeToolCall(
    call("inspect_app", {
      focus: "the Weight (30-Day) panel below chat",
      allow_removal: true,
    })
  );
  assert.equal(valid.ok, true);
  assert.equal(valid.status, "ready");
  assert.equal(valid.policy.mutates, false);
  assert.deepEqual(valid.arguments, {
    focus: "the Weight (30-Day) panel below chat",
    allow_removal: true,
  });
  const omittedRemovalGate = validateNativeToolCall(
    call("inspect_app", { focus: "weight" })
  );
  assert.equal(omittedRemovalGate.ok, true);
  assert.equal(omittedRemovalGate.arguments.allow_removal, false);

  assert.equal(
    validateNativeToolCall(
      call("inspect_app", {
        focus: "x".repeat(501),
        allow_removal: false,
      })
    ).error.code,
    "OUT_OF_RANGE"
  );
  assert.equal(
    validateNativeToolCall(
      call("inspect_app", {
        focus: "weight",
        allow_removal: false,
        user_email: "other@example.com",
      })
    ).error.code,
    "UNKNOWN_FIELD"
  );
  const malformedRemovalGate = validateNativeToolCall(
    call("inspect_app", { focus: "weight", allow_removal: "yes" })
  );
  assert.equal(malformedRemovalGate.ok, true);
  assert.equal(malformedRemovalGate.arguments.allow_removal, false);
});

test("native catalog exposes only the allowlisted core tools with closed schemas", () => {
  assert.deepEqual(BIGBRICEY_TOOL_NAMES, EXPECTED_TOOLS);
  assert.deepEqual(
    BIGBRICEY_TOOLS.map((tool) => tool.function.name),
    EXPECTED_TOOLS
  );

  for (const tool of BIGBRICEY_TOOLS) {
    assert.equal(tool.type, "function");
    assert.equal(typeof tool.function.description, "string");
    assert.equal(tool.function.parameters.type, "object");
    assert.equal(tool.function.parameters.additionalProperties, false);
  }
});

test("unknown tools and unknown native-call fields are rejected", () => {
  const unknown = validateNativeToolCall(call("run_javascript", {}));
  assert.deepEqual(unknown.error, {
    code: "UNKNOWN_TOOL",
    message: "Tool \"run_javascript\" is not allowed.",
    path: "function.name",
  });

  const extra = validateNativeToolCall({
    ...call("read_today", {}),
    user_email: "someone@example.com",
  });
  assert.equal(extra.ok, false);
  assert.equal(extra.error.code, "UNKNOWN_FIELD");
  assert.equal(extra.error.path, "user_email");
});

test("native calls require a string JSON object and reject oversized arguments", () => {
  const objectArguments = call("read_today", {});
  objectArguments.function.arguments = {};
  assert.equal(
    validateNativeToolCall(objectArguments).error.code,
    "INVALID_TYPE"
  );

  const malformed = call("read_today", {});
  malformed.function.arguments = "{";
  assert.equal(validateNativeToolCall(malformed).error.code, "INVALID_JSON");

  const array = call("read_today", {});
  array.function.arguments = "[]";
  assert.equal(validateNativeToolCall(array).error.code, "INVALID_TYPE");

  const oversized = call("read_today", {});
  oversized.function.arguments = JSON.stringify({ junk: "x".repeat(17_000) });
  assert.equal(validateNativeToolCall(oversized).error.code, "ARGUMENTS_TOO_LARGE");
});

test("read_today accepts bounded sections and rejects dates or sections it cannot read", () => {
  const valid = validateNativeToolCall(
    call("read_today", {
      day: "2026-07-13",
      include: ["food", "totals", "workouts", "metrics", "home"],
    })
  );
  assert.equal(valid.ok, true);
  assert.equal(valid.status, "ready");
  assert.deepEqual(valid.arguments, {
    day: "2026-07-13",
    include: ["food", "totals", "workouts", "metrics", "home"],
  });
  assert.equal(valid.policy.mutates, false);

  assert.equal(
    validateNativeToolCall(call("read_today", { day: "2026-02-30" })).error
      .code,
    "INVALID_VALUE"
  );
  assert.equal(
    validateNativeToolCall(call("read_today", { include: ["private_keys"] }))
      .error.code,
    "INVALID_VALUE"
  );
});

test("food-add accepts a lookup phrase but rejects invented nutrition fields and bad ranges", () => {
  const valid = validateNativeToolCall(
    call("add_food", {
      query: "  two eggs and bacon  ",
    })
  );
  assert.equal(valid.ok, true);
  assert.deepEqual(valid.arguments, {
    query: "two eggs and bacon",
  });

  assert.equal(
    validateNativeToolCall(
      call("add_food", { query: "eggs", quantity: 3, unit: "egg" })
    ).error.code,
    "UNKNOWN_FIELD"
  );

  assert.equal(
    validateNativeToolCall(
      call("add_food", { query: "eggs", client_request_id: "model-picked-id" })
    ).error.code,
    "UNKNOWN_FIELD"
  );

  const invented = validateNativeToolCall(
    call("add_food", { query: "mystery shake", kcal: 400 })
  );
  assert.equal(invented.error.code, "UNKNOWN_FIELD");
  assert.equal(invented.error.path, "function.arguments.kcal");

  assert.equal(
    validateNativeToolCall(call("add_food", { query: "eggs", quantity: 0 }))
      .error.code,
    "UNKNOWN_FIELD"
  );
  assert.equal(
    validateNativeToolCall(call("add_food", { query: "x".repeat(501) })).error
      .code,
    "OUT_OF_RANGE"
  );
});

test("food lookup is read-only and accepts only an explicit safe portion basis", () => {
  const exactMass = validateNativeToolCall(
    call("lookup_food", {
      query: "sweet potato",
      amount: 0.75,
      unit: "lb",
    })
  );
  assert.equal(exactMass.ok, true);
  assert.equal(exactMass.policy.mutates, false);
  assert.deepEqual(exactMass.arguments, {
    query: "sweet potato",
    amount: 0.75,
    unit: "lb",
  });

  const mediumPiece = validateNativeToolCall(
    call("lookup_food", {
      query: "sweet potato",
      amount: 1,
      unit: "piece",
      size: "medium",
    })
  );
  assert.equal(mediumPiece.ok, true);
  assert.equal(mediumPiece.policy.mutates, false);

  const implicitOnePiece = validateNativeToolCall(
    call("lookup_food", {
      query: "sweet potato",
      unit: "piece",
      size: "medium",
    })
  );
  assert.equal(implicitOnePiece.ok, true);
  assert.deepEqual(implicitOnePiece.arguments, {
    query: "sweet potato",
    amount: 1,
    unit: "piece",
    size: "medium",
  });

  assert.equal(
    validateNativeToolCall(
      call("lookup_food", { query: "sweet potato", amount: 1 })
    ).error.code,
    "INVALID_COMBINATION"
  );
  assert.equal(
    validateNativeToolCall(
      call("lookup_food", {
        query: "sweet potato",
        amount: 1,
        unit: "cup",
      })
    ).error.code,
    "INVALID_VALUE"
  );
  assert.equal(
    validateNativeToolCall(
      call("lookup_food", {
        query: "sweet potato",
        amount: 1,
        unit: "piece",
      })
    ).error.code,
    "REQUIRED_FIELD"
  );
});

test("food-update requires an actual change and food removal is confirmation-gated", () => {
  const noChange = validateNativeToolCall(
    call("update_food", { entry_id: "food_123" })
  );
  assert.equal(noChange.error.code, "REQUIRED_FIELD");

  const valid = validateNativeToolCall(
    call("update_food", {
      entry_id: "food_123",
      query: "three scrambled eggs",
    })
  );
  assert.equal(valid.status, "ready");

  const removalCall = call("remove_food", { entry_id: "food_123" });
  const removal = validateNativeToolCall(removalCall);
  assert.equal(removal.ok, true);
  assert.equal(removal.status, "needs_confirmation");
  assert.deepEqual(removal.confirmation, {
    required: true,
    state: "required",
    reason: "This removes a food entry from the ledger.",
    prompt: "Remove this food entry?",
  });

  const confirmed = validateNativeToolCall(removalCall, {
    confirmedToolCallIds: [removalCall.id],
  });
  assert.equal(confirmed.status, "ready");
  assert.equal(confirmed.confirmation.state, "confirmed");
});

test("clearing a food day always requires call-bound confirmation", () => {
  assert.equal(
    validateNativeToolCall(call("clear_food_day", {})).error.code,
    "REQUIRED_FIELD"
  );
  const clearCall = call("clear_food_day", { day: "2026-07-13" }, "call_clear");
  assert.equal(validateNativeToolCall(clearCall).status, "needs_confirmation");
  assert.equal(
    validateNativeToolCall(clearCall, {
      confirmedToolCallIds: ["some_other_call"],
    }).status,
    "needs_confirmation"
  );
  assert.equal(
    validateNativeToolCall(clearCall, {
      confirmedToolCallIds: ["call_clear"],
    }).status,
    "ready"
  );
});

test("single-entry removal may bind the selected ledger day before confirmation", () => {
  const removal = validateNativeToolCall(
    call("remove_food", { entry_id: "food_123", day: "2026-07-13" })
  );
  assert.equal(removal.ok, true);
  assert.equal(removal.status, "needs_confirmation");
  assert.equal(removal.arguments.day, "2026-07-13");
});

test("saved foods must come from ledger entries or a server lookup, never model macros", () => {
  const ledgerSource = validateNativeToolCall(
    call("save_food", {
      name: "Morning shake",
      source_entry_ids: ["row_1", "row_2"],
      serving_label: "1 shake",
      description: "My regular breakfast",
    })
  );
  assert.equal(ledgerSource.ok, true);

  const lookupSource = validateNativeToolCall(
    call("save_food", {
      name: "Greek yogurt",
      food_query: "170 g Fage 5% Greek yogurt",
    })
  );
  assert.equal(lookupSource.ok, true);

  assert.equal(
    validateNativeToolCall(
      call("save_food", {
        name: "Ambiguous",
        food_query: "eggs",
        source_entry_ids: ["row_1"],
      })
    ).error.code,
    "INVALID_COMBINATION"
  );
  assert.equal(
    validateNativeToolCall(call("save_food", { name: "No source" })).error.code,
    "REQUIRED_FIELD"
  );
  assert.equal(
    validateNativeToolCall(
      call("save_food", { name: "Fake", food_query: "shake", protein: 80 })
    ).error.code,
    "UNKNOWN_FIELD"
  );
});

test("saved-food log/list/delete contracts are strict and deletion needs confirmation", () => {
  const log = validateNativeToolCall(
    call("log_saved_food", { name: "Morning shake", servings: 1.5 })
  );
  assert.equal(log.ok, true);

  assert.equal(
    validateNativeToolCall(
      call("log_saved_food", {
        name: "Morning shake",
        saved_food_id: "saved_1",
      })
    ).error.code,
    "INVALID_COMBINATION"
  );

  const list = validateNativeToolCall(
    call("list_saved_foods", {
      query: "shake",
      limit: 25,
      for_logging: true,
    })
  );
  assert.equal(list.ok, true);
  assert.equal(list.arguments.for_logging, true);
  assert.equal(list.policy.mutates, false);
  const omittedLoggingGate = validateNativeToolCall(
    call("list_saved_foods", { query: "shake" })
  );
  assert.equal(omittedLoggingGate.ok, true);
  assert.equal(omittedLoggingGate.arguments.for_logging, false);
  assert.equal(
    validateNativeToolCall(
      call("list_saved_foods", { limit: 51, for_logging: false })
    ).error.code,
    "OUT_OF_RANGE"
  );
  const malformedLoggingGate = validateNativeToolCall(
    call("list_saved_foods", { for_logging: "yes" })
  );
  assert.equal(malformedLoggingGate.ok, true);
  assert.equal(malformedLoggingGate.arguments.for_logging, false);

  const deletion = validateNativeToolCall(
    call("delete_saved_food", { saved_food_id: "saved_1" })
  );
  assert.equal(deletion.status, "needs_confirmation");
  assert.equal(getToolPolicy("delete_saved_food").destructive, true);
});

test("goal updates require a target, use safe numeric ranges, and reject coercion", () => {
  const valid = validateNativeToolCall(
    call("set_goals", {
      kcal: 2200,
      protein: 180,
      carbs: 100,
      net_carbs: 50,
      style: "low_carb",
      recompute: false,
    })
  );
  assert.equal(valid.ok, true);
  assert.equal(valid.arguments.net_carbs, 50);
  assert.equal(valid.arguments.day, undefined);

  assert.equal(
    validateNativeToolCall(call("set_goals", {})).error.code,
    "REQUIRED_FIELD"
  );
  assert.equal(
    validateNativeToolCall(call("set_goals", { day: "2026-07-13", kcal: 2200 }))
      .error.code,
    "UNKNOWN_FIELD"
  );
  assert.equal(
    validateNativeToolCall(call("set_goals", { kcal: 800 })).error.code,
    "OUT_OF_RANGE"
  );
  assert.equal(
    validateNativeToolCall(call("set_goals", { kcal: "2200" })).error.code,
    "INVALID_TYPE"
  );
});

test("workout, steps, and metric contracts enforce finite bounded measurements", () => {
  assert.equal(
    validateNativeToolCall(
      call("log_workout", {
        title: "Leg day",
        category: "strength",
        duration_min: 45,
        sets: 12,
        reps: 96,
        load_lb: 315,
        notes: "Felt strong",
      })
    ).ok,
    true
  );
  assert.equal(
    validateNativeToolCall(
      call("log_workout", { title: "Long", duration_min: 1441 })
    ).error.code,
    "OUT_OF_RANGE"
  );

  assert.equal(
    validateNativeToolCall(call("log_steps", { steps: 30_000 })).ok,
    true
  );
  assert.equal(
    validateNativeToolCall(call("log_steps", { steps: 3.5 })).error.code,
    "INVALID_TYPE"
  );
  assert.equal(
    validateNativeToolCall(call("log_steps", { steps: 200_001 })).error.code,
    "OUT_OF_RANGE"
  );

  assert.equal(
    validateNativeToolCall(
      call("log_metric", {
        measure_id: "weight_lb",
        value: 210.5,
        unit: "lb",
        label: "Weight",
      })
    ).ok,
    true
  );
  assert.equal(
    validateNativeToolCall(
      call("log_metric", { measure_id: "bad measure", value: 10 })
    ).error.code,
    "INVALID_VALUE"
  );
});

test("dashboard trackers create real bounded counters or charts and removal is confirmed", () => {
  const chart = validateNativeToolCall(
    call("set_tracker", {
      kind: "chart",
      title: "30-day weight",
      measure_id: "weight_lb",
      unit: "lb",
      chart: "line",
      days: 30,
      size: "full",
      color: "#38bdf8",
    })
  );
  assert.equal(chart.ok, true);
  assert.equal(chart.status, "ready");

  const counter = validateNativeToolCall(
    call("set_tracker", {
      kind: "counter",
      title: "Push-ups",
      measure_id: "pushups",
      unit: "reps",
      goal: 100,
      mode: "floor",
    })
  );
  assert.equal(counter.ok, true);

  assert.equal(
    validateNativeToolCall(
      call("set_tracker", {
        kind: "chart",
        title: "Ambiguous",
        measure_id: "weight_lb",
        measures: ["weight_lb"],
      })
    ).error.code,
    "INVALID_COMBINATION"
  );
  assert.equal(
    validateNativeToolCall(
      call("set_tracker", {
        kind: "counter",
        title: "Bad counter",
        measure_id: "pushups",
        days: 30,
      })
    ).error.code,
    "INVALID_COMBINATION"
  );
  assert.equal(
    validateNativeToolCall(
      call("set_tracker", {
        kind: "chart",
        title: "Too long",
        measure_id: "weight_lb",
        days: 1096,
      })
    ).error.code,
    "OUT_OF_RANGE"
  );

  const removal = validateNativeToolCall(
    call("remove_tracker", { id: "c_weight_30d" })
  );
  assert.equal(removal.status, "needs_confirmation");
  assert.equal(removal.policy.destructive, true);
  assert.equal(
    validateNativeToolCall(
      call("remove_tracker", { match: "30-day weight" })
    ).error.code,
    "UNKNOWN_FIELD"
  );

  const removeTool = BIGBRICEY_TOOLS.find(
    (tool) => tool.function.name === "remove_tracker"
  );
  assert.match(removeTool.function.description, /exact id/i);
  assert.match(removeTool.function.parameters.properties.id.description, /id only/i);
});

test("theme and scene contracts reject arbitrary CSS and nonexistent scenes", () => {
  const theme = validateNativeToolCall(
    call("set_theme", {
      preset: "pastel",
      accent: "#ff99cc",
      font_scale: 1.1,
      radius: 24,
      density: "cozy",
    })
  );
  assert.equal(theme.ok, true);

  const emptyTheme = validateNativeToolCall(call("set_theme", {}));
  assert.equal(emptyTheme.ok, false);
  assert.equal(emptyTheme.error.code, "REQUIRED_FIELD");
  assert.equal(emptyTheme.error.path, "function.arguments");

  assert.equal(
    validateNativeToolCall(
      call("set_theme", { accent: "url(javascript:alert(1))" })
    ).error.code,
    "INVALID_VALUE"
  );
  assert.equal(
    validateNativeToolCall(call("set_theme", { font_scale: 1.31 })).error.code,
    "OUT_OF_RANGE"
  );
  assert.equal(
    validateNativeToolCall(call("set_scene", { scene: "my_little_pony" })).error
      .code,
    "INVALID_VALUE"
  );
  assert.equal(
    validateNativeToolCall(call("set_scene", { scene: "aurora" })).ok,
    true
  );
});

test("layout accepts known panels and sizes while rejecting duplicates or nested unknowns", () => {
  const valid = validateNativeToolCall(
    call("set_layout", {
      order: ["chat", "kcal", "pro", "food"],
      sizes: { chat: "full", pro: "half", food: "full" },
    })
  );
  assert.equal(valid.ok, true);

  assert.equal(
    validateNativeToolCall(
      call("set_layout", { order: ["chat", "chat"] })
    ).error.code,
    "INVALID_VALUE"
  );
  const nestedUnknown = validateNativeToolCall(
    call("set_layout", { sizes: { admin: "full" } })
  );
  assert.equal(nestedUnknown.error.code, "UNKNOWN_FIELD");
  assert.equal(nestedUnknown.error.path, "function.arguments.sizes.admin");
  assert.equal(
    validateNativeToolCall(call("set_layout", { reset: true, order: ["chat"] }))
      .error.code,
    "INVALID_COMBINATION"
  );
});

test("memory notes are bounded and forgetting memory is destructive", () => {
  const remember = validateNativeToolCall(
    call("remember", {
      note: "  Call me B and skip canned pep talks.  ",
      kind: "preference",
    })
  );
  assert.equal(remember.ok, true);
  assert.deepEqual(remember.arguments, {
    note: "Call me B and skip canned pep talks.",
    kind: "preference",
  });
  assert.equal(
    validateNativeToolCall(call("remember", { note: "x".repeat(301) })).error
      .code,
    "OUT_OF_RANGE"
  );

  const forget = validateNativeToolCall(
    call("forget_memory", { match: "canned pep talks" })
  );
  assert.equal(forget.status, "needs_confirmation");
  assert.equal(forget.policy.destructive, true);

  const byId = validateNativeToolCall(
    call("forget_memory", {
      memory_id: "8d9b0195-9f4c-4d66-a9cc-83d868e2b8c2",
    })
  );
  assert.equal(byId.status, "needs_confirmation");
  assert.equal(
    validateNativeToolCall(
      call("forget_memory", {
        memory_id: "8d9b0195-9f4c-4d66-a9cc-83d868e2b8c2",
        match: "canned pep talks",
      })
    ).error.code,
    "INVALID_COMBINATION"
  );
  assert.equal(
    validateNativeToolCall(call("remember", { note: "Maybe hungry", kind: "inference" }))
      .error.code,
    "INVALID_VALUE"
  );
});

test("every destructive tool carries explicit confirmation metadata", () => {
  const destructive = BIGBRICEY_TOOL_NAMES.filter(
    (name) => getToolPolicy(name).destructive
  );
  assert.deepEqual(destructive, [
    "remove_food",
    "clear_food_day",
    "delete_saved_food",
    "remove_tracker",
    "forget_memory",
  ]);
  for (const name of destructive) {
    const policy = getToolPolicy(name);
    assert.equal(policy.confirmation.required, true);
    assert.ok(policy.confirmation.reason.length > 10);
    assert.ok(policy.confirmation.prompt.endsWith("?"));
  }
});

test("tool-result envelopes are fixed, deterministic, and contain no timestamp", () => {
  const input = {
    toolCallId: "call_read",
    toolName: "read_today",
    status: "success",
    changed: false,
    data: {
      totals: { protein: 180, kcal: 2200 },
      foods: ["eggs", "bacon"],
    },
  };
  const first = buildToolResultEnvelope(input);
  const second = buildToolResultEnvelope(input);

  assert.deepEqual(first, second);
  assert.deepEqual(first, {
    schema_version: 1,
    tool_call_id: "call_read",
    tool_name: "read_today",
    status: "success",
    ok: true,
    changed: false,
    data: {
      foods: ["eggs", "bacon"],
      totals: { kcal: 2200, protein: 180 },
    },
    error: null,
    confirmation: null,
    undo_token: null,
  });
  assert.equal("timestamp" in first, false);

  const firstMessage = buildNativeToolResultMessage(first);
  const secondMessage = buildNativeToolResultMessage(second);
  assert.deepEqual(firstMessage, secondMessage);
  assert.deepEqual(firstMessage, {
    role: "tool",
    tool_call_id: "call_read",
    content: JSON.stringify(first),
  });
});

test("error and confirmation result envelopes cannot claim a mutation succeeded", () => {
  const error = buildToolResultEnvelope({
    toolCallId: "call_add",
    toolName: "add_food",
    status: "error",
    changed: true,
    data: { fake: "must be discarded" },
    error: {
      code: "FOOD_NOT_FOUND",
      message: "No verified nutrition match was found.",
      retryable: false,
    },
    undoToken: "must-not-survive",
  });
  assert.equal(error.ok, false);
  assert.equal(error.changed, false);
  assert.equal(error.data, null);
  assert.equal(error.undo_token, null);
  assert.deepEqual(error.error, {
    code: "FOOD_NOT_FOUND",
    message: "No verified nutrition match was found.",
    retryable: false,
  });

  const removal = validateNativeToolCall(
    call("remove_food", { entry_id: "food_123" }, "call_remove")
  );
  const pending = buildToolResultEnvelope({
    toolCallId: removal.tool_call_id,
    toolName: removal.tool_name,
    status: "needs_confirmation",
    changed: true,
    confirmation: removal.confirmation,
  });
  assert.equal(pending.ok, false);
  assert.equal(pending.changed, false);
  assert.equal(pending.error, null);
  assert.deepEqual(pending.confirmation, removal.confirmation);
});
