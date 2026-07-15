import assert from "node:assert/strict";
import test from "node:test";

import { executeSavedFoodContinuation } from "../api/_saved_food_continuation.js";

const savedBreakfast = {
  id: "saved-breakfast",
  name: "Usual breakfast",
  kcal: 610,
  protein: 42,
  fat: 44,
  carbs: 8,
};

function baseInput(overrides = {}) {
  return {
    email: "person@example.com",
    day: "2026-07-15",
    rawText: "Log my usual breakfast",
    requestId: "request-123",
    toolCallId: "call-456",
    savedFoodId: savedBreakfast.id,
    allowedSavedFoodIds: [savedBreakfast.id],
    servings: 2,
    rows: [{ id: "existing-row", label: "Coffee", kcal: 5 }],
    expectedRevision: 7,
    authoritativeRowsLoaded: true,
    findSavedFoodById: async () => savedBreakfast,
    rowFromSavedFood: (saved, servings) => ({
      label: servings === 1 ? saved.name : `${servings} × ${saved.name}`,
      source: "saved",
      saved_food_id: saved.id,
      kcal: saved.kcal * servings,
    }),
    syncFoodDay: async () => ({ revision: 8 }),
    loadFoodDaySnapshot: async () => ({ rows: [], revision: 0 }),
    ...overrides,
  };
}

test("commits an exact saved-food id against the authoritative ledger revision", async () => {
  const calls = { find: [], sync: [] };
  const result = await executeSavedFoodContinuation(
    baseInput({
      stableRowId: "chat:request-123:call-456",
      findSavedFoodById: async (...args) => {
        calls.find.push(args);
        return savedBreakfast;
      },
      syncFoodDay: async (...args) => {
        calls.sync.push(args);
        return { revision: 8 };
      },
    })
  );

  assert.deepEqual(calls.find, [["person@example.com", "saved-breakfast"]]);
  assert.equal(calls.sync.length, 1);
  assert.equal(calls.sync[0][0], "person@example.com");
  assert.equal(calls.sync[0][1], "2026-07-15");
  assert.deepEqual(calls.sync[0][2], result.rows);
  assert.deepEqual(calls.sync[0][3], {
    rawText: "Log my usual breakfast",
    allowClear: false,
    expectedRevision: 7,
  });
  assert.deepEqual(result, {
    status: "success",
    changed: true,
    committed: true,
    reloaded: false,
    rows: [
      { id: "existing-row", label: "Coffee", kcal: 5 },
      {
        id: "chat:request-123:call-456",
        label: "2 × Usual breakfast",
        source: "saved",
        saved_food_id: "saved-breakfast",
        kcal: 1220,
      },
    ],
    revision: 8,
    notes: ["Added saved: 2 × Usual breakfast"],
    data: {
      saved_food: { id: "saved-breakfast", name: "Usual breakfast" },
      servings: 2,
      row_id: "chat:request-123:call-456",
    },
    error: null,
  });
});

test("requires an authoritative ledger before looking up or syncing food", async () => {
  let lookupCount = 0;
  let syncCount = 0;
  const originalRows = [{ id: "existing-row", label: "Coffee" }];

  const result = await executeSavedFoodContinuation(
    baseInput({
      rows: originalRows,
      authoritativeRowsLoaded: false,
      findSavedFoodById: async () => {
        lookupCount += 1;
        return savedBreakfast;
      },
      syncFoodDay: async () => {
        syncCount += 1;
        return { revision: 8 };
      },
    })
  );

  assert.equal(lookupCount, 0);
  assert.equal(syncCount, 0);
  assert.equal(result.status, "error");
  assert.equal(result.changed, false);
  assert.equal(result.committed, false);
  assert.equal(result.reloaded, false);
  assert.deepEqual(result.rows, originalRows);
  assert.equal(result.revision, 7);
  assert.equal(result.error.code, "food_ledger_unavailable");
});

test("rejects a missing saved-food id without a lookup or sync", async () => {
  let lookupCount = 0;
  let syncCount = 0;
  const result = await executeSavedFoodContinuation(
    baseInput({
      savedFoodId: "   ",
      findSavedFoodById: async () => {
        lookupCount += 1;
        return savedBreakfast;
      },
      syncFoodDay: async () => {
        syncCount += 1;
        return { revision: 8 };
      },
    })
  );

  assert.equal(lookupCount, 0);
  assert.equal(syncCount, 0);
  assert.equal(result.status, "error");
  assert.equal(result.error.code, "saved_food_id_required");
  assert.equal(result.committed, false);
});

