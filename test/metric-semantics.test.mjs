import assert from "node:assert/strict";
import test from "node:test";

import {
  latestDailyMeasureSeries,
  measureUsesLatestDailyValue,
} from "../api/_supabase.js";

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_URL = process.env.SUPABASE_URL;
const ORIGINAL_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function restoreEnvironment() {
  globalThis.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_URL === undefined) delete process.env.SUPABASE_URL;
  else process.env.SUPABASE_URL = ORIGINAL_URL;
  if (ORIGINAL_KEY === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  else process.env.SUPABASE_SERVICE_ROLE_KEY = ORIGINAL_KEY;
}

test("body-state metrics use the latest daily reading instead of a sum", async () => {
  process.env.SUPABASE_URL = "https://example.supabase.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
  globalThis.fetch = async (rawUrl) => {
    const url = new URL(rawUrl);
    assert.equal(url.pathname.endsWith("/event_measures"), true);
    assert.equal(url.searchParams.get("user_email"), "eq.brice@example.com");
    assert.equal(url.searchParams.get("measure_id"), "eq.weight_lb");
    assert.equal(url.searchParams.get("events.deleted_at"), "is.null");
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify([
          {
            day_key: "2026-07-13",
            measure_id: "weight_lb",
            value: 220,
            unit: "lb",
            created_at: "2026-07-13T05:00:00Z",
            events: { deleted_at: null, occurred_at: "2026-07-13T05:00:00Z" },
          },
          {
            day_key: "2026-07-13",
            measure_id: "weight_lb",
            value: 215,
            unit: "lb",
            created_at: "2026-07-13T18:00:00Z",
            events: { deleted_at: null, occurred_at: "2026-07-13T18:00:00Z" },
          },
          {
            day_key: "2026-07-14",
            measure_id: "weight_lb",
            value: 214,
            unit: "lb",
            created_at: "2026-07-14T08:00:00Z",
            events: { deleted_at: null, occurred_at: "2026-07-14T08:00:00Z" },
          },
          {
            day_key: "2026-07-14",
            measure_id: "weight_lb",
            value: 999,
            unit: "lb",
            created_at: "2026-07-14T09:00:00Z",
            events: { deleted_at: "2026-07-14T09:01:00Z", occurred_at: "2026-07-14T09:00:00Z" },
          },
        ]);
      },
    };
  };

  try {
    assert.equal(measureUsesLatestDailyValue("weight_lb"), true);
    assert.equal(measureUsesLatestDailyValue("steps"), false);
    const series = await latestDailyMeasureSeries(
      "Brice@Example.com",
      "weight_lb",
      "2026-07-01",
      "2026-07-14"
    );
    assert.deepEqual(series, [
      {
        day_key: "2026-07-13",
        measure_id: "weight_lb",
        total: 215,
        unit: "lb",
      },
      {
        day_key: "2026-07-14",
        measure_id: "weight_lb",
        total: 214,
        unit: "lb",
      },
    ]);
  } finally {
    restoreEnvironment();
  }
});
