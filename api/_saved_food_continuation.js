function safeRows(rows) {
  return Array.isArray(rows) ? rows : [];
}

function safeRevision(value) {
  const revision = Number(value);
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : null;
}

const PERSISTED_ROW_FIELDS = Object.freeze([
  "label",
  "source",
  "saved_food_id",
  "amount",
  "unit",
  "grams",
  "kcal",
  "protein",
  "fat",
  "carbs",
  "fiber",
  "sugars",
  "potassium",
  "magnesium",
  "sodium",
  "calcium",
  "iron",
  "zinc",
  "vitamin_a",
  "vitamin_c",
  "vitamin_d",
  "vitamin_e",
  "vitamin_k",
  "b12",
  "folate",
  "omega3",
]);

function canonicalPersistedValue(value) {
  if (value == null) return null;
  if (Array.isArray(value)) {
    return value.map((item) => canonicalPersistedValue(item));
  }
  if (typeof value === "object") {
    return Object.keys(value)
      .sort()
      .reduce((out, key) => {
        if (value[key] !== undefined) {
          out[key] = canonicalPersistedValue(value[key]);
        }
        return out;
      }, {});
  }
  return value;
}

function samePersistedRow(actual, expected) {
  if (!actual || !expected || String(actual.id || "") !== String(expected.id || "")) {
    return false;
  }
  const sameScalars = PERSISTED_ROW_FIELDS.every((key) => {
    const left = actual[key];
    const right = expected[key];
    if (left == null || left === "") return right == null || right === "";
    if (right == null || right === "") return false;
    if (typeof right === "number") {
      return Number.isFinite(Number(left)) && Number(left) === right;
    }
    return String(left) === String(right);
  });
  if (!sameScalars) return false;
  return (
    JSON.stringify(canonicalPersistedValue(actual.extras)) ===
    JSON.stringify(canonicalPersistedValue(expected.extras))
  );
}

function errorReceipt({
  rows,
  revision,
  code,
  message,
  notes,
  reloaded = false,
}) {
  return {
    status: "error",
    changed: false,
    committed: false,
    reloaded,
    rows: safeRows(rows),
    revision: safeRevision(revision),
    notes: Array.isArray(notes) && notes.length ? notes : [message],
    data: null,
    error: { code, message, retryable: false },
  };
}

/**
 * Commit the one safe list_saved_foods -> log_saved_food continuation.
 *
 * The caller must bind savedFoodId to the preceding verified list result. This
 * helper deliberately accepts no name/query fallback: it re-fetches that exact
 * account-scoped id, writes against the authoritative day revision once, and
 * reloads rather than retrying when the revision is stale.
 */
