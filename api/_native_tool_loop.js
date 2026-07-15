function compactObject(value) {
  return Object.fromEntries(
    Object.entries(value || {}).filter(([, item]) => item !== undefined)
  );
}

function foodPhrase(args = {}) {
  const query = String(args.query || args.food_query || "").trim();
  if (!query) return "";
  if (args.quantity == null) return query;
  return `${args.quantity} ${args.unit || "serving"} ${query}`
    .replace(/\s+/g, " ")
    .trim();
}

function withToolMetadata(call, action) {
  return compactObject({
    ...action,
    __tool_call_id: call.tool_call_id,
    __tool_name: call.tool_name,
  });
}

/** Translate a validated native call into the legacy executor's internal shape. */
export function actionFromValidatedToolCall(call) {
  if (!call?.ok || call.status !== "ready") return null;
  const args = call.arguments || {};
  let action;

  switch (call.tool_name) {
    case "inspect_app":
      action = { type: "inspect_app", ...args };
      break;
    case "read_today":
      action = { type: "read_today", ...args };
      break;
    case "add_food":
      action = { type: "add", food_text: foodPhrase(args) };
      break;
    case "update_food":
      action = {
        type: "update",
        id: args.entry_id,
        match: args.match,
        food_text: foodPhrase(args) || args.query,
        amount: args.quantity,
        unit: args.unit,
      };
      break;
    case "remove_food":
      action = {
        type: "remove",
        id: args.entry_id,
        match: args.match,
        day: args.day,
      };
      break;
    case "clear_food_day":
      action = { type: "clear_day", day: args.day };
      break;
    case "save_food":
      action = { type: "save_food_native", ...args };
      break;
    case "log_saved_food":
      action = {
        type: "log_saved",
        name: args.name,
        saved_food_id: args.saved_food_id,
        amount: args.servings,
      };
      break;
    case "list_saved_foods":
      action = { type: "list_saved", ...args };
      break;
    case "delete_saved_food":
      action = { type: "delete_saved_native", ...args };
      break;
    case "set_goals":
      action = { type: "set_goals", ...args, eating_style: args.style };
      delete action.style;
      break;
    case "log_workout":
      action = {
        type: "log_activity",
        ...args,
        category_id: args.category,
        weight: args.load_lb,
      };
      break;
    case "log_steps":
      action = { type: "log_steps", ...args };
      break;
    case "log_metric":
      action = { type: "log_metric", ...args };
      break;
    case "set_tracker":
      action = {
        type: args.kind === "chart" ? "set_chart" : "set_box",
        ...args,
      };
      break;
    case "remove_tracker":
      action = {
        type: "remove_box",
        id: args.id,
      };
      break;
    case "set_theme":
      action = { type: "set_theme", ...args };
      break;
    case "set_scene":
      action = { type: "set_scene", ...args };
      break;
    case "set_layout":
      action = { type: args.reset ? "reset_layout" : "set_layout", ...args };
      break;
    case "remember":
      action = { type: "remember", ...args };
      break;
    case "forget_memory":
      action = { type: "forget", ...args };
      break;
    default:
      return null;
  }

  return withToolMetadata(call, compactObject(action));
}

const ONE_ROUND_CONTINUATIONS = Object.freeze({
  inspect_app: Object.freeze({
    kind: "tracker_removal",
    allowedToolNames: Object.freeze(["remove_tracker"]),
  }),
  list_saved_foods: Object.freeze({
    kind: "saved_food_log",
    allowedToolNames: Object.freeze(["log_saved_food"]),
  }),
});

function emptyContinuationPlan(
  sourceData = null,
  { kind = null, blockedReason = null } = {}
) {
  return {
    kind,
    allowedToolNames: [],
    allowedSavedFoodIds: [],
    allowedTrackerIds: [],
    sourceData,
    blockedReason,
  };
}

