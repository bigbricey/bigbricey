import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { logEvent, normalizeEventWrite } from "../api/_supabase.js";

test("non-food events are written by one locked, least-privilege RPC", async () => {
  const migration = await readFile(
    new URL("../supabase/migration_010_atomic_food_sync.sql", import.meta.url),
    "utf8"
  );

  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.log_event_atomic/i);
  assert.match(
    migration,
    /public\.log_event_atomic[\s\S]+?SECURITY DEFINER[\s\S]+?SET search_path\s*=\s*pg_catalog, public/i
  );
  assert.match(
    migration,
    /pg_advisory_xact_lock\([\s\S]+?v_email[\s\S]+?v_client_id/i
  );
  assert.match(
    migration,
    /v_previous_day\s*<\s*p_day[\s\S]+?'day:'\s*\|\|\s*v_email[\s\S]+?'day:'\s*\|\|\s*v_email/i
  );
  assert.match(
    migration,
    /sync_food_day_atomic[\s\S]+?hashtextextended\('day:'\s*\|\|\s*v_email/i
  );
  assert.match(migration, /lower\(trim\(p_category_id\)\)\s*=\s*'food'/i);
  assert.match(migration, /jsonb_array_length\(p_measures\)\s*>\s*100/i);
  assert.match(migration, /octet_length\(p_payload::TEXT\)\s*>\s*65536/i);
  assert.match(migration, /v_previous_day[\s\S]+?recompute_day_totals/i);
  assert.match(
    migration,
    /row_number\(\)\s+over\s*\(\s*partition by\s+e\.user_email,\s*e\.client_id/i
  );
  assert.match(
    migration,
    /CREATE UNIQUE INDEX[^;]+events[^;]+user_email,\s*client_id[^;]+category_id\s*<>\s*'food'/i
  );
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.log_event_atomic/i);
  assert.match(
    migration,
    /GRANT EXECUTE ON FUNCTION public\.log_event_atomic[^;]+TO service_role/i
  );
});

test("logEvent sends the event and all measures through one atomic RPC", async () => {
  const calls = [];
  const priorFetch = globalThis.fetch;
  const priorUrl = process.env.SUPABASE_URL;
  const priorKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";

  globalThis.fetch = async (url, options = {}) => {
    const parsedBody = options.body ? JSON.parse(options.body) : null;
    calls.push({ url: String(url), method: options.method || "GET", body: parsedBody });

    if (String(url).includes("/rest/v1/profiles")) {
      return new Response(JSON.stringify([{ email: "person@example.com" }]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (String(url).includes("/rest/v1/rpc/log_event_atomic")) {
      return new Response(
        JSON.stringify({
          ok: true,
          event_id: "00000000-0000-4000-8000-000000000001",
          day: "2026-07-13",
          created: true,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    if (String(url).includes("/rest/v1/life_nodes")) {
      throw new Error("optional life graph is offline");
    }

    return new Response(JSON.stringify([]), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    const result = await logEvent("Person@Example.com", {
      categoryId: "exercise",
      categoryLabel: "Exercise",
      categoryKind: "exercise",
      title: "Bench press",
      rawText: "3 sets of 8 at 185",
      dayKey: "2026-07-13",
      occurredAt: "2026-07-13T14:00:00.000Z",
      payload: { exercise: "bench press" },
      measures: [
        { measure_id: "sets", label: "Sets", value: 3, unit: "sets" },
        { measure_id: "reps", label: "Reps", value: 8, unit: "reps" },
        { measure_id: "load_lb", label: "Load", value: 185, unit: "lb" },
      ],
      clientId: "request-123",
      source: "chat",
    });

    assert.equal(result.ok, true);
    const transactionCalls = calls.filter((call) =>
      call.url.includes("/rest/v1/rpc/log_event_atomic")
    );
    assert.equal(transactionCalls.length, 1);
    assert.deepEqual(transactionCalls[0].body, {
      p_email: "person@example.com",
      p_category_id: "exercise",
      p_category_label: "Exercise",
      p_category_kind: "exercise",
      p_title: "Bench press",
      p_raw_text: "3 sets of 8 at 185",
      p_day: "2026-07-13",
      p_occurred_at: "2026-07-13T14:00:00.000Z",
      p_payload: { exercise: "bench press" },
      p_measures: [
        {
          measure_id: "sets",
          label: "Sets",
          value: 3,
          unit: "sets",
          group: "other",
        },
        {
          measure_id: "reps",
          label: "Reps",
          value: 8,
          unit: "reps",
          group: "other",
        },
        {
          measure_id: "load_lb",
          label: "Load",
          value: 185,
          unit: "lb",
          group: "other",
        },
      ],
      p_client_id: "request-123",
      p_source: "chat",
    });

    assert.equal(
      calls.some((call) => /\/rest\/v1\/(events|event_measures)(?:\?|$)/.test(call.url)),
      false,
      "event state must not be split across REST writes"
    );
    assert.equal(
      calls.some((call) => call.url.includes("/rpc/ensure_category")),
      false,
      "category creation belongs inside the transaction"
    );
    assert.equal(
      calls.some((call) => call.url.includes("/rpc/ensure_measure")),
      false,
      "measure creation belongs inside the transaction"
    );
  } finally {
    globalThis.fetch = priorFetch;
    if (priorUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = priorUrl;
    if (priorKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = priorKey;
  }
});

test("logEvent rejects oversized and non-finite measures before any network call", async () => {
  const priorFetch = globalThis.fetch;
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;
    throw new Error("network should not be reached");
  };

  try {
    await assert.rejects(
      () =>
        logEvent("person@example.com", {
          categoryId: "exercise",
          title: "Too many measurements",
          dayKey: "2026-07-13",
          measures: Array.from({ length: 101 }, (_, i) => ({
            measure_id: `metric_${i}`,
            value: i,
          })),
        }),
      (error) => error?.code === "too_many_event_measures" && error?.status === 400
    );

    await assert.rejects(
      () =>
        logEvent("person@example.com", {
          categoryId: "body",
          title: "Invalid weight",
          dayKey: "2026-07-13",
          measures: [{ measure_id: "weight_lb", value: Number.NaN, unit: "lb" }],
        }),
      (error) => error?.code === "invalid_measure_value" && error?.status === 400
    );

    assert.equal(fetchCount, 0);
  } finally {
    globalThis.fetch = priorFetch;
  }
});

test("logEvent fails closed when the database does not return a committed receipt", async () => {
  const priorFetch = globalThis.fetch;
  const priorUrl = process.env.SUPABASE_URL;
  const priorKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";

  globalThis.fetch = async (url) => {
    if (String(url).includes("/rest/v1/profiles")) {
      return new Response(JSON.stringify([{ email: "person@example.com" }]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (String(url).includes("/rest/v1/rpc/log_event_atomic")) {
      return new Response(JSON.stringify({ ok: false }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    throw new Error("life graph must not run without a verified event receipt");
  };

  try {
    await assert.rejects(
      () =>
        logEvent("person@example.com", {
          categoryId: "steps",
          title: "5000 steps",
          dayKey: "2026-07-13",
          measures: [{ measure_id: "steps", value: 5000, unit: "steps" }],
          clientId: "steps:2026-07-13",
        }),
      (error) => error?.code === "event_write_unverified" && error?.status === 502
    );
  } finally {
    globalThis.fetch = priorFetch;
    if (priorUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = priorUrl;
    if (priorKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = priorKey;
  }
});

test("externally retryable events require a stable client ID", () => {
  assert.throws(
    () =>
      normalizeEventWrite("person@example.com", {
        categoryId: "exercise",
        title: "Bench press",
        dayKey: "2026-07-13",
        measures: [],
        source: "chat",
      }),
    (error) => error?.code === "event_client_id_required" && error?.status === 400
  );

  const onboarding = normalizeEventWrite("person@example.com", {
    categoryId: "body",
    title: "Starting weight",
    dayKey: "2026-07-13",
    measures: [{ measure_id: "weight_lb", value: 200, unit: "lb" }],
    source: "onboarding",
  });
  assert.equal(onboarding.clientId, "onboarding:body:starting");
});

test("an idempotent retry does not increment the optional life graph", async () => {
  const priorFetch = globalThis.fetch;
  const priorUrl = process.env.SUPABASE_URL;
  const priorKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
  let lifeNodeCalls = 0;

  globalThis.fetch = async (url) => {
    if (String(url).includes("/rest/v1/profiles")) {
      return new Response(JSON.stringify([{ email: "person@example.com" }]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (String(url).includes("/rest/v1/rpc/log_event_atomic")) {
      return new Response(
        JSON.stringify({
          ok: true,
          event_id: "00000000-0000-4000-8000-000000000001",
          day: "2026-07-13",
          created: false,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    if (String(url).includes("/rest/v1/life_nodes")) lifeNodeCalls += 1;
    return new Response(JSON.stringify([]), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    await logEvent("person@example.com", {
      categoryId: "steps",
      title: "5000 steps",
      dayKey: "2026-07-13",
      measures: [{ measure_id: "steps", value: 5000, unit: "steps" }],
      clientId: "steps:2026-07-13",
    });
    assert.equal(lifeNodeCalls, 0);
  } finally {
    globalThis.fetch = priorFetch;
    if (priorUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = priorUrl;
    if (priorKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = priorKey;
  }
});
