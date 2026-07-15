import assert from "node:assert/strict";
import test from "node:test";

import {
  foodRowToPayload,
  foodRowsFromEvents,
} from "../api/_supabase.js";

test("saved-food identity survives the real ledger payload round trip", () => {
  const row = {
    id: "chat:request-123:saved_food_continuation",
    label: "2 × Usual breakfast",
    source: "saved",
    saved_food_id: "saved-breakfast",
    kcal: 1220,
    protein: 84,
    fat: 88,
    carbs: 16,
    sugars: 14,
    grams: 710,
    extras: {
      known_nutrients: ["kcal", "protein", "fat", "carbs", "sugars"],
    },
  };
  const payload = foodRowToPayload(row);
  const restored = foodRowsFromEvents([
    {
      id: "event-1",
      client_id: row.id,
      title: row.label,
      payload,
      occurred_at: "2026-07-15T12:00:00.000Z",
    },
  ]);

  assert.equal(payload.saved_food_id, "saved-breakfast");
  assert.equal(restored.length, 1);
  assert.equal(restored[0].id, row.id);
  assert.equal(restored[0].source, "saved");
  assert.equal(restored[0].saved_food_id, "saved-breakfast");
  assert.equal(restored[0].label, row.label);
  assert.equal(restored[0].kcal, 1220);
  assert.equal(payload.grams, 710);
  assert.equal(payload.macros.sugars, 14);
  assert.equal(restored[0].grams, 710);
  assert.equal(restored[0].sugars, 14);
});