function requestedContinuationKind(evaluations = []) {
  const kinds = new Set();
  for (const evaluation of Array.isArray(evaluations) ? evaluations : []) {
    if (!evaluation?.ok || evaluation.status !== "ready") continue;
    if (
      evaluation.tool_name === "inspect_app" &&
      evaluation.arguments?.allow_removal === true
    ) {
      kinds.add("tracker_removal");
    }
    if (
      evaluation.tool_name === "list_saved_foods" &&
      evaluation.arguments?.for_logging === true
    ) {
      kinds.add("saved_food_log");
    }
  }
  if (kinds.size === 1) return Array.from(kinds)[0];
  return kinds.size > 1 ? "ambiguous_continuation" : null;
}

/** Permit only one explicitly designed read -> action continuation round. */
export function continuationPlanForNativeReads({
  initialEvaluations = [],
  initialResults = [],
} = {}) {
  const requestedKind = requestedContinuationKind(initialEvaluations);
  const onlyResult = initialResults.length === 1 ? initialResults[0] : null;
  const sourceData =
    onlyResult?.data && typeof onlyResult.data === "object"
      ? onlyResult.data
      : null;
  if (initialEvaluations.length !== 1 || initialResults.length !== 1) {
    return emptyContinuationPlan(sourceData, {
      kind: requestedKind,
      blockedReason: requestedKind ? "multiple_reads" : null,
    });
  }
  const evaluation = initialEvaluations[0];
  const result = initialResults[0];
  if (
    !evaluation?.ok ||
    evaluation.status !== "ready" ||
    result?.status !== "success"
  ) {
    return emptyContinuationPlan(sourceData, {
      kind: requestedKind,
      blockedReason: requestedKind ? "read_failed" : null,
    });
  }
  const policy = ONE_ROUND_CONTINUATIONS[evaluation.tool_name];
  if (!policy) return emptyContinuationPlan(sourceData);

  if (
    (evaluation.tool_name === "inspect_app" &&
      evaluation.arguments?.allow_removal !== true) ||
    (evaluation.tool_name === "list_saved_foods" &&
      evaluation.arguments?.for_logging !== true)
  ) {
    return emptyContinuationPlan(sourceData);
  }

  if (evaluation.tool_name === "list_saved_foods") {
    if (Number(sourceData?.omitted_count) > 0) {
      return emptyContinuationPlan(sourceData, {
        kind: policy.kind,
        blockedReason: "partial_read",
      });
    }
    const allowedSavedFoodIds = (Array.isArray(sourceData?.saved_foods)
      ? sourceData.saved_foods
      : []
    )
      .map((food) => String(food?.id || "").trim())
      .filter(Boolean);
    if (!allowedSavedFoodIds.length) {
      return emptyContinuationPlan(sourceData, {
        kind: policy.kind,
        blockedReason: "empty_read",
      });
    }
    return {
      kind: policy.kind,
      allowedToolNames: [...policy.allowedToolNames],
      allowedSavedFoodIds,
      allowedTrackerIds: [],
      sourceData,
      blockedReason: null,
    };
  }

  const allowedTrackerIds = (Array.isArray(
    sourceData?.current_dashboard?.trackers
  )
    ? sourceData.current_dashboard.trackers
    : []
  )
    .map((tracker) => String(tracker?.id || "").trim())
    .filter(Boolean);
  if (!allowedTrackerIds.length) {
    return emptyContinuationPlan(sourceData, {
      kind: policy.kind,
      blockedReason: "empty_read",
    });
  }

  return {
    kind: policy.kind,
    allowedToolNames: [...policy.allowedToolNames],
    allowedSavedFoodIds: [],
    allowedTrackerIds,
    sourceData,
    blockedReason: null,
  };
}

