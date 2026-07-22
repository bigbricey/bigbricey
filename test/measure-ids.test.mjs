import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalMeasureId,
  defaultUnitForMeasure,
} from "../api/_measure_ids.js";
import { actionFromValidatedToolCall } from "../api/_native_tool_loop.js";

test("standard tracker aliases bind to canonical ledger measurements", () => {
  assert.equal(canonicalMeasureId("magnesium_mg"), "magnesium");
  assert.equal(canonicalMeasureId("Potassium (mg)"), "potassium");
  assert.equal(canonicalMeasureId("body weight"), "weight_lb");
  assert.equal(canonicalMeasureId("my_custom_metric"), "my_custom_metric");
  assert.equal(defaultUnitForMeasure("magnesium_mg"), "mg");
});

test("validated tracker actions canonicalize model aliases before persistence", () => {
  const action = actionFromValidatedToolCall({
    ok: true,
    status: "ready",
    tool_call_id: "call_magnesium_chart",
    tool_name: "set_tracker",
    arguments: {
      kind: "chart",
      title: "Magnesium (30-Day)",
      measure_id: "magnesium_mg",
      unit: "mg",
      days: 30,
      chart: "line",
    },
  });
  assert.equal(action.measure_id, "magnesium");
  assert.equal(action.type, "set_chart");
});