test("rejects an id that was not in the verified saved-food read", async () => {
  let lookupCount = 0;
  let syncCount = 0;
  const result = await executeSavedFoodContinuation(
    baseInput({
      allowedSavedFoodIds: ["some-other-food"],
      findSavedFoodById: async () => {
        lookupCount += 1;
        return savedBreakfast;
      },
      syncFoodDay: async () => {
        syncCount += 1;
        return { revision: 8 };
      },
    })
  );

  assert.equal(lookupCount, 0);
  assert.equal(syncCount, 0);
  assert.equal(result.status, "error");
  assert.equal(result.error.code, "saved_food_not_in_verified_read");
});

test("rejects an invalid serving count instead of silently changing it to one", async () => {
  let lookupCount = 0;
  let syncCount = 0;
  const result = await executeSavedFoodContinuation(
    baseInput({
      servings: 0,
      findSavedFoodById: async () => {
        lookupCount += 1;
        return savedBreakfast;
      },
      syncFoodDay: async () => {
        syncCount += 1;
        return { revision: 8 };
      },
    })
  );

  assert.equal(lookupCount, 0);
  assert.equal(syncCount, 0);
  assert.equal(result.status, "error");
  assert.equal(result.error.code, "saved_food_servings_invalid");
});

test("does not sync when the exact saved-food id no longer exists", async () => {
  let syncCount = 0;
  const result = await executeSavedFoodContinuation(
    baseInput({
      findSavedFoodById: async () => null,
      syncFoodDay: async () => {
        syncCount += 1;
        return { revision: 8 };
      },
    })
  );

  assert.equal(syncCount, 0);
  assert.equal(result.status, "error");
  assert.equal(result.error.code, "saved_food_not_found");
  assert.equal(result.changed, false);
  assert.equal(result.committed, false);
});

test("reloads a stale ledger once and never retries or reports success", async () => {
  const latestRows = [{ id: "other-device-row", label: "Eggs", kcal: 280 }];
  let syncCount = 0;
  let reloadCount = 0;
  const staleError = Object.assign(new Error("stale"), {
    code: "stale_food_day_revision",
  });

  const result = await executeSavedFoodContinuation(
    baseInput({
      syncFoodDay: async () => {
        syncCount += 1;
        throw staleError;
      },
      loadFoodDaySnapshot: async (email, day) => {
        reloadCount += 1;
        assert.equal(email, "person@example.com");
        assert.equal(day, "2026-07-15");
        return { rows: latestRows, revision: 12 };
      },
    })
  );

  assert.equal(syncCount, 1);
  assert.equal(reloadCount, 1);
  assert.deepEqual(result.rows, latestRows);
  assert.equal(result.revision, 12);
  assert.equal(result.status, "error");
  assert.equal(result.changed, false);
  assert.equal(result.committed, false);
  assert.equal(result.reloaded, true);
  assert.equal(result.error.code, "stale_food_day_revision");
});

test("reusing the same request row id replaces that row instead of duplicating it", async () => {
  const stableRowId = "chat:request-123:call-456";
  let syncedRows;
  const result = await executeSavedFoodContinuation(
    baseInput({
      stableRowId,
      rows: [
        { id: "existing-row", label: "Coffee", kcal: 5 },
        { id: stableRowId, label: "Old retry row", kcal: 1 },
      ],
      syncFoodDay: async (_email, _day, rows) => {
        syncedRows = rows;
        return { revision: 8 };
      },
    })
  );

  assert.equal(
    syncedRows.filter((row) => row.id === stableRowId).length,
    1
  );
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[1].label, "2 × Usual breakfast");
});

test("derived continuation row ids are capped at the ledger's 200-character limit", async () => {
  const result = await executeSavedFoodContinuation(
    baseInput({
      stableRowId: undefined,
      requestId: "r".repeat(180),
      toolCallId: "t".repeat(180),
    })
  );

  assert.equal(result.data.row_id.length, 200);
  assert.equal(result.rows.at(-1).id, result.data.row_id);
  assert.ok(result.data.row_id.startsWith("chat:"));
});