/** Validate the one provider follow-up against the verified read result. */
export function selectNativeContinuation({
  plan = emptyContinuationPlan(),
  followupEvaluations = [],
  continuationDepth = 1,
} = {}) {
  if (
    continuationDepth !== 1 ||
    !plan?.kind ||
    !Array.isArray(plan.allowedToolNames) ||
    followupEvaluations.length !== 1
  ) {
    return { ok: false, kind: null, evaluation: null };
  }
  const evaluation = followupEvaluations[0];
  if (
    !evaluation?.ok ||
    !plan.allowedToolNames.includes(evaluation.tool_name)
  ) {
    return { ok: false, kind: null, evaluation: null };
  }

  if (plan.kind === "saved_food_log") {
    const savedFoodId = String(
      evaluation.arguments?.saved_food_id || ""
    ).trim();
    if (
      evaluation.status !== "ready" ||
      !savedFoodId ||
      evaluation.arguments?.name != null ||
      !plan.allowedSavedFoodIds.includes(savedFoodId)
    ) {
      return { ok: false, kind: null, evaluation: null };
    }
  } else if (
    plan.kind === "tracker_removal" &&
    (evaluation.status !== "needs_confirmation" ||
      !String(evaluation.arguments?.id || "").trim() ||
      evaluation.arguments?.match != null ||
      !Array.isArray(plan.allowedTrackerIds) ||
      !plan.allowedTrackerIds.includes(
        String(evaluation.arguments.id).trim()
      ))
  ) {
    return { ok: false, kind: null, evaluation: null };
  }

  return { ok: true, kind: plan.kind, evaluation };
}

/** Safe wording when an authorized read did not produce its required action. */
export function unresolvedContinuationReply(plan = {}) {
  if (plan?.kind === "saved_food_log") {
    if (plan.blockedReason === "empty_read") {
      return "I couldn't find a saved food matching that, so I didn't log anything. What is it called?";
    }
    if (plan.blockedReason === "read_failed") {
      return "I couldn't safely read your saved foods, so I didn't log anything. Try that again in a moment.";
    }
    if (["partial_read", "multiple_reads"].includes(plan.blockedReason)) {
      return "I found possible saved foods, but I couldn't verify one exact match, so I didn't log anything. Which saved food did you mean?";
    }
    return "I found your saved foods, but I didn't log anything because I couldn't verify one exact match. Which saved food did you mean?";
  }
  if (plan?.kind === "tracker_removal") {
    if (plan.blockedReason === "empty_read") {
      return "I couldn't find that tracker in the inspected dashboard, so I didn't remove anything. Nothing changed.";
    }
    if (["read_failed", "multiple_reads"].includes(plan.blockedReason)) {
      return "I couldn't safely verify that tracker, so I didn't remove anything. Nothing changed.";
    }
    return "I inspected that part of the app, but I didn't remove anything. Nothing changed.";
  }
  return "I completed the read, but I didn't make any change.";
}

/** Rebuild the provider assistant message from canonical validated arguments. */
export function assistantMessageForValidatedCalls(calls) {
  const toolCalls = (Array.isArray(calls) ? calls : [])
    .filter(
      (call) =>
        call?.ok &&
        call.tool_call_id &&
        call.tool_name &&
        call.arguments &&
        typeof call.arguments === "object"
    )
    .map((call) => ({
      id: call.tool_call_id,
      type: "function",
      function: {
        name: call.tool_name,
        arguments: JSON.stringify(call.arguments),
      },
    }));

  return {
    role: "assistant",
    content: null,
    tool_calls: toolCalls,
  };
}

