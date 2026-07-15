import assert from "node:assert/strict";
import test from "node:test";

import {
  actionFromValidatedToolCall,
  assistantMessageForValidatedCalls,
  classifyNativeToolExecution,
  invalidNativeToolExecution,
  safeAssistantReply,
  selectVerifiedNativeToolReply,
} from "../api/_native_tool_loop.js";

function validated(toolName, args, overrides = {}) {
  return {
    ok: true,
    status: "ready",
    tool_call_id: `call_${toolName}`,
    tool_name: toolName,
    arguments: args,
    ...overrides,
  };
}

test("ready native food calls map to the existing validated executor shape", () => {
  assert.deepEqual(
    actionFromValidatedToolCall(
      validated("add_food", {
        query: "3 scrambled eggs",
      })
    ),
    {
      type: "add",
      food_text: "3 scrambled eggs",
      __tool_call_id: "call_add_food",
      __tool_name: "add_food",
    }
  );

  assert.deepEqual(
    actionFromValidatedToolCall(
      validated("remove_food", { entry_id: "row_123" })
    ),
    {
      type: "remove",
      id: "row_123",
      __tool_call_id: "call_remove_food",
      __tool_name: "remove_food",
    }
  );
});

test("read and customization calls retain only canonical validated arguments", () => {
  assert.deepEqual(
    actionFromValidatedToolCall(
      validated("inspect_app", {
        focus: "the Weight (30-Day) panel below chat",
      })
    ),
    {
      type: "inspect_app",
      focus: "the Weight (30-Day) panel below chat",
      __tool_call_id: "call_inspect_app",
      __tool_name: "inspect_app",
    }
  );

  assert.deepEqual(
    actionFromValidatedToolCall(
      validated("read_today", {
        day: "2026-07-13",
        include: ["food", "totals"],
      })
    ),
    {
      type: "read_today",
      day: "2026-07-13",
      include: ["food", "totals"],
      __tool_call_id: "call_read_today",
      __tool_name: "read_today",
    }
  );

  assert.deepEqual(
    actionFromValidatedToolCall(
      validated("set_tracker", {
        kind: "chart",
        title: "Weight trend",
        measure_id: "weight_lb",
        days: 30,
        chart: "line",
      })
    ),
    {
      type: "set_chart",
      kind: "chart",
      title: "Weight trend",
      measure_id: "weight_lb",
      days: 30,
      chart: "line",
      __tool_call_id: "call_set_tracker",
      __tool_name: "set_tracker",
    }
  );

  assert.deepEqual(
    actionFromValidatedToolCall(
      validated("remove_tracker", { match: "Weight trend" })
    ),
    {
      type: "remove_box",
      name: "Weight trend",
      __tool_call_id: "call_remove_tracker",
      __tool_name: "remove_tracker",
    }
  );

  assert.deepEqual(
    actionFromValidatedToolCall(
      validated("set_theme", { preset: "pastel", radius: 24 })
    ),
    {
      type: "set_theme",
      preset: "pastel",
      radius: 24,
      __tool_call_id: "call_set_theme",
      __tool_name: "set_theme",
    }
  );
});

test("confirmation-gated and invalid calls never become executable actions", () => {
  assert.equal(
    actionFromValidatedToolCall(
      validated("clear_food_day", {}, { status: "needs_confirmation" })
    ),
    null
  );
  assert.equal(
    actionFromValidatedToolCall({
      ok: false,
      status: "error",
      tool_call_id: "call_bad",
      tool_name: "run_javascript",
      arguments: {},
    }),
    null
  );
});

test("confirmed removal keeps its server-bound ledger day", () => {
  assert.deepEqual(
    actionFromValidatedToolCall(
      validated("remove_food", {
        entry_id: "food_123",
        day: "2026-07-13",
      })
    ),
    {
      type: "remove",
      id: "food_123",
      day: "2026-07-13",
      __tool_call_id: "call_remove_food",
      __tool_name: "remove_food",
    }
  );
});

test("assistant tool-call message is rebuilt from canonical validated calls", () => {
  const message = assistantMessageForValidatedCalls([
    validated("set_scene", { scene: "aurora" }),
  ]);
  assert.deepEqual(message, {
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id: "call_set_scene",
        type: "function",
        function: {
          name: "set_scene",
          arguments: '{"scene":"aurora"}',
        },
      },
    ],
  });
});

