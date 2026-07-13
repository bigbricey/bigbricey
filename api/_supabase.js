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

  // Macro split respects eating_style (user can override anytime via chat)
  const style = String(o.eating_style || "no_pref").toLowerCase().replace(/\s+/g, "_");
  let fat;
  let carbs;
  const restKcal = Math.max(0, kcal - protein * 4);
  let net_carbs;
  if (style === "low_carb" || style === "keto" || style === "carnivore") {
    // Low carb: cap carbs hard, fat takes the rest
    carbs = style === "carnivore" ? 40 : style === "keto" ? 50 : 100;
    net_carbs = style === "carnivore" ? 20 : style === "keto" ? 30 : 50;
    const carbKcal = carbs * 4;
    fat = Math.round(Math.max(60, (restKcal - carbKcal) / 9));
  } else if (style === "higher_protein") {
    fat = Math.round(Math.max(50, (kcal * 0.28) / 9));
    carbs = Math.round(Math.max(40, (kcal - protein * 4 - fat * 9) / 4));
  } else if (style === "plant_forward" || style === "vegan") {
    fat = Math.round(Math.max(45, (kcal * 0.28) / 9));
    carbs = Math.round(Math.max(80, (kcal - protein * 4 - fat * 9) / 4));
  } else {
    // flexible / no pref — moderate split
    fat = Math.round(Math.max(55, (kcal * 0.32) / 9));
    carbs = Math.round(
      Math.max(40, Math.min(400, (kcal - protein * 4 - fat * 9) / 4))
    );
  }
  // Keep macros kcal-aligned within reason
  if (protein * 4 + fat * 9 + carbs * 4 > kcal + 200) {
    carbs = Math.max(20, Math.round((kcal - protein * 4 - fat * 9) / 4));
  }

  if (net_carbs == null) net_carbs = carbs;

  return {
    kcal,
    protein,
    fat,
    carbs,
    net_carbs,
    eating_style: style,
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

  // Dedupe incoming rows by id (last wins) so we never re-insert doubles
  const incoming = [];
  const seenIn = new Set();
  for (const r of [...(rows || [])].reverse()) {
    const cid = String(r?.id || r?.client_id || "").trim();
    if (!cid || seenIn.has(cid)) continue;
    seenIn.add(cid);
    incoming.unshift({ ...r, id: cid, client_id: cid });
  }

  const keepIds = new Set(incoming.map((r) => String(r.id)));

  // Soft-delete anything not in the current list; if multiple events share
  // the same client_id, keep one and delete the rest (fixes refresh doubles).
  const seenClientKeep = new Set();
  for (const ev of existing || []) {
    const cid = ev.client_id ? String(ev.client_id) : "";
    if (cid && keepIds.has(cid)) {
      if (seenClientKeep.has(cid)) {
        // duplicate client_id in DB — kill extras
        await sb("events", {
          method: "PATCH",
          query: { id: `eq.${ev.id}` },
          body: { deleted_at: new Date().toISOString() },
          headers: { Prefer: "return=minimal" },
        });
        continue;
      }
      seenClientKeep.add(cid);
      continue; // keep this one
    }
    // not in current day list (or missing client_id) → soft-delete
    await sb("events", {
      method: "PATCH",
      query: { id: `eq.${ev.id}` },
      body: { deleted_at: new Date().toISOString() },
      headers: { Prefer: "return=minimal" },
    });
  }

  // Re-fetch survivors after cleanup
  const existing2 = await sb("events", {
    query: {
      select: "id,client_id",
      user_email: `eq.${e}`,
      day_key: `eq.${dayKey}`,
      category_id: "eq.food",
      deleted_at: "is.null",
    },
  });
  const byClient = new Map(
    (existing2 || []).filter((x) => x.client_id).map((x) => [String(x.client_id), x])
  );

  for (const row of incoming) {
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

  return { ok: true, day: dayKey, count: incoming.length };
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

  // Collapse only true DB glitches: multiple events with the same client_id.
  // Same shake logged twice = two client_ids = both kept.
  const byKey = new Map();
  for (const ev of events || []) {
    const p = ev.payload || {};
    const macros = p.macros || {};
    const clientId = ev.client_id ? String(ev.client_id) : String(ev.id);
    const fingerprint = ev.client_id ? `id:${clientId}` : `ev:${ev.id}`;
    if (byKey.has(fingerprint)) continue;
    byKey.set(fingerprint, {
      id: clientId,
      label: p.label || ev.title || "Food",
      amount: p.amount,
      unit: p.unit,
      source: p.source,
      ...macros,
      extras: p.extras || undefined,
      occurred_at: ev.occurred_at,
      _event_id: ev.id,
    });
  }
  return Array.from(byKey.values());
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

/**
 * Patch daily goals / eating style from chat.
 * User can change diet day-to-day: "go low carb, 2200 kcal, 50g carbs"
 */
export async function updateUserGoals(email, patch = {}) {
  const e = String(email || "").toLowerCase();
  if (!e) throw new Error("email required");
  const profile = await getProfile(e);
  const prefs =
    profile?.prefs && typeof profile.prefs === "object" ? { ...profile.prefs } : {};
  const onboarding =
    prefs.onboarding && typeof prefs.onboarding === "object"
      ? { ...prefs.onboarding }
      : { complete: true };
  const prevGoals =
    onboarding.goals && typeof onboarding.goals === "object"
      ? { ...onboarding.goals }
      : computeGoalsFromOnboarding(onboarding);

  if (patch.eating_style != null && String(patch.eating_style).trim()) {
    onboarding.eating_style = String(patch.eating_style)
      .toLowerCase()
      .replace(/\s+/g, "_")
      .trim();
  }

  // If style changed and user didn't pass explicit macros, recompute from style
  const styleOnly =
    patch.eating_style != null &&
    patch.kcal == null &&
    patch.protein == null &&
    patch.fat == null &&
    patch.carbs == null &&
    patch.net_carbs == null;

  let goals = { ...prevGoals };
  if (styleOnly || patch.recompute) {
    if (patch.kcal != null) onboarding.kcal_confirmed = Number(patch.kcal);
    goals = computeGoalsFromOnboarding(onboarding);
  }

  const n = (x) => {
    if (x == null || x === "") return null;
    const v = Number(x);
    return Number.isFinite(v) ? Math.round(v) : null;
  };
  if (n(patch.kcal) != null) {
    goals.kcal = Math.max(800, Math.min(12000, n(patch.kcal)));
    onboarding.kcal_confirmed = goals.kcal;
  }
  if (n(patch.protein) != null) goals.protein = Math.max(0, Math.min(400, n(patch.protein)));
  if (n(patch.fat) != null) goals.fat = Math.max(0, Math.min(400, n(patch.fat)));
  if (n(patch.carbs) != null) goals.carbs = Math.max(0, Math.min(600, n(patch.carbs)));
  // Separate net-carb ceiling (can differ from total carbs)
  if (n(patch.net_carbs) != null) {
    goals.net_carbs = Math.max(0, Math.min(600, n(patch.net_carbs)));
  }
  // If total carbs set but net never set, keep existing net_carbs (don't clobber)
  if (goals.net_carbs == null && goals.carbs != null) {
    goals.net_carbs = goals.carbs;
  }
  if (n(patch.potassium) != null) goals.potassium = n(patch.potassium);
  if (n(patch.magnesium) != null) goals.magnesium = n(patch.magnesium);
  if (onboarding.eating_style) goals.eating_style = onboarding.eating_style;
  goals.updated_at = new Date().toISOString();
  goals.updated_via = "chat";

  onboarding.goals = goals;
  prefs.onboarding = onboarding;
  await sb("profiles", {
    method: "PATCH",
    query: { email: `eq.${e}` },
    body: { prefs, updated_at: new Date().toISOString() },
  });
  return { goals, eating_style: onboarding.eating_style || null, onboarding };
}

const LAYOUT_CORE_IDS = [
  "chat",
  "kcal",
  "pro",
  "fat",
  "carb",
  "net",
  "minerals",
  "summary",
  "food",
];
const LAYOUT_SIZES = new Set(["full", "half", "third"]);

function layoutIdOk(key) {
  return LAYOUT_CORE_IDS.includes(key) || /^c_[a-z0-9_]{1,40}$/.test(key);
}

/** Normalize and save Today layout into profiles.prefs.layout */
export async function saveUserLayout(email, raw = {}) {
  const e = String(email || "").toLowerCase();
  if (!e) throw new Error("email required");

  const seen = new Set();
  const order = [];
  const incoming = Array.isArray(raw.order) ? raw.order : [];
  for (const id of incoming) {
    const key = String(id || "")
      .toLowerCase()
      .trim();
    if (!layoutIdOk(key) || seen.has(key)) continue;
    seen.add(key);
    order.push(key);
  }
  for (const id of LAYOUT_CORE_IDS) {
    if (!seen.has(id)) order.push(id);
  }

  const sizes = {};
  const rs = raw.sizes && typeof raw.sizes === "object" ? raw.sizes : {};
  for (const id of order) {
    const fallback = id.startsWith("c_") ? "half" : "full";
    const s = String(rs[id] || fallback).toLowerCase();
    sizes[id] = LAYOUT_SIZES.has(s) ? s : fallback;
  }
  if (rs.minerals == null && sizes.minerals) sizes.minerals = sizes.minerals;
  if (rs.minerals == null) sizes.minerals = "half";
  if (rs.summary == null) sizes.summary = "half";

  const layout = { order, sizes, updated_at: new Date().toISOString() };

  const profile = await getProfile(e);
  const prefs =
    profile?.prefs && typeof profile.prefs === "object" ? { ...profile.prefs } : {};
  prefs.layout = layout;

  await sb("profiles", {
    method: "PATCH",
    query: { email: `eq.${e}` },
    body: { prefs, updated_at: new Date().toISOString() },
    headers: { Prefer: "return=minimal" },
  });
  return layout;
}

/** Custom goal boxes (push-ups, water, etc.) */
export async function saveUserBoxes(email, list = []) {
  const e = String(email || "").toLowerCase();
  if (!e) throw new Error("email required");

  const slug = (s) =>
    String(s || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 32);
  const hex = (v) =>
    typeof v === "string" && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v.trim())
      ? v.trim()
      : null;

  const boxes = [];
  const seen = new Set();
  const arr = Array.isArray(list) ? list : [];
  for (const raw of arr) {
    if (!raw || typeof raw !== "object") continue;
    let kind = String(raw.kind || "counter").toLowerCase();
    if (kind === "graph" || kind === "trend" || kind === "plot") kind = "chart";
    if (kind !== "chart") kind = "counter";

    let measures = [];
    if (Array.isArray(raw.measures)) {
      measures = raw.measures.map(slug).filter(Boolean).slice(0, 6);
    } else if (raw.measure_id || raw.measure) {
      measures = [slug(raw.measure_id || raw.measure)].filter(Boolean);
    }
    const mid = measures[0] || slug(raw.measure_id || raw.measure || raw.title || "custom") || "custom";
    if (kind === "chart" && !measures.length) measures = [mid];

    let days = null;
    if (kind === "chart") {
      let d = Number(raw.days ?? raw.range ?? raw.window);
      if (!Number.isFinite(d) || d < 1) d = 30;
      if (raw.weeks != null) d = Number(raw.weeks) * 7;
      if (raw.months != null) d = Number(raw.months) * 30;
      if (raw.years != null) d = Number(raw.years) * 365;
      days = Math.min(1095, Math.max(1, Math.round(d)));
    }

    let chart = String(raw.chart || raw.chart_type || "line").toLowerCase();
    if (!["line", "bar", "pie"].includes(chart)) chart = "line";

    let id = String(raw.id || "").toLowerCase().trim();
    if (!id) {
      id =
        kind === "chart"
          ? "c_chart_" + measures.slice(0, 2).join("_") + "_" + days + "d"
          : "c_" + mid;
    }
    if (!id.startsWith("c_")) id = "c_" + slug(id);
    id = id.slice(0, 48);
    if (!/^c_[a-z0-9_]{1,48}$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    let goal = raw.goal != null ? Number(raw.goal) : raw.target != null ? Number(raw.target) : null;
    if (goal != null && !Number.isFinite(goal)) goal = null;
    const sizeDefault = kind === "chart" ? "full" : "half";
    boxes.push({
      id,
      kind,
      title: String(raw.title || raw.label || mid).slice(0, 48),
      measure_id: mid,
      measures: kind === "chart" ? measures : [mid],
      unit: String(raw.unit || "").slice(0, 16),
      goal: kind === "counter" ? goal : null,
      mode: String(raw.mode || "floor").toLowerCase() === "ceiling" ? "ceiling" : "floor",
      color: hex(raw.color) || hex(raw.accent) || "#38bdf8",
      icon: String(raw.icon || raw.emoji || (kind === "chart" ? "📈" : "◎")).slice(0, 4),
      size: ["full", "half", "third"].includes(raw.size) ? raw.size : sizeDefault,
      chart: kind === "chart" ? chart : undefined,
      days: kind === "chart" ? days : undefined,
    });
    if (boxes.length >= 20) break;
  }

  const profile = await getProfile(e);
  const prefs =
    profile?.prefs && typeof profile.prefs === "object" ? { ...profile.prefs } : {};
  prefs.boxes = boxes;

  await sb("profiles", {
    method: "PATCH",
    query: { email: `eq.${e}` },
    body: { prefs, updated_at: new Date().toISOString() },
    headers: { Prefer: "return=minimal" },
  });
  return boxes;
}

/** Today totals for a list of measure ids (from day_totals). */
export async function dayTotalsForMeasures(email, measureIds, dayKey) {
  const e = String(email || "").toLowerCase();
  const day = dayKey || dayKeyFor();
  const ids = (Array.isArray(measureIds) ? measureIds : [])
    .map((x) => String(x).toLowerCase().replace(/[^a-z0-9_]/g, ""))
    .filter(Boolean)
    .slice(0, 30);
  if (!ids.length) return {};
  const rows =
    (await sb("day_totals", {
      query: {
        select: "measure_id,total,unit",
        user_email: `eq.${e}`,
        day_key: `eq.${day}`,
        measure_id: `in.(${ids.join(",")})`,
      },
    })) || [];
  const out = {};
  for (const id of ids) out[id] = 0;
  for (const r of rows) {
    if (r.measure_id) out[r.measure_id] = Number(r.total) || 0;
  }
  return out;
}

/** Save look/theme into profiles.prefs.theme */
export async function saveUserTheme(email, raw = {}) {
  const e = String(email || "").toLowerCase();
  if (!e) throw new Error("email required");

  const PRESETS = new Set([
    "midnight",
    "light",
    "neon",
    "forest",
    "pink",
    "terminal",
    "pastel",
    "sunset",
    "custom",
  ]);
  const hex = (v) =>
    typeof v === "string" && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v.trim())
      ? v.trim()
      : null;
  const glow = (v) =>
    typeof v === "string" && /^\d{1,3},\s*\d{1,3},\s*\d{1,3}$/.test(v.trim())
      ? v.replace(/\s/g, "")
      : null;

  const theme = { updated_at: new Date().toISOString() };
  let preset = String(raw.preset || raw.vibe || "custom")
    .toLowerCase()
    .replace(/\s+/g, "_");
  const vibe = {
    my_little_pony: "pastel",
    mlp: "pastel",
    pony: "pastel",
    kawaii: "pastel",
    cute: "pastel",
    barbie: "pink",
    matrix: "terminal",
    hacker: "terminal",
    cyber: "neon",
    nature: "forest",
  };
  if (vibe[preset]) preset = vibe[preset];
  if (!PRESETS.has(preset)) preset = "custom";
  theme.preset = preset;

  for (const k of [
    "accent",
    "good",
    "warn",
    "bad",
    "bg0",
    "text",
    "muted",
    "ring_left",
    "ring_eaten",
    "ring_goal",
    "ring_over",
  ]) {
    const h = hex(raw[k]);
    if (h) theme[k] = h;
  }
  if (hex(raw.eaten)) theme.ring_eaten = hex(raw.eaten);
  if (hex(raw.left)) theme.ring_left = hex(raw.left);
  if (hex(raw.goal)) theme.ring_goal = hex(raw.goal);
  if (hex(raw.background || raw.bg)) theme.bg0 = hex(raw.background || raw.bg);
  if (typeof raw.card === "string" && raw.card.length < 80) theme.card = raw.card;
  for (const k of ["glow1", "glow2", "glow3"]) {
    const g = glow(raw[k]);
    if (g) theme[k] = g;
  }
  if (raw.label) theme.label = String(raw.label).slice(0, 40);

  let radius = raw.radius != null ? Number(raw.radius) : null;
  const shape = String(raw.shape || raw.corners || "").toLowerCase();
  if (shape === "square" || shape === "sharp" || shape === "boxy") radius = 6;
  if (shape === "round" || shape === "soft" || shape === "pill") radius = 24;
  if (radius != null && Number.isFinite(radius)) {
    theme.radius = Math.min(40, Math.max(0, Math.round(radius)));
  }
  let fs = raw.font_scale ?? raw.fontScale ?? raw.font_size;
  if (fs != null) {
    fs = Number(fs);
    if (Number.isFinite(fs)) {
      if (fs > 3) fs = fs / 100;
      theme.font_scale = Math.min(1.35, Math.max(0.85, fs));
    }
  }
  if (raw.density === "compact" || raw.density === "cozy") theme.density = raw.density;
  if (raw.compact === true) theme.density = "compact";

  const profile = await getProfile(e);
  const prefs =
    profile?.prefs && typeof profile.prefs === "object" ? { ...profile.prefs } : {};
  prefs.theme = theme;

  await sb("profiles", {
    method: "PATCH",
    query: { email: `eq.${e}` },
    body: { prefs, updated_at: new Date().toISOString() },
    headers: { Prefer: "return=minimal" },
  });
  return theme;
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

/** Normalize name for matching ("My Shake" → "my shake") */
export function savedFoodNameKey(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 120);
}

/**
 * Personal food/shake library — light DB for "log my morning shake".
 * Soft practical cap: 200 items per user (plenty for personal use).
 */
const SAVED_FOODS_MAX = 200;

export async function listSavedFoods(email) {
  const e = String(email).toLowerCase();
  const rows = await sb("saved_foods", {
    query: {
      select: "*",
      user_email: `eq.${e}`,
      order: "name.asc",
      limit: String(SAVED_FOODS_MAX),
    },
  });
  return Array.isArray(rows) ? rows : [];
}

export async function findSavedFood(email, nameOrKey) {
  const e = String(email).toLowerCase();
  let key = savedFoodNameKey(nameOrKey);
  if (!key) return null;
  // strip common log-speak so "log my shake" / "had a shake" still matches
  key = key
    .replace(/^(log|add|had|have|ate|another|one|my|the|a|an)\s+/g, "")
    .replace(/\s+(please|today|now)$/g, "")
    .trim();
  if (!key) key = savedFoodNameKey(nameOrKey);

  // exact key first
  let rows = await sb("saved_foods", {
    query: {
      select: "*",
      user_email: `eq.${e}`,
      name_key: `eq.${key}`,
      limit: "1",
    },
  });
  if (rows?.[0]) return rows[0];
  // fuzzy: name contains or key contains query
  const all = await listSavedFoods(e);
  let hit = all.find(
    (r) =>
      r.name_key === key ||
      r.name_key.includes(key) ||
      key.includes(r.name_key) ||
      String(r.name || "").toLowerCase().includes(key)
  );
  if (hit) return hit;
  // single token like "shake" → unique saved food containing that word
  const tokens = key.split(/\s+/).filter((t) => t.length >= 3);
  for (const t of tokens) {
    const matches = all.filter(
      (r) => r.name_key.includes(t) || String(r.name || "").toLowerCase().includes(t)
    );
    if (matches.length === 1) return matches[0];
  }
  // only one saved food total and user said "shake"/"meal"/etc. → use it
  if (all.length === 1 && /shake|meal|scoop|hlth/i.test(key)) return all[0];
  return null;
}

export async function upsertSavedFood(email, food) {
  await ensureProfile(email);
  const e = String(email).toLowerCase();
  const name = String(food.name || food.label || "").trim();
  if (!name) {
    const err = new Error("saved food needs a name");
    err.code = "bad_saved_food";
    throw err;
  }
  const name_key = savedFoodNameKey(name);
  const existing = await listSavedFoods(e);
  const already = existing.find((r) => r.name_key === name_key);
  if (!already && existing.length >= SAVED_FOODS_MAX) {
    const err = new Error(`saved foods full (${SAVED_FOODS_MAX} max)`);
    err.code = "saved_foods_full";
    throw err;
  }

  const n = (x) => {
    const v = Number(x);
    return Number.isFinite(v) ? v : 0;
  };
  // Full dump: ingredients list, micros, vitamins, net carbs, label notes → extras JSON
  const extrasIn =
    food.extras && typeof food.extras === "object" ? { ...food.extras } : {};
  if (food.ingredients_list || food.ingredients_detail) {
    extrasIn.ingredients_list =
      food.ingredients_list || food.ingredients_detail;
  }
  if (food.net_carbs != null) extrasIn.net_carbs = n(food.net_carbs);
  if (food.nutrients && typeof food.nutrients === "object") {
    extrasIn.nutrients = food.nutrients;
  }
  // Any extra numeric micros passed flat (iron, calcium, vitamin_d, …)
  const CORE = new Set([
    "name",
    "label",
    "description",
    "ingredients",
    "recipe",
    "ingredients_list",
    "ingredients_detail",
    "serving_label",
    "serving",
    "kcal",
    "protein",
    "fat",
    "carbs",
    "fiber",
    "sugars",
    "potassium",
    "magnesium",
    "sodium",
    "grams",
    "extras",
    "net_carbs",
    "nutrients",
  ]);
  const flatMicros = {};
  for (const [k, v] of Object.entries(food)) {
    if (CORE.has(k)) continue;
    if (v == null || v === "") continue;
    if (typeof v === "number" || (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v)))) {
      flatMicros[k] = n(v);
    } else if (typeof v === "string" || typeof v === "object") {
      extrasIn[k] = v;
    }
  }
  if (Object.keys(flatMicros).length) {
    extrasIn.nutrients = { ...(extrasIn.nutrients || {}), ...flatMicros };
  }
  // Keep a human-readable ingredients string
  let ingredientsText = food.ingredients || food.recipe || null;
  if (!ingredientsText && Array.isArray(extrasIn.ingredients_list)) {
    ingredientsText = extrasIn.ingredients_list
      .map((x) => (typeof x === "string" ? x : x?.name || JSON.stringify(x)))
      .join("; ");
  }

  const row = {
    user_email: e,
    name,
    name_key,
    description: food.description || null,
    ingredients: ingredientsText,
    serving_label: food.serving_label || food.serving || "1 serving",
    kcal: n(food.kcal),
    protein: n(food.protein),
    fat: n(food.fat),
    carbs: n(food.carbs),
    fiber: n(food.fiber),
    sugars: n(food.sugars),
    potassium: n(food.potassium ?? extrasIn.nutrients?.potassium),
    magnesium: n(food.magnesium ?? extrasIn.nutrients?.magnesium),
    sodium: n(food.sodium ?? extrasIn.nutrients?.sodium),
    grams: food.grams != null ? n(food.grams) : null,
    extras: extrasIn,
    updated_at: new Date().toISOString(),
  };

  if (already) {
    const updated = await sb("saved_foods", {
      method: "PATCH",
      query: { id: `eq.${already.id}`, select: "*" },
      body: row,
      headers: { Prefer: "return=representation" },
    });
    return Array.isArray(updated) ? updated[0] : updated;
  }

  const inserted = await sb("saved_foods", {
    method: "POST",
    body: row,
    headers: { Prefer: "return=representation" },
  });
  return Array.isArray(inserted) ? inserted[0] : inserted;
}