test("replayed requests keep one row id even when the provider changes tool-call ids", async () => {
  const first = await executeSavedFoodContinuation(
    baseInput({ stableRowId: undefined, toolCallId: "provider-call-one" })
  );
  const second = await executeSavedFoodContinuation(
    baseInput({ stableRowId: undefined, toolCallId: "provider-call-two" })
  );

  assert.equal(first.data.row_id, second.data.row_id);
  assert.equal(
    first.data.row_id,
    "chat:request-123:saved_food_continuation"
  );
});

test("reloads and verifies the stable row when the sync receipt lacks a revision", async () => {
  const stableRowId = "chat:request-123:call-456";
  const committedRow = {
    id: stableRowId,
    label: "2 × Usual breakfast",
    source: "saved",
    kcal: 1220,
    saved_food_id: savedBreakfast.id,
  };
  const result = await executeSavedFoodContinuation(
    baseInput({
      stableRowId,
      syncFoodDay: async () => ({}),
      loadFoodDaySnapshot: async () => ({
        rows: [{ id: "existing-row", label: "Coffee", kcal: 5 }, committedRow],
        revision: 8,
      }),
    })
  );

  assert.equal(result.status, "success");
  assert.equal(result.committed, true);
  assert.equal(result.reloaded, true);
  assert.equal(result.revision, 8);
  assert.deepEqual(result.rows.at(-1), committedRow);
});

test("does not claim a commit when an invalid receipt cannot be verified", async () => {
  const latestRows = [{ id: "existing-row", label: "Coffee", kcal: 5 }];
  const result = await executeSavedFoodContinuation(
    baseInput({
      syncFoodDay: async () => ({}),
      loadFoodDaySnapshot: async () => ({ rows: latestRows, revision: 8 }),
    })
  );

  assert.equal(result.status, "error");
  assert.equal(result.committed, false);
  assert.equal(result.reloaded, true);
  assert.equal(result.error.code, "food_day_commit_unverified");
  assert.deepEqual(result.rows, latestRows);
});

test("does not verify an older row with the right ids but the wrong serving content", async () => {
  const stableRowId = "chat:request-123:saved_food_continuation";
  const result = await executeSavedFoodContinuation(
    baseInput({
      stableRowId,
      syncFoodDay: async () => ({}),
      loadFoodDaySnapshot: async () => ({
        rows: [
          {
            id: stableRowId,
            saved_food_id: savedBreakfast.id,
            source: "saved",
            label: "Usual breakfast",
            kcal: 610,
          },
        ],
        revision: 8,
      }),
    })
  );

  assert.equal(result.status, "error");
  assert.equal(result.error.code, "food_day_commit_unverified");
});

test("does not verify a row when persisted extras differ", async () => {
  const stableRowId = "chat:request-123:saved_food_continuation";
  const result = await executeSavedFoodContinuation(
    baseInput({
      stableRowId,
      rowFromSavedFood: (saved, servings) => ({
        label: `${servings} × ${saved.name}`,
        kcal: saved.kcal * servings,
        extras: { ingredients: ["egg", "butter"], meal: "breakfast" },
      }),
      syncFoodDay: async () => ({}),
      loadFoodDaySnapshot: async () => ({
        rows: [
          {
            id: stableRowId,
            saved_food_id: savedBreakfast.id,
            source: "saved",
            label: "2 × Usual breakfast",
            kcal: 1220,
            extras: { ingredients: ["egg"], meal: "breakfast" },
          },
        ],
        revision: 8,
      }),
    })
  );

  assert.equal(result.status, "error");
  assert.equal(result.error.code, "food_day_commit_unverified");
});

test("does not verify a row missing its known portion weight or sugar", async () => {
  const stableRowId = "chat:request-123:saved_food_continuation";
  const result = await executeSavedFoodContinuation(
    baseInput({
      stableRowId,
      rowFromSavedFood: (saved, servings) => ({
        label: `${servings} × ${saved.name}`,
        kcal: saved.kcal * servings,
        grams: 710,
        sugars: 14,
      }),
      syncFoodDay: async () => ({}),
      loadFoodDaySnapshot: async () => ({
        rows: [
          {
            id: stableRowId,
            saved_food_id: savedBreakfast.id,
            source: "saved",
            label: "2 × Usual breakfast",
            kcal: 1220,
          },
        ],
        revision: 8,
      }),
    })
  );

  assert.equal(result.status, "error");
  assert.equal(result.error.code, "food_day_commit_unverified");
});