export function safeAssistantReply(value, fallback = "") {
  const clean = String(value || "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, " ")
    .trim()
    .slice(0, 8_000);
  return clean || String(fallback || "").trim().slice(0, 8_000);
}

const INVALID_NATIVE_TOOL_MESSAGE =
  "I couldn't safely use that app action, so nothing changed.";
const DEFAULT_TOOL_ERROR_MESSAGE =
  "I couldn't safely complete that action. Nothing changed.";
const DEFAULT_CONFIRMATION_MESSAGE =
  "That change needs your confirmation before I do anything.";

const MUTATING_NATIVE_TOOLS = new Set([
  "add_food",
  "update_food",
  "remove_food",
  "clear_food_day",
  "save_food",
  "log_saved_food",
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
]);

function cleanExecutionNotes(notes) {
  return (Array.isArray(notes) ? notes : [notes])
    .map((note) => String(note || "").trim())
    .filter(Boolean)
    .slice(0, 50);
}

function noteFailure(note, toolName) {
  const text = String(note || "").trim();
  if (!text) return null;

  if (
    /\b(?:cloud|ledger) save failed\b/i.test(text) ||
    /\b(?:save|commit)(?: operation)? failed\b/i.test(text) ||
    /\bcould not be safely saved\b/i.test(text) ||
    /\bno\b[^.!?\n]{0,80}\bchange was committed\b/i.test(text) ||
    (MUTATING_NATIVE_TOOLS.has(toolName) && /\bcloud off\b/i.test(text))
  ) {
    return { code: "TOOL_COMMIT_FAILED", message: text };
  }

  if (
    /^\s*food lookup failed\b/i.test(text) ||
    /\btemporarily unavailable\b/i.test(text) ||
    /^\s*(?:couldn['’]?t|could not|cannot|can['’]?t)\s+(?:read|load|list|access|reach)\b/i.test(
      text
    ) ||
    (!MUTATING_NATIVE_TOOLS.has(toolName) && /\bcloud off\b/i.test(text))
  ) {
    return { code: "TOOL_UNAVAILABLE", message: text };
  }

  if (
    /^\s*unsupported\s+(?:action|tool)\b/i.test(text) ||
    /^\s*unknown scene\b/i.test(text)
  ) {
    return { code: "TOOL_UNSUPPORTED", message: text };
  }

  if (
    /^\s*(?:steps|metric|update)\s+needs?\b/i.test(text) ||
    /^\s*need a\b/i.test(text) ||
    /^\s*which saved food\b/i.test(text) ||
    /^\s*more than one food entry matched\b/i.test(text) ||
    /^\s*more than one permanent memory matched\b/i.test(text) ||
    /^\s*add requested but\b/i.test(text) ||
    /^\s*tell me what to change\b/i.test(text) ||
    /^\s*i found\b[^\n]{0,240}\bcouldn['’]?t verify\b/i.test(text) ||
    /^\s*to save\b[^\n]{0,160}\bgive macros\b/i.test(text) ||
    /^\s*try a preset\b/i.test(text)
  ) {
    return { code: "TOOL_REQUIRED_DETAILS", message: text };
  }

  const validEmptySavedFoodList =
    toolName === "list_saved_foods" && /^\s*no saved foods matched\b/i.test(text);
  if (
    !validEmptySavedFoodList &&
    (/\b(?:source entr(?:y|ies)|row)\b[^.!?\n]{0,80}\bnot found\b/i.test(text) ||
      /\bcouldn['’]?t find\b/i.test(text) ||
      /^\s*no permanent memory note matched\b/i.test(text) ||
      /^\s*no custom (?:box|tracker) matched\b/i.test(text) ||
      /\bno (?:complete )?(?:verified )?nutrition match\b/i.test(text) ||
      /\bno nutrition match\b/i.test(text) ||
      /^\s*no match in food databases\b/i.test(text) ||
      /\bno saved food(?:s)?(?:\s+(?:named|matched)\b|\s+["'“‘])/i.test(text) ||
      /\bno saved food matched that (?:request|id)\b/i.test(text))
  ) {
    return { code: "TOOL_NOT_FOUND", message: text };
  }

  if (
    /^\s*incomplete data\b/i.test(text) ||
    /\bnutrition data was incomplete\b/i.test(text) ||
    /^\s*(?:couldn['’]?t|could not|cannot|can['’]?t)\b/i.test(text) ||
    /\bfailed to\b/i.test(text)
  ) {
    return { code: "TOOL_EXECUTION_FAILED", message: text };
  }

  return null;
}

/**
 * Turn controlled executor output into one truthful result. This deliberately
 * classifies only known executor failure language or an explicit failure flag;
 * ordinary prose containing words such as "failed" or "no" remains success.
 */
export function classifyNativeToolExecution({
  toolName = "",
  notes = [],
  changed = false,
  data = null,
  commitFailed = false,
  result = null,
} = {}) {
  const canonicalToolName = String(toolName || "").trim();
  const cleanNotes = cleanExecutionNotes(notes);
  const explicitError =
    result?.status === "error" || result?.ok === false || Boolean(result?.error);
  const failure = commitFailed
    ? {
        code: "TOOL_COMMIT_FAILED",
        message:
          cleanNotes.find(
            (note) =>
              noteFailure(note, canonicalToolName)?.code === "TOOL_COMMIT_FAILED"
          ) ||
          "The requested change could not be safely committed. Nothing changed.",
      }
    : cleanNotes.map((note) => noteFailure(note, canonicalToolName)).find(Boolean) ||
      (explicitError
        ? {
            code: String(result?.error?.code || "TOOL_EXECUTION_FAILED"),
            message: String(
              result?.error?.message || cleanNotes[0] || DEFAULT_TOOL_ERROR_MESSAGE
            ),
          }
        : null);

  if (failure) {
    return {
      status: "error",
      changed: false,
      notes: cleanNotes,
      data: null,
      error: {
        code: failure.code,
        message: failure.message,
        retryable: false,
      },
    };
  }

  return {
    status: "success",
    changed: Boolean(changed),
    notes: cleanNotes,
    data: data ?? null,
    error: null,
  };
}

/** A malformed or disallowed provider tool call always has the same safe result. */
export function invalidNativeToolExecution() {
  return {
    status: "error",
    changed: false,
    notes: [INVALID_NATIVE_TOOL_MESSAGE],
    data: null,
    error: {
      code: "INVALID_TOOL_CALL",
      message: INVALID_NATIVE_TOOL_MESSAGE,
      retryable: false,
    },
  };
}

function firstResultMessage(toolResults) {
  for (const result of Array.isArray(toolResults) ? toolResults : []) {
    if (result?.status !== "error" && result?.ok !== false) continue;
    const errorMessage = String(result?.error?.message || "").trim();
    if (errorMessage) return errorMessage;
    const notes = cleanExecutionNotes(result?.notes);
    if (notes.length) return notes.join(" ");
  }
  return "";
}

/**
 * The after-tools model is a voice pass, never the source of execution truth.
 * For any error or pending confirmation, return trusted executor/confirmation
 * wording. Only an all-success result may keep the model's natural prose.
 */
export function selectVerifiedNativeToolReply({
  candidateReply = "",
  fallbackReply = "",
  toolResults = [],
  pendingConfirmation = null,
} = {}) {
  const results = Array.isArray(toolResults) ? toolResults : [];
  const pendingResult = results.find(
    (result) => result?.status === "needs_confirmation"
  );
  if (pendingConfirmation || pendingResult) {
    return safeAssistantReply(
      pendingConfirmation?.prompt || pendingResult?.confirmation?.prompt,
      DEFAULT_CONFIRMATION_MESSAGE
    );
  }

  if (
    results.some(
      (result) => result?.status === "error" || result?.ok === false
    )
  ) {
    const safeFallback = noteFailure(fallbackReply, "")
      ? safeAssistantReply(fallbackReply)
      : "";
    return safeAssistantReply(
      firstResultMessage(results),
      safeAssistantReply(safeFallback, DEFAULT_TOOL_ERROR_MESSAGE)
    );
  }

  return safeAssistantReply(candidateReply, fallbackReply);
}
