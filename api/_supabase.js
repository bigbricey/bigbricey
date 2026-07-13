/**
 * Supabase REST helper (service role — server only).
 * Never expose SUPABASE_SERVICE_ROLE_KEY to the browser.
 */

export function supabaseConfig() {
  const url = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_KEY ||
    "";
  return { url, key, ok: Boolean(url && key) };
}

export async function sb(path, { method = "GET", body, query, headers } = {}) {
  const { url, key, ok } = supabaseConfig();
  if (!ok) {
    const err = new Error("supabase_not_configured");
    err.code = "supabase_not_configured";
    throw err;
  }
  const qs = query
    ? "?" +
      Object.entries(query)
        .filter(([, v]) => v !== undefined && v !== null)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join("&")
    : "";
  const res = await fetch(`${url}/rest/v1/${path}${qs}`, {
    method,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Prefer: headers?.Prefer || "return=representation",
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const err = new Error(
      typeof data === "object" && data?.message
        ? data.message
        : `supabase_${res.status}: ${text.slice(0, 300)}`
    );
    err.status = res.status;
    err.detail = data;
    throw err;
  }
  return data;
}

export async function sbRpc(fn, args = {}) {
  const { url, key, ok } = supabaseConfig();
  if (!ok) throw new Error("supabase_not_configured");
  const res = await fetch(`${url}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const err = new Error(
      typeof data === "object" && data?.message
        ? data.message
        : `rpc_${fn}_${res.status}: ${text.slice(0, 300)}`
    );
    err.status = res.status;
    err.detail = data;
    throw err;
  }
  return data;
}

/** YYYY-MM-DD in America/New_York */
export function dayKeyFor(date = new Date(), tz = "America/New_York") {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

export async function ensureProfile(email, { name, picture } = {}) {
  const e = String(email || "").toLowerCase();
  if (!e) return null;
  const existing = await sb("profiles", {
    query: { email: `eq.${e}`, select: "email", limit: "1" },
  });
  if (existing?.length) {
    if (name || picture) {
      await sb("profiles", {
        method: "PATCH",
        query: { email: `eq.${e}` },
        body: {
          ...(name ? { name } : {}),
          ...(picture ? { picture } : {}),
        },
        headers: { Prefer: "return=minimal" },
      });
    }
    return e;
  }
  await sb("profiles", {
    method: "POST",
    body: { email: e, name: name || null, picture: picture || null },
    headers: { Prefer: "return=minimal,resolution=merge-duplicates" },
  });
  return e;
}

/** Full profile row (prefs includes onboarding). */
export async function getProfile(email) {
  const e = String(email || "").toLowerCase();
  if (!e) return null;
  const rows = await sb("profiles", {
    query: {
      email: `eq.${e}`,
      select: "email,name,picture,timezone,prefs,created_at,updated_at",
      limit: "1",
    },
  });
  return rows?.[0] || null;
}

/**
 * Onboarding lives in profiles.prefs.onboarding (no schema migration needed).
 * complete === true means the user finished the Lose It-style intake.
 */
export function onboardingFromPrefs(prefs) {
  const p = prefs && typeof prefs === "object" ? prefs : {};
  const o = p.onboarding && typeof p.onboarding === "object" ? p.onboarding : {};
  // Normalize legacy "gain" → muscle (we don't coach getting fat)
  let primary = o.primary_goal || null;
  if (primary === "gain") primary = "muscle";
  return {
    complete: Boolean(o.complete),
    consent_health: Boolean(o.consent_health),
    consent_marketing: Boolean(o.consent_marketing),
    consented_at: o.consented_at || null,
    first_name: o.first_name || null,
    primary_goal: primary,
    lose_rate_lb_week:
      o.lose_rate_lb_week != null ? Number(o.lose_rate_lb_week) : null,
    activity_level: o.activity_level || null,
    training_level: o.training_level || null,
    eating_style: o.eating_style || null,
    obstacles: Array.isArray(o.obstacles) ? o.obstacles : [],
    confidence: o.confidence || null,
    birthday: o.birthday || null,
    sex: o.sex || null,
    height_in: o.height_in ?? null,
    current_weight_lb: o.current_weight_lb ?? null,
    goal_weight_lb: o.goal_weight_lb ?? null,
    kcal_confirmed: o.kcal_confirmed != null ? Number(o.kcal_confirmed) : null,
    goals: o.goals && typeof o.goals === "object" ? o.goals : null,
    completed_at: o.completed_at || null,
  };
}

/** Activity multipliers (PAL-style) — must ask the user; never assume desk life. */
export const ACTIVITY_FACTORS = {
  sedentary: 1.2, // sit most of the day
  light: 1.375, // light walking / standing sometimes
  moderate: 1.55, // on feet a lot OR regular training
  high: 1.725, // manual labor, heat, high steps, hard job
  extreme: 1.9, // all-day heavy work + training, massive burn
};

export const TRAINING_BONUS = {
  none: 0,
  few: 0.05, // 1–2 days/week
  most: 0.1, // most days
  twice: 0.15, // 2×/day or very high training load
};

/** Absolute product floors — never recommend crash targets as a "diet". */
export function calorieFloor(sex) {
  // Adult safety rails used by many trackers (~1200 women / ~1500 men).
  // We use higher product floors so we never push semi-fasting as normal.
  return String(sex || "").toLowerCase() === "female" ? 1500 : 1800;
}

/**
 * Estimate targets from onboarding.
 * Activity + training required for a sane TDEE. User-confirmed kcal wins.
 * Formula alone is labeled estimate — never a silent crash diet.
 */
export function computeGoalsFromOnboarding(o) {
  const weightLb = Number(o.current_weight_lb) || 180;
  const goalLb = Number(o.goal_weight_lb) || weightLb;
  const heightIn = Number(o.height_in) || 68;
  const sex = String(o.sex || "male").toLowerCase() === "female" ? "female" : "male";
  let age = 35;
  if (o.birthday) {
    const b = new Date(o.birthday);
    if (!Number.isNaN(b.getTime())) {
      const now = new Date();
      age = Math.max(
        16,
        Math.min(
          100,
          now.getFullYear() -
            b.getFullYear() -
            (now < new Date(now.getFullYear(), b.getMonth(), b.getDate()) ? 1 : 0)
        )
      );
    }
  }
  const kg = weightLb * 0.453592;
  const cm = heightIn * 2.54;
  const bmr = 10 * kg + 6.25 * cm - 5 * age + (sex === "female" ? -161 : 5);

  const actKey = String(o.activity_level || "moderate").toLowerCase();
  const trainKey = String(o.training_level || "none").toLowerCase();
  const act =
    ACTIVITY_FACTORS[actKey] != null ? ACTIVITY_FACTORS[actKey] : ACTIVITY_FACTORS.moderate;
  const train =
    TRAINING_BONUS[trainKey] != null ? TRAINING_BONUS[trainKey] : 0;
  const tdee = Math.round(bmr * (act + train));

  let goal = String(o.primary_goal || "maintain").toLowerCase();
  if (goal === "gain") goal = "muscle";

  const floor = calorieFloor(sex);
  let formulaKcal = tdee;
  const loseRate = Number(o.lose_rate_lb_week);
  const warnings = [];

  if (goal === "lose") {
    // Default 0.5–1 lb/wk; 2 lb/wk is aggressive — still floor-protected
    let rate = [0.5, 1, 1.5, 2].includes(loseRate) ? loseRate : 0.5;
    if (rate >= 2) {
      warnings.push(
        "2 lb/week is aggressive. Long-term very low intake can harm hormones, recovery, and metabolism — treat as short-term only and confirm with a professional."
      );
    }
    const deficit = Math.round((rate * 3500) / 7);
    formulaKcal = tdee - deficit;
  } else if (goal === "muscle") {
    formulaKcal = tdee + 200;
  }

  const formulaRaw = Math.round(formulaKcal);
  let kcal = formulaRaw;
  if (kcal < floor) {
    warnings.push(
      `A plain formula suggested ~${formulaRaw} kcal/day. That is below our safety floor (${floor}). Very low calories are more like a fast than a sustainable plan and can mess with hormones and recovery. We set your starting target to ${floor}+ — you can raise it.`
    );
    kcal = floor;
  }

  // User-confirmed target always wins (still floor-clamped)
  if (o.kcal_confirmed != null && Number(o.kcal_confirmed) > 0) {
    kcal = Math.max(floor, Math.round(Number(o.kcal_confirmed)));
  }

  // Cap absurd upper typos
  if (kcal > 12000) kcal = 12000;

  let proteinAnchor = weightLb;
  if (goal === "lose") proteinAnchor = Math.max(goalLb, weightLb * 0.85);
  else if (goal === "muscle") proteinAnchor = Math.max(weightLb, goalLb);
  const proteinMult = goal === "muscle" || goal === "lose" ? 1.0 : 0.85;
  const protein = Math.round(
    Math.max(100, Math.min(280, proteinAnchor * proteinMult))
  );
  const fat = Math.round(Math.max(60, (kcal * 0.35) / 9));
  const carbs = Math.round(
    Math.max(20, Math.min(400, (kcal - protein * 4 - fat * 9) / 4))
  );

  return {
    kcal,
    protein,
    fat,
    carbs,
    potassium: 3500,
    magnesium: 350,
    bmr: Math.round(bmr),
    tdee,
    formula_kcal: formulaRaw,
    floor_kcal: floor,
    age,
    activity_level: actKey,
    training_level: trainKey,
    lose_rate_lb_week: goal === "lose" ? loseRate || 0.5 : null,
    warnings,
  };
}

export async function saveOnboarding(email, data = {}) {
  const e = String(email || "").toLowerCase();
  if (!e) throw new Error("email required");
  const profile = await getProfile(e);
  const prefs =
    profile?.prefs && typeof profile.prefs === "object" ? { ...profile.prefs } : {};
  const prev =
    prefs.onboarding && typeof prefs.onboarding === "object"
      ? { ...prefs.onboarding }
      : {};

  let primaryGoal = data.primary_goal || prev.primary_goal;
  if (primaryGoal === "gain") primaryGoal = "muscle";

  const next = {
    ...prev,
    first_name: data.first_name != null ? String(data.first_name).trim() : prev.first_name,
    primary_goal: primaryGoal,
    lose_rate_lb_week:
      data.lose_rate_lb_week != null
        ? Number(data.lose_rate_lb_week)
        : primaryGoal === "lose"
          ? prev.lose_rate_lb_week ?? null
          : null,
    activity_level: data.activity_level || prev.activity_level || null,
    training_level: data.training_level || prev.training_level || null,
    eating_style: data.eating_style || prev.eating_style || null,
    obstacles: Array.isArray(data.obstacles)
      ? data.obstacles.map(String)
      : prev.obstacles || [],
    confidence: data.confidence || prev.confidence,
    birthday: data.birthday || prev.birthday,
    sex: data.sex || prev.sex,
    height_in:
      data.height_in != null ? Number(data.height_in) : prev.height_in ?? null,
    current_weight_lb:
      data.current_weight_lb != null
        ? Number(data.current_weight_lb)
        : prev.current_weight_lb ?? null,
    goal_weight_lb:
      data.goal_weight_lb != null
        ? Number(data.goal_weight_lb)
        : prev.goal_weight_lb ?? null,
    kcal_confirmed:
      data.kcal_confirmed != null
        ? Number(data.kcal_confirmed)
        : prev.kcal_confirmed ?? null,
  };

  if (data.consent_health != null) {
    next.consent_health = Boolean(data.consent_health);
  }
  if (data.consent_marketing != null) {
    next.consent_marketing = Boolean(data.consent_marketing);
  }
  if (data.consented_at) {
    next.consented_at = data.consented_at;
  } else if (next.consent_health && !prev.consented_at) {
    next.consented_at = new Date().toISOString();
  }

  const complete = Boolean(data.complete ?? true);
  if (complete) {
    if (!next.consent_health) {
      const err = new Error("consent_required");
      err.status = 400;
      err.message = "Health data consent is required to use the app.";
      throw err;
    }
    next.complete = true;
    next.completed_at = new Date().toISOString();
    if (!next.consented_at) next.consented_at = next.completed_at;
    next.goals = computeGoalsFromOnboarding(next);
  } else {
    next.complete = false;
  }

  prefs.onboarding = next;

  // Prefer first_name on profile.name when set
  const patch = {
    prefs,
    ...(next.first_name ? { name: next.first_name } : {}),
  };

  await sb("profiles", {
    method: "PATCH",
    query: { email: `eq.${e}` },
    body: patch,
    headers: { Prefer: "return=minimal" },
  });

  // Log starting weight into forever ledger when finishing
  if (complete && next.current_weight_lb != null) {
    try {
      await logEvent(e, {
        categoryId: "body",
        categoryLabel: "Body",
        categoryKind: "body",
        title: `Starting weight ${next.current_weight_lb} lb`,
        rawText: "onboarding",
        dayKey: dayKeyFor(),
        payload: { source: "onboarding" },
        measures: [
          {
            measure_id: "weight_lb",
            label: "Body weight",
            value: next.current_weight_lb,
            unit: "lb",
          },
        ],
        source: "onboarding",
      });
    } catch {
      /* non-fatal */
    }
  }

  return onboardingFromPrefs(prefs);
}

const FOOD_MEASURES = [
  "kcal",
  "protein",
  "fat",
  "carbs",
  "fiber",
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
];

const MEASURE_UNITS = {
  kcal: "kcal",
  protein: "g",
  fat: "g",
  carbs: "g",
  fiber: "g",
  potassium: "mg",
  magnesium: "mg",
  sodium: "mg",
  calcium: "mg",
  iron: "mg",
  zinc: "mg",
  vitamin_a: "µg",
  vitamin_c: "mg",
  vitamin_d: "IU",
  vitamin_e: "mg",
  vitamin_k: "µg",
  b12: "µg",
  folate: "µg",
  omega3: "g",
  steps: "steps",
  duration_min: "min",
  distance_mi: "mi",
  weight_lb: "lb",
  reps: "reps",
  sets: "sets",
  load_lb: "lb",
};

export function foodRowToPayload(row) {
  return {
    label: row.label || row.food || "",
    amount: row.amount ?? null,
    unit: row.unit ?? null,
    source: row.source || row.db || null,
    fdcId: row.fdcId || row.fdc_id || null,
    macros: Object.fromEntries(
      FOOD_MEASURES.filter((k) => row[k] != null && row[k] !== "").map((k) => [
        k,
        Number(row[k]) || 0,
      ])
    ),
    extras: row.extras || row.micros || null,
  };
}

export function measuresFromFoodRow(row) {
  const out = [];
  for (const k of FOOD_MEASURES) {
    if (row[k] == null || row[k] === "") continue;
    const v = Number(row[k]);
    if (!Number.isFinite(v)) continue;
    out.push({ measure_id: k, value: v, unit: MEASURE_UNITS[k] || "" });
  }
  // freeform extras { vitamin_d: 1000, ... }
  const extras = row.extras || row.micros || {};
  if (extras && typeof extras === "object") {
    for (const [k, raw] of Object.entries(extras)) {
      const id = String(k)
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, "_");
      const v = Number(raw);
      if (!id || !Number.isFinite(v)) continue;
      if (out.some((m) => m.measure_id === id)) continue;
      out.push({ measure_id: id, value: v, unit: MEASURE_UNITS[id] || "" });
    }
  }
  return out;
}

/**
 * Replace all non-deleted food events for a user/day with the given client rows.
 */
export async function syncFoodDay(email, dayKey, rows, { rawText } = {}) {
  await ensureProfile(email);
  const e = String(email).toLowerCase();

  // Existing food events for the day
  const existing = await sb("events", {
    query: {
      select: "id,client_id",
      user_email: `eq.${e}`,
      day_key: `eq.${dayKey}`,
      category_id: "eq.food",
      deleted_at: "is.null",
    },
  });

  const keepIds = new Set(
    (rows || []).map((r) => String(r.id || r.client_id || "")).filter(Boolean)
  );

  // Soft-delete removed
  for (const ev of existing || []) {
    if (ev.client_id && keepIds.has(String(ev.client_id))) continue;
    if (!ev.client_id) {
      // orphan without client_id — soft delete
      await sb("events", {
        method: "PATCH",
        query: { id: `eq.${ev.id}` },
        body: { deleted_at: new Date().toISOString() },
        headers: { Prefer: "return=minimal" },
      });
      continue;
    }
    if (!keepIds.has(String(ev.client_id))) {
      await sb("events", {
        method: "PATCH",
        query: { id: `eq.${ev.id}` },
        body: { deleted_at: new Date().toISOString() },
        headers: { Prefer: "return=minimal" },
      });
    }
  }

  const byClient = new Map(
    (existing || []).filter((x) => x.client_id).map((x) => [String(x.client_id), x])
  );

  for (const row of rows || []) {
    const clientId = String(row.id || row.client_id || "");
    if (!clientId) continue;
    const payload = foodRowToPayload(row);
    const title = payload.label || "Food";
    const measures = measuresFromFoodRow(row);

    // ensure unknown measures exist
    for (const m of measures) {
      try {
        await sbRpc("ensure_measure", {
          p_id: m.measure_id,
          p_label: m.measure_id.replace(/_/g, " "),
          p_unit: m.unit || "",
          p_group: "other",
        });
      } catch {
        /* catalog may already have it */
      }
    }

    let eventId;
    const prev = byClient.get(clientId);
    if (prev) {
      eventId = prev.id;
      await sb("events", {
        method: "PATCH",
        query: { id: `eq.${eventId}` },
        body: {
          title,
          payload,
          raw_text: rawText || null,
          deleted_at: null,
          occurred_at: row.occurred_at || undefined,
        },
        headers: { Prefer: "return=minimal" },
      });
      // wipe old measures
      await sb("event_measures", {
        method: "DELETE",
        query: { event_id: `eq.${eventId}` },
        headers: { Prefer: "return=minimal" },
      });
    } else {
      const created = await sb("events", {
        method: "POST",
        body: {
          user_email: e,
          category_id: "food",
          day_key: dayKey,
          title,
          raw_text: rawText || null,
          source: "chat",
          payload,
          client_id: clientId,
          occurred_at: row.occurred_at || new Date().toISOString(),
        },
      });
      eventId = created?.[0]?.id;
    }

    if (!eventId || !measures.length) continue;
    await sb("event_measures", {
      method: "POST",
      body: measures.map((m) => ({
        event_id: eventId,
        user_email: e,
        day_key: dayKey,
        measure_id: m.measure_id,
        value: m.value,
        unit: m.unit || "",
      })),
      headers: { Prefer: "return=minimal" },
    });
  }

  try {
    await sbRpc("recompute_day_totals", { p_email: e, p_day: dayKey });
  } catch {
    /* non-fatal */
  }

  return { ok: true, day: dayKey, count: (rows || []).length };
}

export async function loadFoodDay(email, dayKey) {
  const e = String(email).toLowerCase();
  const events = await sb("events", {
    query: {
      select: "id,client_id,title,payload,occurred_at,raw_text",
      user_email: `eq.${e}`,
      day_key: `eq.${dayKey}`,
      category_id: "eq.food",
      deleted_at: "is.null",
      order: "occurred_at.asc",
    },
  });

  const rows = (events || []).map((ev) => {
    const p = ev.payload || {};
    const macros = p.macros || {};
    return {
      id: ev.client_id || ev.id,
      label: p.label || ev.title || "Food",
      amount: p.amount,
      unit: p.unit,
      source: p.source,
      ...macros,
      extras: p.extras || undefined,
      occurred_at: ev.occurred_at,
      _event_id: ev.id,
    };
  });
  return rows;
}

/**
 * Log a non-food event (exercise, steps, body metric, note, custom).
 */
export async function logEvent(email, {
  categoryId = "custom",
  title,
  rawText,
  dayKey,
  occurredAt,
  payload = {},
  measures = [],
  clientId,
  source = "chat",
  categoryLabel,
  categoryKind,
}) {
  await ensureProfile(email);
  const e = String(email).toLowerCase();
  const day = dayKey || dayKeyFor();

  try {
    await sbRpc("ensure_category", {
      p_id: categoryId,
      p_label: categoryLabel || categoryId,
      p_kind: categoryKind || "custom",
    });
  } catch {
    /* ok */
  }

  for (const m of measures) {
    try {
      await sbRpc("ensure_measure", {
        p_id: m.measure_id,
        p_label: (m.label || m.measure_id).replace(/_/g, " "),
        p_unit: m.unit || "",
        p_group: m.group || "other",
      });
    } catch {
      /* ok */
    }
  }

  let eventId;
  if (clientId) {
    const existing = await sb("events", {
      query: {
        select: "id",
        user_email: `eq.${e}`,
        client_id: `eq.${clientId}`,
        limit: "1",
      },
    });
    if (existing?.[0]?.id) {
      eventId = existing[0].id;
      await sb("events", {
        method: "PATCH",
        query: { id: `eq.${eventId}` },
        body: {
          category_id: categoryId,
          day_key: day,
          title: title || categoryId,
          raw_text: rawText || null,
          payload,
          source,
          deleted_at: null,
          occurred_at: occurredAt || new Date().toISOString(),
        },
        headers: { Prefer: "return=minimal" },
      });
      await sb("event_measures", {
        method: "DELETE",
        query: { event_id: `eq.${eventId}` },
        headers: { Prefer: "return=minimal" },
      });
    }
  }

  if (!eventId) {
    const created = await sb("events", {
      method: "POST",
      body: {
        user_email: e,
        category_id: categoryId,
        day_key: day,
        title: title || categoryId,
        raw_text: rawText || null,
        payload,
        source,
        client_id: clientId || null,
        occurred_at: occurredAt || new Date().toISOString(),
      },
    });
    eventId = created?.[0]?.id;
  }

  if (eventId && measures.length) {
    await sb("event_measures", {
      method: "POST",
      body: measures.map((m) => ({
        event_id: eventId,
        user_email: e,
        day_key: day,
        measure_id: m.measure_id,
        value: Number(m.value) || 0,
        unit: m.unit || "",
      })),
      headers: { Prefer: "return=minimal" },
    });
  }

  try {
    await sbRpc("recompute_day_totals", { p_email: e, p_day: day });
  } catch {
    /* ok */
  }

  // Keep life graph nodes warm for mind-map later
  try {
    await touchLifeNode(e, categoryKind || categoryId || "custom", title || categoryId, day);
  } catch {
    /* optional */
  }

  return { ok: true, event_id: eventId, day };
}

function slugify(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 80) || "item";
}

export async function touchLifeNode(email, kind, label, dayKey) {
  const e = String(email).toLowerCase();
  const slug = slugify(label);
  const existing = await sb("life_nodes", {
    query: {
      select: "id,event_count",
      user_email: `eq.${e}`,
      kind: `eq.${kind}`,
      slug: `eq.${slug}`,
      limit: "1",
    },
  });
  if (existing?.[0]) {
    await sb("life_nodes", {
      method: "PATCH",
      query: { id: `eq.${existing[0].id}` },
      body: {
        last_seen: dayKey,
        event_count: (Number(existing[0].event_count) || 0) + 1,
        label: label || slug,
      },
      headers: { Prefer: "return=minimal" },
    });
    return existing[0].id;
  }
  const created = await sb("life_nodes", {
    method: "POST",
    body: {
      user_email: e,
      kind,
      slug,
      label: label || slug,
      first_seen: dayKey,
      last_seen: dayKey,
      event_count: 1,
    },
  });
  return created?.[0]?.id;
}

export async function listWatchTargets(email) {
  const e = String(email).toLowerCase();
  return (
    (await sb("watch_targets", {
      query: {
        select: "*",
        user_email: `eq.${e}`,
        enabled: "eq.true",
        order: "created_at.asc",
      },
    })) || []
  );
}

export async function upsertWatchTarget(email, {
  measureId,
  label,
  mode = "floor",
  targetMin,
  targetMax,
  windowDays = 7,
  unit = "",
  severity = "yellow",
  notes,
}) {
  await ensureProfile(email);
  const e = String(email).toLowerCase();
  const mid = slugify(measureId);
  try {
    await sbRpc("ensure_measure", {
      p_id: mid,
      p_label: label || mid.replace(/_/g, " "),
      p_unit: unit || "",
      p_group: "other",
    });
  } catch {
    /* ok */
  }

  const existing = await sb("watch_targets", {
    query: {
      select: "id",
      user_email: `eq.${e}`,
      measure_id: `eq.${mid}`,
      mode: `eq.${mode}`,
      limit: "1",
    },
  });

  const body = {
    user_email: e,
    measure_id: mid,
    label: label || mid,
    mode,
    target_min: targetMin != null ? Number(targetMin) : null,
    target_max: targetMax != null ? Number(targetMax) : null,
    window_days: Number(windowDays) || 7,
    unit: unit || "",
    severity: severity || "yellow",
    enabled: true,
    notes: notes || null,
    updated_at: new Date().toISOString(),
  };

  if (existing?.[0]?.id) {
    await sb("watch_targets", {
      method: "PATCH",
      query: { id: `eq.${existing[0].id}` },
      body,
    });
    return { ok: true, id: existing[0].id, measure_id: mid };
  }
  const created = await sb("watch_targets", { method: "POST", body });
  return { ok: true, id: created?.[0]?.id, measure_id: mid };
}

export async function deleteWatchTarget(email, id) {
  const e = String(email).toLowerCase();
  await sb("watch_targets", {
    method: "PATCH",
    query: { id: `eq.${id}`, user_email: `eq.${e}` },
    body: { enabled: false },
    headers: { Prefer: "return=minimal" },
  });
  return { ok: true };
}

/** Rolling average of a measure from day_totals over last N days (incl today). */
export async function rollingAverage(email, measureId, windowDays = 7) {
  const e = String(email).toLowerCase();
  const to = dayKeyFor();
  const fromDate = new Date();
  fromDate.setDate(fromDate.getDate() - (Number(windowDays) || 7) + 1);
  const from = dayKeyFor(fromDate);

  const rows =
    (await sb("day_totals", {
      query: {
        select: "day_key,total,unit",
        user_email: `eq.${e}`,
        measure_id: `eq.${measureId}`,
        day_key: `gte.${from}`,
        order: "day_key.asc",
      },
    })) || [];

  const filtered = rows.filter((r) => r.day_key <= to);
  const daysWithData = filtered.length;
  const sum = filtered.reduce((a, r) => a + (Number(r.total) || 0), 0);
  // Average over window days (missing days count as 0) — honest "daily average intake"
  const win = Number(windowDays) || 7;
  const avg = sum / win;
  return {
    measure_id: measureId,
    from,
    to,
    window_days: win,
    days_with_data: daysWithData,
    sum,
    average: avg,
    unit: filtered[0]?.unit || "",
    series: filtered,
  };
}

/**
 * Evaluate all enabled watches → status chips + open/create alerts.
 */
export async function evaluateWatches(email) {
  const targets = await listWatchTargets(email);
  const statuses = [];
  const newAlerts = [];

  for (const t of targets) {
    const roll = await rollingAverage(email, t.measure_id, t.window_days || 7);
    const avg = roll.average;
    let ok = true;
    let message = "";
    const mode = t.mode || "floor";

    if (mode === "floor" && t.target_min != null) {
      ok = avg >= Number(t.target_min);
      message = ok
        ? `On track (≥ ${t.target_min})`
        : `Below target: avg ${fmtN(avg)} < ${t.target_min} ${t.unit || roll.unit || ""}`;
    } else if (mode === "ceiling" && t.target_max != null) {
      ok = avg <= Number(t.target_max);
      message = ok
        ? `Under ceiling (≤ ${t.target_max})`
        : `Above target: avg ${fmtN(avg)} > ${t.target_max} ${t.unit || roll.unit || ""}`;
    } else if (mode === "range") {
      const lo = t.target_min != null ? Number(t.target_min) : -Infinity;
      const hi = t.target_max != null ? Number(t.target_max) : Infinity;
      ok = avg >= lo && avg <= hi;
      message = ok
        ? `In range (${lo}–${hi})`
        : `Out of range: avg ${fmtN(avg)} (want ${lo}–${hi})`;
    } else {
      message = `Avg ${fmtN(avg)}`;
    }

    const status = {
      id: t.id,
      measure_id: t.measure_id,
      label: t.label || t.measure_id,
      mode,
      target_min: t.target_min,
      target_max: t.target_max,
      window_days: t.window_days,
      unit: t.unit || roll.unit || "",
      severity: t.severity || "yellow",
      average: avg,
      days_with_data: roll.days_with_data,
      ok,
      message,
    };
    statuses.push(status);

    if (!ok && roll.days_with_data > 0) {
      // Avoid spam: one open alert per measure
      const open = await sb("alerts", {
        query: {
          select: "id",
          user_email: `eq.${String(email).toLowerCase()}`,
          measure_id: `eq.${t.measure_id}`,
          status: "eq.open",
          code: `eq.WATCH_${mode.toUpperCase()}`,
          limit: "1",
        },
      });
      if (!open?.length) {
        const created = await sb("alerts", {
          method: "POST",
          body: {
            user_email: String(email).toLowerCase(),
            severity: t.severity || "yellow",
            code: `WATCH_${mode.toUpperCase()}`,
            title: `${status.label}: ${message}`,
            body: `Rolling ${t.window_days}d average for ${status.label} is ${fmtN(avg)} ${status.unit}.`,
            measure_id: t.measure_id,
            evidence: { roll, target: t },
            day_key: dayKeyFor(),
            status: "open",
          },
        });
        newAlerts.push(created?.[0]);
      }
    }
  }

  return { statuses, newAlerts };
}

function fmtN(n) {
  const x = Number(n) || 0;
  if (Math.abs(x) >= 100) return String(Math.round(x));
  return x.toFixed(1).replace(/\.0$/, "");
}

/** Seed sensible default watches for Brice if none exist. */
export async function seedDefaultWatches(email) {
  const existing = await listWatchTargets(email);
  if (existing.length) return existing;
  const defaults = [
    { measureId: "potassium", label: "Potassium", mode: "floor", targetMin: 3500, unit: "mg", windowDays: 7, severity: "yellow" },
    { measureId: "magnesium", label: "Magnesium", mode: "floor", targetMin: 350, unit: "mg", windowDays: 7, severity: "yellow" },
    { measureId: "protein", label: "Protein", mode: "floor", targetMin: 150, unit: "g", windowDays: 7, severity: "yellow" },
    { measureId: "fat", label: "Fat", mode: "floor", targetMin: 100, unit: "g", windowDays: 7, severity: "yellow" },
    { measureId: "kcal", label: "Calories", mode: "floor", targetMin: 1800, unit: "kcal", windowDays: 7, severity: "yellow" },
  ];
  for (const d of defaults) {
    await upsertWatchTarget(email, d);
  }
  return listWatchTargets(email);
}