test("final assistant text is bounded and has a truthful fallback", () => {
  assert.equal(safeAssistantReply("  Done — your ocean is on.  "), "Done — your ocean is on.");
  assert.equal(
    safeAssistantReply("", "I made the verified change."),
    "I made the verified change."
  );
  assert.ok(safeAssistantReply("x".repeat(20_000)).length <= 8_000);
});

test("native execution truth classifies known executor failures as errors", () => {
  const failures = [
    {
      toolName: "log_saved_food",
      note: "No saved food named “morning shake”. Save it first or ask to list saved foods.",
      code: "TOOL_NOT_FOUND",
    },
    {
      toolName: "delete_saved_food",
      note: "No saved food matched that request.",
      code: "TOOL_NOT_FOUND",
    },
    {
      toolName: "remove_food",
      note: "Couldn't find row to remove (bacon).",
      code: "TOOL_NOT_FOUND",
    },
    {
      toolName: "remove_food",
      note: "More than one food entry matched. Tell me which one or give its amount.",
      code: "TOOL_REQUIRED_DETAILS",
    },
    {
      toolName: "forget_memory",
      note: "No permanent memory note matched that request.",
      code: "TOOL_NOT_FOUND",
    },
    {
      toolName: "remove_tracker",
      note: "No custom box matched “weight”.",
      code: "TOOL_NOT_FOUND",
    },
    {
      toolName: "add_food",
      note:
        "I found “Tilapia fillet”, but I couldn't verify the weight of “1 piece” for this exact food. Give me grams, ounces, pounds, or the package serving weight.",
      code: "TOOL_REQUIRED_DETAILS",
    },
    {
      toolName: "add_food",
      note: "No nutrition match for “mystery powder”.",
      code: "TOOL_NOT_FOUND",
    },
    {
      toolName: "add_food",
      note: "Food lookup failed — try again",
      code: "TOOL_UNAVAILABLE",
    },
    {
      toolName: "add_food",
      note: "No match in food databases — try a different name",
      code: "TOOL_NOT_FOUND",
    },
    {
      toolName: "save_food",
      note:
        "Found a match but nutrition data was incomplete — try a more specific name (e.g. canned artichoke hearts)",
      code: "TOOL_EXECUTION_FAILED",
    },
    {
      toolName: "log_metric",
      note:
        "The metric could not be safely saved because the cloud ledger is unavailable. Nothing changed.",
      code: "TOOL_COMMIT_FAILED",
    },
    {
      toolName: "set_scene",
      note: "Unsupported action “run_javascript”. Nothing changed.",
      code: "TOOL_UNSUPPORTED",
    },
    {
      toolName: "log_steps",
      note: "Steps need a number.",
      code: "TOOL_REQUIRED_DETAILS",
    },
    {
      toolName: "save_food",
      note: "Need a name to save that food (e.g. “morning shake”).",
      code: "TOOL_REQUIRED_DETAILS",
    },
    {
      toolName: "read_today",
      note: "Couldn't read the recorded ledger because it is temporarily unavailable.",
      code: "TOOL_UNAVAILABLE",
    },
    {
      toolName: "add_food",
      note: "The ledger save failed; no food change was committed.",
      code: "TOOL_COMMIT_FAILED",
    },
  ];

  for (const { toolName, note, code } of failures) {
    const result = classifyNativeToolExecution({
      toolName,
      notes: [note],
      changed: true,
      data: { must_not_survive: true },
    });
    assert.equal(result.status, "error", `${toolName}: ${note}`);
    assert.equal(result.changed, false, `${toolName}: ${note}`);
    assert.equal(result.data, null, `${toolName}: ${note}`);
    assert.equal(result.error.code, code, `${toolName}: ${note}`);
    assert.equal(result.error.message, note, `${toolName}: ${note}`);
  }
});