export async function deleteSavedFood(email, nameOrKey) {
  const found = await findSavedFood(email, nameOrKey);
  if (!found) return null;
  await sb("saved_foods", {
    method: "DELETE",
    query: { id: `eq.${found.id}` },
    headers: { Prefer: "return=minimal" },
  });
  return found;
}

/** Build a log row from a saved food (amount = number of servings). */
export function rowFromSavedFood(saved, amount = 1) {
  const a = Number(amount) > 0 ? Number(amount) : 1;
  const n = (x) => Math.round((Number(x) || 0) * a * 10) / 10;
  const label =
    a === 1
      ? saved.name
      : `${a} × ${saved.name}`;
  const extras =
    saved.extras && typeof saved.extras === "object" ? saved.extras : {};
  const micros = extras.nutrients && typeof extras.nutrients === "object" ? extras.nutrients : {};
  const scaledMicros = {};
  for (const [k, v] of Object.entries(micros)) {
    scaledMicros[k] = n(v);
  }
  return {
    id: crypto.randomUUID(),
    label,
    source: "saved",
    saved_food_id: saved.id,
    fdcId: null,
    grams: saved.grams != null ? n(saved.grams) : null,
    kcal: n(saved.kcal),
    protein: n(saved.protein),
    fat: n(saved.fat),
    carbs: n(saved.carbs),
    fiber: n(saved.fiber),
    sugars: n(saved.sugars),
    potassium: n(saved.potassium || micros.potassium),
    magnesium: n(saved.magnesium || micros.magnesium),
    sodium: n(saved.sodium || micros.sodium),
    // Full detail for ledger / future mineral rings
    extras: {
      ...extras,
      nutrients: scaledMicros,
      net_carbs:
        extras.net_carbs != null ? n(extras.net_carbs) : undefined,
      ingredients: saved.ingredients || extras.ingredients_list || null,
    },
  };
}