export async function executeSavedFoodContinuation({
  email,
  day,
  rawText,
  requestId,
  stableRowId,
  savedFoodId,
  allowedSavedFoodIds = [],
  servings = 1,
  rows = [],
  expectedRevision,
  authoritativeRowsLoaded = false,
  findSavedFoodById,
  rowFromSavedFood,
  syncFoodDay,
  loadFoodDaySnapshot,
} = {}) {
  const originalRows = safeRows(rows);
  const originalRevision = safeRevision(expectedRevision);

  if (!authoritativeRowsLoaded || !Array.isArray(rows)) {
    return errorReceipt({
      rows: originalRows,
      revision: originalRevision,
      code: "food_ledger_unavailable",
      message: "The food log is temporarily unavailable, so nothing was changed.",
    });
  }

  if (originalRevision == null) {
    return errorReceipt({
      rows: originalRows,
      revision: originalRevision,
      code: "food_day_revision_required",
      message: "Reload the food day before changing it.",
    });
  }

  const exactSavedFoodId = String(savedFoodId || "").trim();
  if (!exactSavedFoodId) {
    return errorReceipt({
      rows: originalRows,
      revision: originalRevision,
      code: "saved_food_id_required",
      message: "No exact saved food was selected, so nothing was changed.",
    });
  }

  const verifiedSavedFoodIds = new Set(
    (Array.isArray(allowedSavedFoodIds) ? allowedSavedFoodIds : [])
      .map((id) => String(id || "").trim())
      .filter(Boolean)
  );
  if (!verifiedSavedFoodIds.has(exactSavedFoodId)) {
    return errorReceipt({
      rows: originalRows,
      revision: originalRevision,
      code: "saved_food_not_in_verified_read",
      message:
        "That saved food was not in the verified list, so nothing was changed.",
    });
  }

  const servingCount = Number(servings);
  if (
    !Number.isFinite(servingCount) ||
    servingCount < 0.001 ||
    servingCount > 1000
  ) {
    return errorReceipt({
      rows: originalRows,
      revision: originalRevision,
      code: "saved_food_servings_invalid",
      message: "The serving amount was invalid, so nothing was changed.",
    });
  }

  const requestPart = String(requestId || "").trim();
  const derivedRowId = requestPart
    ? `chat:${requestPart}:saved_food_continuation`
    : "";
  const rowId = String(stableRowId || derivedRowId).trim().slice(0, 200);
  if (!rowId) {
    return errorReceipt({
      rows: originalRows,
      revision: originalRevision,
      code: "saved_food_row_id_required",
      message: "This saved-food request could not be identified safely.",
    });
  }

  let saved;
  try {
    saved = await findSavedFoodById(email, exactSavedFoodId);
  } catch {
    return errorReceipt({
      rows: originalRows,
      revision: originalRevision,
      code: "saved_food_lookup_failed",
      message: "The saved food could not be loaded, so nothing was changed.",
    });
  }

  if (!saved || String(saved.id || "").trim() !== exactSavedFoodId) {
    return errorReceipt({
      rows: originalRows,
      revision: originalRevision,
      code: "saved_food_not_found",
      message: "That exact saved food is no longer available, so nothing was changed.",
    });
  }

  let savedRow;
  try {
    const builtRow = rowFromSavedFood(saved, servingCount);
    if (!builtRow || typeof builtRow !== "object" || Array.isArray(builtRow)) {
      throw new Error("invalid saved-food row");
    }
    savedRow = {
      ...builtRow,
      id: rowId,
      source: "saved",
      saved_food_id: exactSavedFoodId,
    };
  } catch {
    return errorReceipt({
      rows: originalRows,
      revision: originalRevision,
      code: "saved_food_row_failed",
      message: "That saved food could not be prepared safely, so nothing was changed.",
    });
  }

  const nextRows = [
    ...originalRows.filter((row) => String(row?.id || "") !== rowId),
    savedRow,
  ];

  try {
    const receipt = await syncFoodDay(email, day, nextRows, {
      rawText,
      allowClear: false,
      expectedRevision: originalRevision,
    });
    const committedRevision = safeRevision(receipt?.revision);
    const savedName = String(saved.name || "Saved food").trim() || "Saved food";
    if (committedRevision == null || committedRevision <= originalRevision) {
      try {
        const latest = await loadFoodDaySnapshot(email, day);
        const latestRevision = safeRevision(latest?.revision);
        const latestRows = safeRows(latest?.rows);
        const verifiedRow = latestRows.some((row) =>
          samePersistedRow(row, savedRow)
        );
        if (!Array.isArray(latest?.rows) || latestRevision == null || !verifiedRow) {
          return errorReceipt({
            rows: latestRows,
            revision: latestRevision,
            reloaded: true,
            code: "food_day_commit_unverified",
            message:
              "The food log response could not be verified, so the latest day was reloaded.",
          });
        }
        return {
          status: "success",
          changed: true,
          committed: true,
          reloaded: true,
          rows: latestRows,
          revision: latestRevision,
          notes: [
            `Added saved: ${servingCount === 1 ? savedName : `${servingCount} × ${savedName}`}`,
          ],
          data: {
            saved_food: { id: exactSavedFoodId, name: savedName },
            servings: servingCount,
            row_id: rowId,
          },
          error: null,
        };
      } catch {
        return errorReceipt({
          rows: originalRows,
          revision: originalRevision,
          code: "food_day_commit_unverified",
          message:
            "The food log response could not be verified. Reload the day before trying again.",
        });
      }
    }
    return {
      status: "success",
      changed: true,
      committed: true,
      reloaded: false,
      rows: nextRows,
      revision: committedRevision,
      notes: [
        `Added saved: ${servingCount === 1 ? savedName : `${servingCount} × ${savedName}`}`,
      ],
      data: {
        saved_food: { id: exactSavedFoodId, name: savedName },
        servings: servingCount,
        row_id: rowId,
      },
      error: null,
    };
  } catch (error) {
    if (error?.code === "stale_food_day_revision") {
      try {
        const latest = await loadFoodDaySnapshot(email, day);
        if (!Array.isArray(latest?.rows) || safeRevision(latest?.revision) == null) {
          throw new Error("invalid food-day snapshot");
        }
        return errorReceipt({
          rows: latest.rows,
          revision: latest.revision,
          reloaded: true,
          code: "stale_food_day_revision",
          message:
            "This food day changed somewhere else, so it was reloaded and nothing was overwritten. Please try again.",
        });
      } catch {
        return errorReceipt({
          rows: originalRows,
          revision: originalRevision,
          code: "stale_food_day_revision",
          message:
            "This food day changed somewhere else and could not be reloaded. Nothing was overwritten.",
        });
      }
    }

    return errorReceipt({
      rows: originalRows,
      revision: originalRevision,
      code: error?.code || "food_day_sync_failed",
      message: "That saved food could not be safely saved, so nothing was changed.",
    });
  }
}