test("native execution truth preserves real success and valid empty reads", () => {
  assert.deepEqual(
    classifyNativeToolExecution({
      toolName: "add_food",
      notes: ["Added: 3 scrambled eggs"],
      changed: true,
      data: { entry_id: "food_123" },
    }),
    {
      status: "success",
      changed: true,
      notes: ["Added: 3 scrambled eggs"],
      data: { entry_id: "food_123" },
      error: null,
    }
  );

  const emptyList = classifyNativeToolExecution({
    toolName: "list_saved_foods",
    notes: [
      "No saved foods matched. Ask me to save one from a recorded entry or a specific verified food lookup.",
    ],
    changed: false,
    data: { saved_foods: [] },
  });
  assert.equal(emptyList.status, "success");
  assert.deepEqual(emptyList.data, { saved_foods: [] });

  for (const harmless of [
    "No errors found while reading the ledger.",
    "Saved food search completed with no filter applied.",
    "The previously failed item is visible in history.",
  ]) {
    assert.equal(
      classifyNativeToolExecution({
        toolName: "read_today",
        notes: [harmless],
        data: { food: [] },
      }).status,
      "success",
      harmless
    );
  }
});

test("explicit failed commits and invalid calls fail closed deterministically", () => {
  const commit = classifyNativeToolExecution({
    toolName: "log_workout",
    notes: ["Logged: deadlift"],
    changed: true,
    commitFailed: true,
  });
  assert.equal(commit.status, "error");
  assert.equal(commit.changed, false);
  assert.equal(commit.error.code, "TOOL_COMMIT_FAILED");

  const invalid = invalidNativeToolExecution();
  assert.deepEqual(invalid, {
    status: "error",
    changed: false,
    notes: ["I couldn't safely use that app action, so nothing changed."],
    data: null,
    error: {
      code: "INVALID_TOOL_CALL",
      message: "I couldn't safely use that app action, so nothing changed.",
      retryable: false,
    },
  });
});

test("second-pass model prose is accepted only when every tool succeeded", () => {
  assert.equal(
    selectVerifiedNativeToolReply({
      candidateReply: "Done — I logged your eggs.",
      fallbackReply: "Added: 3 scrambled eggs",
      toolResults: [{ status: "success", changed: true }],
    }),
    "Done — I logged your eggs."
  );

  assert.equal(
    selectVerifiedNativeToolReply({
      candidateReply: "Done — I logged your mystery meal.",
      fallbackReply:
        "Couldn't find solid nutrition data for “mystery meal”, so nothing was logged.",
      toolResults: [{ status: "error", changed: false }],
    }),
    "Couldn't find solid nutrition data for “mystery meal”, so nothing was logged."
  );

  assert.equal(
    selectVerifiedNativeToolReply({
      candidateReply: "All set — I removed it.",
      fallbackReply: "Remove “bacon” from July 13?",
      toolResults: [{ status: "needs_confirmation", changed: false }],
      pendingConfirmation: { prompt: "Remove “bacon” from July 13?" },
    }),
    "Remove “bacon” from July 13?"
  );
});

test("error and pending replies have deterministic safe fallbacks", () => {
  assert.equal(
    selectVerifiedNativeToolReply({
      candidateReply: "Saved!",
      toolResults: [
        {
          status: "error",
          error: { message: "No saved food matched that request." },
        },
      ],
    }),
    "No saved food matched that request."
  );

  assert.equal(
    selectVerifiedNativeToolReply({
      candidateReply: "Removed.",
      toolResults: [{ status: "needs_confirmation" }],
    }),
    "That change needs your confirmation before I do anything."
  );

  assert.equal(
    selectVerifiedNativeToolReply({
      candidateReply: "Done.",
      toolResults: [{ ok: false, status: "error" }],
    }),
    "I couldn't safely complete that action. Nothing changed."
  );

  assert.equal(
    selectVerifiedNativeToolReply({
      candidateReply: "Saved!",
      fallbackReply: "Done — everything is saved.",
      toolResults: [{ status: "error" }],
    }),
    "I couldn't safely complete that action. Nothing changed."
  );

  assert.equal(
    selectVerifiedNativeToolReply({
      candidateReply: "Removed.",
      fallbackReply: "All set — it was removed.",
      toolResults: [{ status: "needs_confirmation" }],
    }),
    "That change needs your confirmation before I do anything."
  );
});
