import {
  BIGBRICEY_TOOLS,
  validateNativeToolCall,
} from "./_tool_contracts.js";

const READ_ONLY_TOOL_NAMES = new Set([
  "inspect_app",
  "read_today",
  "list_saved_foods",
]);

export const READ_ONLY_REPAIR_TOOLS = Object.freeze(
  BIGBRICEY_TOOLS.filter((tool) =>
    READ_ONLY_TOOL_NAMES.has(tool?.function?.name)
  )
);

export function isKnownReadOnlyToolName(value) {
  return READ_ONLY_TOOL_NAMES.has(String(value || ""));
}

export function evaluateProviderToolCalls(toolCalls = []) {
  return (Array.isArray(toolCalls) ? toolCalls : []).map((call) => {
    const checked = validateNativeToolCall(call);
    if (checked.ok) return checked;
    return {
      ...checked,
      tool_call_id: String(call?.id || "").slice(0, 200),
      tool_name: String(call?.function?.name || "").slice(0, 100),
    };
  });
}

export function shouldRepairInvalidReadCalls(evaluations = []) {
  const calls = Array.isArray(evaluations) ? evaluations : [];
  return (
    calls.length > 0 &&
    calls.some((evaluation) => !evaluation?.ok) &&
    calls.every((evaluation) =>
      isKnownReadOnlyToolName(evaluation?.tool_name)
    )
  );
}

/**
 * Give a malformed read-only provider turn one bounded retry. The retry sees
 * only read tools, and prose without a verified tool call is never accepted as
 * private app truth.
 */
export async function repairInvalidReadTurn({
  evaluations = [],
  runTurn,
} = {}) {
  if (
    !shouldRepairInvalidReadCalls(evaluations) ||
    typeof runTurn !== "function"
  ) {
    return {
      attempted: false,
      repaired: false,
      turn: null,
      evaluations,
    };
  }

  const originalToolNames = evaluations
    .map((evaluation) => String(evaluation?.tool_name || ""))
    .sort();
  const allowedNames = new Set(originalToolNames);
  const repairTools = READ_ONLY_REPAIR_TOOLS.filter((tool) =>
    allowedNames.has(tool?.function?.name)
  );
  const turn = await runTurn({ tools: repairTools });
  const repairedEvaluations = evaluateProviderToolCalls(turn?.toolCalls);
  const repairedToolNames = repairedEvaluations
    .map((evaluation) => String(evaluation?.tool_name || ""))
    .sort();
  const repaired =
    repairedEvaluations.length > 0 &&
    repairedEvaluations.every((evaluation) => evaluation?.ok) &&
    repairedToolNames.length === originalToolNames.length &&
    repairedToolNames.every(
      (toolName, index) => toolName === originalToolNames[index]
    );

  return {
    attempted: true,
    repaired,
    turn,
    evaluations: repaired ? repairedEvaluations : evaluations,
  };
}
