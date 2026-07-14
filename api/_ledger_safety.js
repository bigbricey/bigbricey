function requestError(code, message, status) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

/**
 * A full-day replacement is destructive when the replacement is empty.
 * Only a caller that deliberately sends { rows: [], clear: true } may clear it.
 */
export function validateFoodDaySyncRequest(body) {
  if (!body || typeof body !== "object" || !Array.isArray(body.rows)) {
    throw requestError("rows_required", "A rows array is required.", 400);
  }
  if (body.rows.length === 0 && body.clear !== true) {
    throw requestError(
      "explicit_clear_required",
      "Clearing a food day requires an explicit confirmation.",
      409
    );
  }
  return { rows: body.rows, allowClear: body.clear === true };
}

export function assertFoodDayMayBeCleared(rows, allowClear) {
  if (!Array.isArray(rows)) {
    throw requestError("rows_required", "A rows array is required.", 400);
  }
  if (rows.length === 0 && allowClear !== true) {
    throw requestError(
      "explicit_clear_required",
      "Clearing a food day requires an explicit confirmation.",
      409
    );
  }
}
