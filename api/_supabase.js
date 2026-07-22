/**
 * Supabase REST helper (service role — server only).
 * Never expose SUPABASE_SERVICE_ROLE_KEY to the browser.
 */

import { assertFoodDayMayBeCleared } from "./_ledger_safety.js";
import {
  mergeCompanionSettings,
  normalizeCompanionSettings,
} from "./_companion_settings.js";

import {
  messagesInChronologicalOrder,
  normalizeMemoryRecords,
  sanitizeMemoryNoteText,
  selectUniqueMemoryMatch,
  selectChatContextWindow,
} from "./_chat_memory.js";

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

export async function ensureProfile(email) {
  const e = String(email || "").toLowerCase();
  if (!e) return null;
  const existing = await sb("profiles", {
    query: { email: `eq.${e}`, select: "email", limit: "1" },
  });
  if (existing?.length) {
    return e;
  }
  await sb("profiles", {
    method: "POST",
    body: { email: e },
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
      select: "account_id,email,name,picture,timezone,prefs,created_at,updated_at",
      limit: "1",
    },
  });
  return rows?.[0] || null;
}

/** Account-scoped profile read for new health-data services. Omits login email. */
export async function getProfileByAccountId(accountId) {
  const id = normalizeAccountId(accountId);
  if (!id) return null;
  const rows = await sb("profiles", {
    query: {
      account_id: `eq.${id}`,
      select: "account_id,name,picture,timezone,prefs,created_at,updated_at",
      limit: "1",
    },
  });
  return rows?.[0] || null;
}

export function normalizeAccountId(value) {
  const id = String(value || "").trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)
    ? id
    : null;
}

/** Resolve the random internal owner id. Never derive one from an email. */
export async function accountIdForEmail(email) {
  const profile = await getProfile(email);
  const accountId = normalizeAccountId(profile?.account_id);
  if (!accountId) {
    const error = new Error("Internal account identity is unavailable.");
    error.code = "account_identity_unavailable";
    error.status = 503;
    throw error;
  }
  return accountId;
}

/**
 * Link the verified Google subject to the internal account. The login email is
 * kept only in the identity table; health-record services use account_id.
 */
export async function linkGoogleIdentity(email, providerSubject) {
  const e = String(email || "").trim().toLowerCase();
  const subject = String(providerSubject || "").trim().slice(0, 255);
  if (!e || !subject) {
    const error = new Error("Verified Google identity is required.");
    error.code = "invalid_google_identity";
    error.status = 400;
    throw error;
  }
  const accountId = await accountIdForEmail(e);
  const byEmail = await sb("auth_identities", {
    query: {
      select: "id,account_id,provider_subject",
      provider: "eq.google",
      login_email: `eq.${e}`,
      limit: "1",
    },
  });
  const existing = byEmail?.[0];
  if (existing) {
    if (normalizeAccountId(existing.account_id) !== accountId) {
      const error = new Error("Login identity belongs to another account.");
      error.code = "identity_account_conflict";
      error.status = 409;
      throw error;
    }
    await sb("auth_identities", {
      method: "PATCH",
      query: { id: `eq.${existing.id}`, account_id: `eq.${accountId}` },
      body: {
        provider_subject: subject,
        last_login_at: new Date().toISOString(),
      },
      headers: { Prefer: "return=minimal" },
    });
    return accountId;
  }
  await sb("auth_identities", {
    method: "POST",
    body: {
      account_id: accountId,
      provider: "google",
      provider_subject: subject,
      login_email: e,
      last_login_at: new Date().toISOString(),
    },
    headers: { Prefer: "return=minimal" },
  });
  return accountId;
}

export async function consumeAccountRateLimit(
  accountId,
  bucket,
  { maxEvents = 20, windowSeconds = 60 } = {}
) {
  const id = normalizeAccountId(accountId);
  if (!id) throw new Error("invalid account id");
  return Boolean(
    await sbRpc("consume_account_rate_limit", {
      p_account_id: id,
      p_bucket: String(bucket || "").trim().slice(0, 80),
      p_max_events: Math.max(1, Math.min(1000, Number(maxEvents) || 20)),
      p_window_seconds: Math.max(
        1,
        Math.min(86400, Number(windowSeconds) || 60)
      ),
    })
  );
}

function boundedMetadata(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const safe = Object.fromEntries(
    Object.entries(value)
      .filter(([key, item]) =>
        /^[a-z0-9_]{1,60}$/i.test(key) &&
        (item == null || ["string", "number", "boolean"].includes(typeof item))
      )
      .slice(0, 20)
      .map(([key, item]) => [
        key,
        typeof item === "string" ? item.slice(0, 160) : item,
      ])
  );
  return JSON.stringify(safe).length <= 3_000 ? safe : {};
}

export async function recordAccountAudit(
  accountId,
  { action, resourceType, resourceId = null, outcome = "success", metadata = {} } = {}
) {
  const id = normalizeAccountId(accountId);
  const actionName = String(action || "").trim().slice(0, 80);
  const resource = String(resourceType || "").trim().slice(0, 80);
  if (!id || !actionName || !resource) return false;
  try {
    await sb("account_audit_events", {
      method: "POST",
      body: {
        account_id: id,
        action: actionName,
        resource_type: resource,
        resource_id: resourceId ? String(resourceId).slice(0, 160) : null,
        outcome: ["success", "denied", "failed"].includes(outcome)
          ? outcome
          : "failed",
        metadata: boundedMetadata(metadata),
      },
      headers: { Prefer: "return=minimal" },
    });
    return true;
  } catch {
    return false;
  }
}

export async function recordProductEvent(
  accountId,
  eventName,
  { durationMs = null, numericValue = null, metadata = {} } = {}
) {
  const id = normalizeAccountId(accountId);
  const name = String(eventName || "").trim().slice(0, 80);
  if (!id || !name) return false;
  try {
    await sb("product_events", {
      method: "POST",
      body: {
        account_id: id,
        event_name: name,
        duration_ms:
          durationMs == null
            ? null
            : Math.max(0, Math.min(3_600_000, Math.round(Number(durationMs)))),
        numeric_value:
          numericValue == null || !Number.isFinite(Number(numericValue))
            ? null
            : Number(numericValue),
        metadata: boundedMetadata(metadata),
      },
      headers: { Prefer: "return=minimal" },
    });
    return true;
  } catch {
    return false;
  }
}

export async function listFoodCorrections(email, { limit = 20 } = {}) {
  const accountId = await accountIdForEmail(email);
  const rows = await sb("food_corrections", {
    query: {
      select:
        "id,correction_key,kind,correction,confirmations,active,created_at,updated_at",
      account_id: `eq.${accountId}`,
      active: "eq.true",
      order: "updated_at.desc",
      limit: String(Math.max(1, Math.min(50, Number(limit) || 20))),
    },
  });
  return Array.isArray(rows) ? rows : [];
}

export async function recordFoodCorrection(
  email,
  { correctionKey, kind, correction } = {}
) {
  const accountId = await accountIdForEmail(email);
  const key = String(correctionKey || "").trim().slice(0, 160);
  const correctionKind = String(kind || "").trim();
  const allowedKinds = new Set([
    "identity",
    "quantity",
    "preparation",
    "nutrient",
    "usual_portion",
  ]);
  if (!key || !allowedKinds.has(correctionKind)) {
    const error = new Error("Invalid food correction.");
    error.code = "invalid_food_correction";
    error.status = 400;
    throw error;
  }
  const safeCorrection =
    correction && typeof correction === "object" && !Array.isArray(correction)
      ? correction
      : {};
  if (JSON.stringify(safeCorrection).length > 4_000) {
    const error = new Error("Food correction is too large.");
    error.code = "food_correction_too_large";
    error.status = 413;
    throw error;
  }
  return sbRpc("record_food_correction", {
    p_account_id: accountId,
    p_correction_key: key,
    p_kind: correctionKind,
    p_correction: safeCorrection,
  });
}

/** Atomically merge preferences without replacing unrelated profile fields. */
export async function mergeProfilePrefs(email, patch = {}) {
  const e = String(email || "").trim().toLowerCase();
  if (!e || !patch || typeof patch !== "object" || Array.isArray(patch)) {
    const error = new Error("Invalid profile preference update.");
    error.code = "invalid_profile_preferences";
    error.status = 400;
    throw error;
  }
  const accountId = await accountIdForEmail(e);
  return sbRpc("merge_profile_prefs_by_account", {
    p_account_id: accountId,
    p_patch: patch,
  });
}

export async function getCompanionSettings(email) {
  const accountId = await accountIdForEmail(email);
  const profile = await getProfileByAccountId(accountId);
  return normalizeCompanionSettings(profile?.prefs?.assistant_settings);
}

export async function saveCompanionSettings(email, patch = {}) {
  const accountId = await accountIdForEmail(email);
  const profile = await getProfileByAccountId(accountId);
  const settings = mergeCompanionSettings(
    profile?.prefs?.assistant_settings,
    patch
  );
  await mergeProfilePrefs(email, { assistant_settings: settings });
  return settings;
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
    preferred_name: o.preferred_name || o.first_name || null,
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

export function ageFromBirthday(birthday, now = new Date()) {
  if (!birthday) return null;
  const born = new Date(`${String(birthday).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(born.getTime())) return null;
  const today = new Date(now);
  let age = today.getUTCFullYear() - born.getUTCFullYear();
  const birthdayThisYear = new Date(
    Date.UTC(today.getUTCFullYear(), born.getUTCMonth(), born.getUTCDate())
  );
  if (today < birthdayThisYear) age -= 1;
  return age;
}

export function assertAdultOnboarding(onboarding, now = new Date()) {
  const age = ageFromBirthday(onboarding?.birthday, now);
  if (age != null && age < 18) {
    const error = new Error(
      "BigBricey currently supports adult target calculations only. Family mode needs separate guardian and child safeguards."
    );
    error.code = "adult_only";
    error.status = 422;
    throw error;
  }
  return age;
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
  const knownAge = assertAdultOnboarding(o);
  const age = knownAge == null ? 35 : Math.min(100, knownAge);
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
    preferred_name:
      data.preferred_name != null
        ? String(data.preferred_name).trim()
        : data.first_name != null
          ? String(data.first_name).trim()
          : prev.preferred_name || prev.first_name,
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

  const preferencePatch = { onboarding: next };
  // Starting look from onboarding (optional)
  if (data.theme_preset && typeof data.theme_preset === "string") {
    const preset = String(data.theme_preset).toLowerCase().trim();
    if (preset && preset !== "custom") {
      preferencePatch.theme = { preset };
    }
  }
  await mergeProfilePrefs(e, preferencePatch);

  // Prefer first_name on profile.name when set. This column update cannot
  // overwrite the independently merged JSON preferences.
  if (next.preferred_name || next.first_name) {
    await sb("profiles", {
      method: "PATCH",
      query: { email: `eq.${e}` },
      body: { name: next.preferred_name || next.first_name },
      headers: { Prefer: "return=minimal" },
    });
  }

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
];

const MEASURE_UNITS = {
  kcal: "kcal",
  protein: "g",
  fat: "g",
  carbs: "g",
  fiber: "g",
  sugars: "g",
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
  const grams =
    row.grams == null || row.grams === "" ? null : Number(row.grams);
  return {
    label: row.label || row.food || "",
    amount: row.amount ?? null,
    unit: row.unit ?? null,
    source: row.source || row.db || null,
    fdcId: row.fdcId || row.fdc_id || null,
    saved_food_id: row.saved_food_id
      ? String(row.saved_food_id).trim().slice(0, 200)
      : null,
    grams: Number.isFinite(grams) ? grams : null,
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
      if (
        typeof raw !== "number" &&
        !(typeof raw === "string" && raw.trim() !== "")
      ) {
        continue;
      }
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

function validateFoodRowsForSync(rows) {
  let encoded;
  try {
    encoded = JSON.stringify(rows);
  } catch {
    const error = new Error("Food rows must be valid JSON.");
    error.code = "invalid_food_rows";
    error.status = 400;
    throw error;
  }
  if (encoded.length > 1_500_000) {
    const error = new Error("Food-day payload is too large.");
    error.code = "food_day_payload_too_large";
    error.status = 413;
    throw error;
  }
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      const error = new Error("Every food row must be an object.");
      error.code = "invalid_food_row";
      error.status = 400;
      throw error;
    }
    if (String(row.label || row.food || "").length > 300) {
      const error = new Error("Food label is too long.");
      error.code = "food_label_too_long";
      error.status = 400;
      throw error;
    }
    for (const key of FOOD_MEASURES) {
      if (row[key] == null || row[key] === "") continue;
      const value = Number(row[key]);
      if (!Number.isFinite(value) || value < 0 || value > 1_000_000_000) {
        const error = new Error(`Invalid ${key} value.`);
        error.code = "invalid_food_measure_value";
        error.status = 400;
        throw error;
      }
    }
    if (row.grams != null && row.grams !== "") {
      const grams = Number(row.grams);
      if (!Number.isFinite(grams) || grams < 0 || grams > 1_000_000_000) {
        const error = new Error("Invalid grams value.");
        error.code = "invalid_food_grams_value";
        error.status = 400;
        throw error;
      }
    }
    const extras = row.extras || row.micros;
    if (extras != null && JSON.stringify(extras).length > 60_000) {
      const error = new Error("Food detail is too large.");
      error.code = "food_row_payload_too_large";
      error.status = 413;
      throw error;
    }
  }
}

/**
 * Replace all non-deleted food events for a user/day with the given client rows.
 */
export async function syncFoodDay(
  email,
  dayKey,
  rows,
  { rawText, allowClear = false, expectedRevision } = {}
) {
  assertFoodDayMayBeCleared(rows, allowClear);
  if (!Number.isSafeInteger(Number(expectedRevision)) || Number(expectedRevision) < 0) {
    const error = new Error("Reload the food day before changing it.");
    error.code = "food_day_revision_required";
    error.status = 409;
    throw error;
  }
  await ensureProfile(email);
  const e = String(email).toLowerCase();
  if (rows.length > 500) {
    const error = new Error("too many food rows");
    error.code = "too_many_food_rows";
    error.status = 400;
    throw error;
  }
  validateFoodRowsForSync(rows);

  // Dedupe before entering the database transaction. Last row wins, matching
  // the historical client behavior while the RPC rejects any remaining dupes.
  const incoming = [];
  const seenIn = new Set();
  for (const r of [...(rows || [])].reverse()) {
    const cid = String(r?.id || r?.client_id || "").trim().slice(0, 200);
    if (!cid || seenIn.has(cid)) continue;
    seenIn.add(cid);
    incoming.unshift({ ...r, id: cid, client_id: cid });
  }
  const rpcRows = incoming.map((row) => {
    const payload = foodRowToPayload(row);
    return {
      id: row.id,
      client_id: row.id,
      title: String(payload.label || "Food").slice(0, 300),
      payload,
      occurred_at: row.occurred_at || null,
      measures: measuresFromFoodRow(row),
    };
  });

  try {
    return await sbRpc("sync_food_day_atomic", {
      p_email: e,
      p_day: dayKey,
      p_rows: rpcRows,
      p_expected_revision: Number(expectedRevision),
      p_raw_text: rawText ? String(rawText).slice(0, 4000) : null,
      p_allow_clear: allowClear === true,
    });
  } catch (error) {
    if (/stale_food_day_revision|food_day_revision_required/i.test(String(error?.message))) {
      error.code = /stale/i.test(String(error?.message))
        ? "stale_food_day_revision"
        : "food_day_revision_required";
      error.status = 409;
      error.message = "This food day changed somewhere else. Reload it and try again.";
    }
    throw error;
  }
}

export function foodRowsFromEvents(events) {
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
      ...(p.grams != null && Number.isFinite(Number(p.grams))
        ? { grams: Number(p.grams) }
        : {}),
      source: p.source,
      ...(p.saved_food_id
        ? { saved_food_id: String(p.saved_food_id).slice(0, 200) }
        : {}),
      ...macros,
      extras: p.extras || undefined,
      occurred_at: ev.occurred_at,
      _event_id: ev.id,
    });
  }
  return Array.from(byKey.values());
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
  return foodRowsFromEvents(events);
}

export async function loadFoodDaySnapshot(email, dayKey) {
  const e = String(email || "").trim().toLowerCase();
  const snapshot = await sbRpc("load_food_day_snapshot", {
    p_email: e,
    p_day: dayKey,
  });
  const revision = Number(snapshot?.revision);
  return {
    rows: foodRowsFromEvents(Array.isArray(snapshot?.events) ? snapshot.events : []),
    revision: Number.isSafeInteger(revision) && revision >= 0 ? revision : 0,
  };
}

/**
 * Log a non-food event (exercise, steps, body metric, note, custom).
 */
function eventWriteError(code, message, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function boundedText(value, max, fallback = "") {
  const text = String(value ?? "").trim();
  return (text || fallback).slice(0, max);
}

function eventIdentifier(value, fallback, max, code) {
  const normalized = String(value ?? fallback ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!normalized || normalized.length > max) {
    throw eventWriteError(code, "A valid identifier is required.");
  }
  return normalized;
}

function validDayKey(value) {
  const day = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const parsed = new Date(`${day}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== day) {
    return null;
  }
  if (day < "1900-01-01" || day > "2200-12-31") return null;
  return day;
}

function jsonByteLength(value) {
  let encoded;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw eventWriteError("invalid_event_payload", "Event data must be valid JSON.");
  }
  if (encoded === undefined) {
    throw eventWriteError("invalid_event_payload", "Event data must be valid JSON.");
  }
  return Buffer.byteLength(encoded, "utf8");
}

export function normalizeEventWrite(email, input = {}) {
  const e = String(email || "").trim().toLowerCase();
  if (!e || e.length > 320 || !e.includes("@")) {
    throw eventWriteError("invalid_event_account", "A valid account is required.");
  }

  const categoryId = eventIdentifier(
    input.categoryId,
    "custom",
    80,
    "invalid_event_category"
  );
  if (categoryId === "food") {
    throw eventWriteError(
      "invalid_event_category",
      "Food entries must use the food ledger transaction."
    );
  }
  const categoryLabel = boundedText(
    input.categoryLabel,
    120,
    categoryId.replace(/_/g, " ")
  );
  const categoryKind = eventIdentifier(
    input.categoryKind,
    "custom",
    32,
    "invalid_event_kind"
  );
  const title = boundedText(input.title, 300, categoryLabel);
  const rawText = input.rawText == null ? null : boundedText(input.rawText, 4000);
  const day = validDayKey(input.dayKey || dayKeyFor());
  if (!day) throw eventWriteError("invalid_event_day", "A valid event day is required.");

  let occurredAt = null;
  if (input.occurredAt != null && String(input.occurredAt).trim()) {
    const occurred = new Date(input.occurredAt);
    if (
      Number.isNaN(occurred.getTime()) ||
      occurred.getUTCFullYear() < 1900 ||
      occurred.getUTCFullYear() > 2200
    ) {
      throw eventWriteError(
        "invalid_event_timestamp",
        "A valid event timestamp is required."
      );
    }
    occurredAt = occurred.toISOString();
  }

  const payload = input.payload ?? {};
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw eventWriteError("invalid_event_payload", "Event data must be an object.");
  }
  if (jsonByteLength(payload) > 65536) {
    throw eventWriteError("event_payload_too_large", "Event data is too large.");
  }

  if (!Array.isArray(input.measures)) {
    throw eventWriteError("invalid_event_measures", "Event measures must be an array.");
  }
  if (input.measures.length > 100) {
    throw eventWriteError(
      "too_many_event_measures",
      "An event can contain at most 100 measures."
    );
  }

  const seenMeasures = new Set();
  const measures = input.measures.map((measure) => {
    if (!measure || typeof measure !== "object" || Array.isArray(measure)) {
      throw eventWriteError("invalid_event_measure", "Each measure must be an object.");
    }
    const measureId = eventIdentifier(
      measure.measure_id,
      "",
      80,
      "invalid_measure_id"
    );
    if (seenMeasures.has(measureId)) {
      throw eventWriteError(
        "duplicate_measure_id",
        `Measure ${measureId} was included more than once.`
      );
    }
    seenMeasures.add(measureId);

    if (measure.value === null || measure.value === "") {
      throw eventWriteError("invalid_measure_value", "Each measure needs a number.");
    }
    const value = Number(measure.value);
    if (!Number.isFinite(value) || Math.abs(value) > 1e12) {
      throw eventWriteError("invalid_measure_value", "Each measure needs a finite number.");
    }

    return {
      measure_id: measureId,
      label: boundedText(measure.label, 120, measureId.replace(/_/g, " ")),
      value,
      unit: boundedText(measure.unit, 32),
      group: eventIdentifier(measure.group, "other", 32, "invalid_measure_group"),
    };
  });

  const requestedClientId = String(input.clientId ?? "").trim();
  if (requestedClientId.length > 200) {
    throw eventWriteError(
      "invalid_event_client_id",
      "The event request ID is too long."
    );
  }
  const source = eventIdentifier(input.source, "chat", 32, "invalid_event_source");
  let clientId = requestedClientId;
  if (!clientId && source === "onboarding") {
    clientId = `onboarding:${categoryId}:starting`;
  }
  if (!clientId) {
    throw eventWriteError(
      "event_client_id_required",
      "A stable event request ID is required."
    );
  }

  return {
    email: e,
    categoryId,
    categoryLabel,
    categoryKind,
    title,
    rawText,
    day,
    occurredAt,
    payload,
    measures,
    clientId,
    source,
  };
}

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
  const event = normalizeEventWrite(email, {
    categoryId,
    title,
    rawText,
    dayKey,
    occurredAt,
    payload,
    measures,
    clientId,
    source,
    categoryLabel,
    categoryKind,
  });
  await ensureProfile(event.email);

  const result = await sbRpc("log_event_atomic", {
    p_email: event.email,
    p_category_id: event.categoryId,
    p_category_label: event.categoryLabel,
    p_category_kind: event.categoryKind,
    p_title: event.title,
    p_raw_text: event.rawText,
    p_day: event.day,
    p_occurred_at: event.occurredAt,
    p_payload: event.payload,
    p_measures: event.measures,
    p_client_id: event.clientId,
    p_source: event.source,
  });
  if (
    !result ||
    result.ok !== true ||
    typeof result.event_id !== "string" ||
    result.event_id.length === 0 ||
    result.day !== event.day ||
    typeof result.created !== "boolean"
  ) {
    throw eventWriteError(
      "event_write_unverified",
      "The event could not be verified as saved.",
      502
    );
  }

  // Keep life graph nodes warm for mind-map later
  if (result.created === true) {
    try {
      await touchLifeNode(
        event.email,
        event.categoryKind || event.categoryId,
        event.title,
        event.day
      );
    } catch {
      /* optional */
    }
  }

  return result;
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

const LATEST_DAILY_VALUE_MEASURES = new Set([
  "weight_lb",
  "body_fat_pct",
  "waist_in",
  "hip_in",
  "chest_in",
  "neck_in",
  "glucose_mg_dl",
  "blood_pressure_systolic",
  "blood_pressure_diastolic",
  "resting_heart_rate",
  "temperature_f",
]);

/** Body-state readings use the latest measurement of a day, never a sum. */
export function measureUsesLatestDailyValue(measureId) {
  return LATEST_DAILY_VALUE_MEASURES.has(
    String(measureId || "").toLowerCase().replace(/[^a-z0-9_]/g, "")
  );
}

export async function latestDailyMeasureSeries(email, measureId, from, to) {
  const e = String(email || "").toLowerCase();
  const mid = String(measureId || "")
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "");
  if (!e || !mid || !/^\d{4}-\d{2}-\d{2}$/.test(String(from || ""))) return [];
  const rows =
    (await sb("event_measures", {
      query: {
        select:
          "event_id,day_key,measure_id,value,unit,created_at,events!inner(deleted_at,occurred_at)",
        user_email: `eq.${e}`,
        measure_id: `eq.${mid}`,
        day_key: `gte.${from}`,
        "events.deleted_at": "is.null",
        order: "day_key.asc,created_at.asc",
        limit: "5000",
      },
    })) || [];
  const latestByDay = new Map();
  for (const row of rows) {
    if (!row?.day_key || row.events?.deleted_at || (to && row.day_key > to)) continue;
    const occurredAt = String(row.events?.occurred_at || row.created_at || "");
    const previous = latestByDay.get(row.day_key);
    if (!previous || occurredAt >= previous.occurred_at) {
      latestByDay.set(row.day_key, {
        day_key: row.day_key,
        measure_id: mid,
        total: Number(row.value),
        unit: String(row.unit || ""),
        occurred_at: occurredAt,
      });
    }
  }
  return Array.from(latestByDay.values())
    .filter((row) => Number.isFinite(row.total))
    .sort((left, right) => String(left.day_key).localeCompare(String(right.day_key)))
    .map(({ occurred_at, ...row }) => row);
}

/** Rolling average over the applicable daily aggregate for this measurement. */
export async function rollingAverage(email, measureId, windowDays = 7) {
  const e = String(email).toLowerCase();
  const to = dayKeyFor();
  const fromDate = new Date();
  fromDate.setDate(fromDate.getDate() - (Number(windowDays) || 7) + 1);
  const from = dayKeyFor(fromDate);

  const latestValue = measureUsesLatestDailyValue(measureId);
  const rows = latestValue
    ? await latestDailyMeasureSeries(e, measureId, from, to)
    : (await sb("day_totals", {
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
  // Additive intake/activity averages include missing zero days. Body-state
  // readings average only days that were actually measured.
  const win = Number(windowDays) || 7;
  const avg = sum / (latestValue ? Math.max(1, daysWithData) : win);
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
  assertAdultOnboarding(onboarding);
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
    const floor = calorieFloor(onboarding.sex);
    goals.kcal = Math.max(floor, Math.min(12000, n(patch.kcal)));
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
  await mergeProfilePrefs(e, { onboarding });
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

  await mergeProfilePrefs(e, { layout });
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
    const knownUnit = {
      weight_lb: "lb",
      kcal: "kcal",
      protein: "g",
      fat: "g",
      carbs: "g",
      net_carbs: "g",
      steps: "steps",
      reps: "reps",
      sets: "sets",
      duration_min: "min",
      distance_mi: "mi",
    }[mid] || "";
    boxes.push({
      id,
      kind,
      title: String(raw.title || raw.label || mid).slice(0, 48),
      measure_id: mid,
      measures: kind === "chart" ? measures : [mid],
      unit: String(raw.unit || knownUnit).slice(0, 16),
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

  await mergeProfilePrefs(e, { boxes });
  return boxes;
}

/** Today values: additive totals, plus latest reading for body-state metrics. */
export async function dayTotalsForMeasures(email, measureIds, dayKey) {
  const e = String(email || "").toLowerCase();
  const day = dayKey || dayKeyFor();
  const ids = (Array.isArray(measureIds) ? measureIds : [])
    .map((x) => String(x).toLowerCase().replace(/[^a-z0-9_]/g, ""))
    .filter(Boolean)
    .slice(0, 30);
  if (!ids.length) return {};
  const latestIds = ids.filter(measureUsesLatestDailyValue);
  const additiveIds = ids.filter((id) => !measureUsesLatestDailyValue(id));
  const rows = additiveIds.length
    ? (await sb("day_totals", {
        query: {
          select: "measure_id,total,unit",
          user_email: `eq.${e}`,
          day_key: `eq.${day}`,
          measure_id: `in.(${additiveIds.join(",")})`,
        },
      })) || []
    : [];
  const out = {};
  for (const id of ids) out[id] = 0;
  for (const r of rows) {
    if (r.measure_id) out[r.measure_id] = Number(r.total) || 0;
  }
  const latestSeries = await Promise.all(
    latestIds.map((id) => latestDailyMeasureSeries(e, id, day, day))
  );
  latestIds.forEach((id, index) => {
    if (latestSeries[index]?.[0]) {
      out[id] = Number(latestSeries[index][0].total) || 0;
    }
  });
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

  await mergeProfilePrefs(e, { theme });
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

export async function findSavedFoodById(email, id) {
  const e = String(email || "").trim().toLowerCase();
  const savedId = String(id || "").trim();
  if (!e || !savedId) return null;
  const rows = await sb("saved_foods", {
    query: {
      select: "*",
      user_email: `eq.${e}`,
      id: `eq.${savedId}`,
      limit: "1",
    },
  });
  return rows?.[0] || null;
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

  const hasNumericValue = (x) => {
    if (x == null || x === "") return false;
    return Number.isFinite(Number(x));
  };
  const n = (x) => {
    const v = Number(x);
    return Number.isFinite(v) ? v : 0;
  };
  // Full dump: ingredients list, micros, vitamins, net carbs, label notes → extras JSON
  const extrasIn =
    food.extras && typeof food.extras === "object" ? { ...food.extras } : {};
  const incomingKnown = new Set(
    Array.isArray(extrasIn.known_nutrients)
      ? extrasIn.known_nutrients.map((key) => String(key).trim()).filter(Boolean)
      : []
  );
  delete extrasIn.known_nutrients;
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
  const nutrientInput =
    extrasIn.nutrients && typeof extrasIn.nutrients === "object"
      ? extrasIn.nutrients
      : {};
  const sourceValue = (key) => food[key] ?? nutrientInput[key];
  const knownNutrients = new Set();
  for (const key of [
    "kcal",
    "protein",
    "fat",
    "carbs",
    "fiber",
    "sugars",
    "potassium",
    "magnesium",
    "sodium",
    "net_carbs",
    ...Object.keys(nutrientInput),
  ]) {
    if (incomingKnown.has(key) || hasNumericValue(sourceValue(key))) {
      knownNutrients.add(key);
    }
  }
  // The numeric saved_foods columns predate nutrient-knownness and are NOT
  // NULL. Keep their compatibility zeroes in storage, but use this marker to
  // distinguish a measured zero from data the source never supplied.
  extrasIn.known_nutrients = Array.from(knownNutrients).slice(0, 200);
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
    potassium: n(sourceValue("potassium")),
    magnesium: n(sourceValue("magnesium")),
    sodium: n(sourceValue("sodium")),
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

export async function deleteSavedFoodById(email, id) {
  const found = await findSavedFoodById(email, id);
  if (!found) return null;
  await sb("saved_foods", {
    method: "DELETE",
    query: {
      id: `eq.${found.id}`,
      user_email: `eq.${String(email || "").trim().toLowerCase()}`,
    },
    headers: { Prefer: "return=minimal" },
  });
  return found;
}

/** Build a log row from a saved food (amount = number of servings). */
export function rowFromSavedFood(saved, amount = 1) {
  const a = Number(amount) > 0 ? Number(amount) : 1;
  const n = (x) => Math.round(Number(x) * a * 10) / 10;
  const label =
    a === 1
      ? saved.name
      : `${a} × ${saved.name}`;
  const extras =
    saved.extras && typeof saved.extras === "object" ? saved.extras : {};
  const micros = extras.nutrients && typeof extras.nutrients === "object" ? extras.nutrients : {};
  const marker = Array.isArray(extras.known_nutrients)
    ? extras.known_nutrients.map((key) => String(key))
    : null;
  const known = marker
    ? new Set(marker)
    : new Set([
        "kcal",
        "protein",
        "fat",
        "carbs",
        ...["fiber", "sugars", "potassium", "magnesium", "sodium", "net_carbs"].filter(
          (key) => Number(saved[key] ?? extras[key] ?? micros[key]) !== 0
        ),
        ...Object.entries(micros)
          .filter(([, value]) => Number.isFinite(Number(value)) && Number(value) !== 0)
          .map(([key]) => key),
      ]);
  const scaleKnown = (key, value) => {
    if (!known.has(key) || value == null || value === "") return undefined;
    const number = Number(value);
    return Number.isFinite(number) ? n(number) : undefined;
  };
  const scaledMicros = {};
  for (const [k, v] of Object.entries(micros)) {
    const scaled = scaleKnown(k, v);
    if (scaled !== undefined) scaledMicros[k] = scaled;
  }
  return {
    id: crypto.randomUUID(),
    label,
    source: "saved",
    saved_food_id: saved.id,
    fdcId: null,
    grams: saved.grams != null ? n(saved.grams) : null,
    kcal: scaleKnown("kcal", saved.kcal),
    protein: scaleKnown("protein", saved.protein),
    fat: scaleKnown("fat", saved.fat),
    carbs: scaleKnown("carbs", saved.carbs),
    fiber: scaleKnown("fiber", saved.fiber),
    sugars: scaleKnown("sugars", saved.sugars),
    potassium: scaleKnown("potassium", saved.potassium ?? micros.potassium),
    magnesium: scaleKnown("magnesium", saved.magnesium ?? micros.magnesium),
    sodium: scaleKnown("sodium", saved.sodium ?? micros.sodium),
    // Full detail for ledger / future mineral rings
    extras: {
      ...extras,
      nutrients: scaledMicros,
      known_nutrients: Array.from(known),
      net_carbs:
        scaleKnown("net_carbs", extras.net_carbs),
      ingredients: saved.ingredients || extras.ingredients_list || null,
    },
  };
}

/* ——— Chat conversations + permanent memory notes ——— */

const CHAT_LIST_LIMIT = 50;

export async function listConversations(email, { limit = CHAT_LIST_LIMIT } = {}) {
  const e = String(email || "").toLowerCase();
  if (!e) return [];
  try {
    return (
      (await sb("chat_conversations", {
        query: {
          select: "id,title,summary,created_at,updated_at",
          user_email: `eq.${e}`,
          order: "updated_at.desc",
          limit: String(limit),
        },
      })) || []
    );
  } catch {
    return [];
  }
}

export async function getConversation(email, conversationId) {
  const e = String(email || "").toLowerCase();
  const id = String(conversationId || "").trim();
  if (!e || !id) return null;
  try {
    const rows = await sb("chat_conversations", {
      query: {
        select: "id,title,summary,created_at,updated_at,user_email",
        id: `eq.${id}`,
        user_email: `eq.${e}`,
        limit: "1",
      },
    });
    return rows?.[0] || null;
  } catch {
    return null;
  }
}

export async function createConversation(email, { title = "Chat" } = {}) {
  const e = String(email || "").toLowerCase();
  if (!e) throw new Error("email required");
  const now = new Date().toISOString();
  const created = await sb("chat_conversations", {
    method: "POST",
    body: {
      user_email: e,
      title: String(title || "Chat").slice(0, 80),
      summary: null,
      created_at: now,
      updated_at: now,
    },
    headers: { Prefer: "return=representation" },
  });
  return created?.[0] || null;
}

export async function touchConversation(email, conversationId, { title, summary } = {}) {
  const e = String(email || "").toLowerCase();
  const id = String(conversationId || "").trim();
  if (!e || !id) return;
  const body = { updated_at: new Date().toISOString() };
  if (title != null) body.title = String(title).slice(0, 80);
  if (summary !== undefined) body.summary = summary;
  try {
    await sb("chat_conversations", {
      method: "PATCH",
      query: { id: `eq.${id}`, user_email: `eq.${e}` },
      body,
      headers: { Prefer: "return=minimal" },
    });
  } catch {
    /* */
  }
}

export async function listMessages(email, conversationId, { limit = 500 } = {}) {
  const e = String(email || "").toLowerCase();
  const id = String(conversationId || "").trim();
  if (!e || !id) return [];
  try {
    const rows =
      (await sb("chat_messages", {
        query: {
          select: "id,role,content,created_at",
          conversation_id: `eq.${id}`,
          user_email: `eq.${e}`,
          // LIMIT must be applied to newest rows, then we reverse locally for
          // the model's normal chronological conversation order.
          order: "created_at.desc,id.desc",
          limit: String(limit),
        },
      })) || [];
    return messagesInChronologicalOrder(rows);
  } catch {
    return [];
  }
}

export async function appendMessage(email, conversationId, role, content) {
  const e = String(email || "").toLowerCase();
  const id = String(conversationId || "").trim();
  const text = String(content || "").trim();
  const r = String(role || "").toLowerCase();
  if (!e || !id || !text) return null;
  if (!["user", "assistant", "system"].includes(r)) return null;
  try {
    const created = await sb("chat_messages", {
      method: "POST",
      body: {
        conversation_id: id,
        user_email: e,
        role: r,
        content: text.slice(0, 20000),
      },
      headers: { Prefer: "return=representation" },
    });
    await touchConversation(e, id);
    return created?.[0] || null;
  } catch (err) {
    throw err;
  }
}

/**
 * Build messages for the LLM: optional summary + recent turns.
 * Keeps the same live window the model receives and deterministically excerpts
 * every older turn into conversation.summary, so there is no blind middle.
 */
export async function buildChatContextForModel(email, conversationId, { maxMessages = 24 } = {}) {
  const conv = await getConversation(email, conversationId);
  const all = await listMessages(email, conversationId, { limit: 800 });
  const context = selectChatContextWindow(all, {
    maxMessages,
    compactAfterExtraMessages: 0,
  });

  // Rebuild from source messages instead of recursively appending the stored
  // summary. This also cleans old duplicated summaries on the next request.
  if ((conv?.summary || null) !== context.summary) {
    await touchConversation(email, conversationId, { summary: context.summary });
  }
  return {
    conversation: conv,
    ...context,
  };
}

const PROFILE_MEMORY_SELECT =
  "id,user_email,kind,text,provenance,confidence,source_conversation_id,source_message_id,created_at,updated_at";
const PROFILE_MEMORY_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function memoryEmail(email) {
  const value = String(email || "").trim().toLowerCase();
  if (!value) throw new Error("email required");
  return value;
}

function memoryInput({ kind = "fact", text, provenance = "user_ui" } = {}) {
  const record = normalizeMemoryRecords([
    { kind, text, provenance, confidence: 1 },
  ])[0];
  if (!record || record.kind === "inference" || record.provenance === "inferred") {
    const error = new Error("Invalid explicit memory.");
    error.code = "invalid_memory";
    error.status = 400;
    throw error;
  }
  return record;
}

function optionalMemorySourceId(value) {
  const text = String(value || "").trim().toLowerCase();
  return PROFILE_MEMORY_UUID.test(text) ? text : null;
}

export async function listProfileMemories(email, { limit = 40 } = {}) {
  const e = memoryEmail(email);
  const max = Math.min(40, Math.max(1, Math.floor(Number(limit) || 40)));
  const rows = await sb("profile_memories", {
    query: {
      user_email: `eq.${e}`,
      select: PROFILE_MEMORY_SELECT,
      order: "updated_at.desc,id.desc",
      limit: String(max),
    },
  });
  return normalizeMemoryRecords(rows, { limit: max });
}

export async function createProfileMemory(
  email,
  {
    kind = "fact",
    text,
    provenance = "user_ui",
    sourceConversationId = null,
    sourceMessageId = null,
  } = {}
) {
  const e = memoryEmail(email);
  const record = memoryInput({ kind, text, provenance });
  let rows;
  try {
    rows = await sb("profile_memories", {
      method: "POST",
      body: {
        user_email: e,
        kind: record.kind,
        text: record.text,
        provenance: record.provenance,
        confidence: 1,
        source_conversation_id: optionalMemorySourceId(sourceConversationId),
        source_message_id: optionalMemorySourceId(sourceMessageId),
      },
    });
  } catch (error) {
    if (
      error?.detail?.code === "P0001" &&
      String(error?.detail?.message || error?.message).includes("profile_memory_limit")
    ) {
      const limitError = new Error("BigBricey can remember up to 40 permanent items.");
      limitError.code = "memory_limit_reached";
      limitError.status = 409;
      throw limitError;
    }
    throw error;
  }
  const created = normalizeMemoryRecords(rows, { limit: 1 })[0];
  if (!created) throw new Error("memory_create_failed");
  return created;
}

export async function updateProfileMemory(email, memoryId, { kind, text } = {}) {
  const e = memoryEmail(email);
  const id = optionalMemorySourceId(memoryId);
  if (!id) {
    const error = new Error("Invalid memory id.");
    error.code = "invalid_memory_id";
    error.status = 400;
    throw error;
  }
  const record = memoryInput({ kind, text, provenance: "user_ui" });
  const rows = await sb("profile_memories", {
    method: "PATCH",
    query: { id: `eq.${id}`, user_email: `eq.${e}` },
    body: {
      kind: record.kind,
      text: record.text,
      provenance: "user_ui",
      confidence: 1,
      source_conversation_id: null,
      source_message_id: null,
    },
  });
  const updated = normalizeMemoryRecords(rows, { limit: 1 })[0];
  if (!updated) {
    const error = new Error("Memory not found.");
    error.code = "memory_not_found";
    error.status = 404;
    throw error;
  }
  return updated;
}

export async function deleteProfileMemory(email, memoryId) {
  const e = memoryEmail(email);
  const id = optionalMemorySourceId(memoryId);
  if (!id) {
    const error = new Error("Invalid memory id.");
    error.code = "invalid_memory_id";
    error.status = 400;
    throw error;
  }
  const rows = await sb("profile_memories", {
    method: "DELETE",
    query: { id: `eq.${id}`, user_email: `eq.${e}` },
  });
  return { deleted: Array.isArray(rows) && rows.length === 1, id };
}

async function legacyMemoryRecords(email) {
  try {
    const profile = await getProfile(email);
    const prefs =
      profile?.prefs && typeof profile.prefs === "object" ? profile.prefs : {};
    return normalizeMemoryRecords(
      Array.isArray(prefs.memory_notes) ? prefs.memory_notes : []
    ).reverse();
  } catch {
    return [];
  }
}

function isMissingProfileMemoryTable(error) {
  const code = String(error?.detail?.code || error?.code || "").toUpperCase();
  if (code === "42P01" || code === "PGRST205") return true;
  const message = String(error?.detail?.message || error?.message || "");
  return (
    Number(error?.status) === 404 &&
    /profile_memories/i.test(message) &&
    /(?:schema cache|does not exist|unknown table)/i.test(message)
  );
}

export async function getMemoryRecords(email) {
  const e = String(email || "").trim().toLowerCase();
  if (!e) return [];
  try {
    return await listProfileMemories(e);
  } catch (error) {
    // Compatibility release: production code may briefly precede migration 011.
    if (!isMissingProfileMemoryTable(error)) throw error;
  }
  return legacyMemoryRecords(e);
}

export async function getMemoryNotes(email) {
  const records = await getMemoryRecords(email);
  return records.slice().reverse().map((record) => record.text);
}

export async function addMemoryNote(
  email,
  note,
  { kind = "fact", provenance = "user_chat", sourceConversationId, sourceMessageId } = {}
) {
  const text = sanitizeMemoryNoteText(note).slice(0, 300);
  if (!text) {
    return {
      memories: await getMemoryRecords(email),
      notes: await getMemoryNotes(email),
      changed: false,
    };
  }
  const existing = selectUniqueMemoryMatch(await getMemoryRecords(email), text);
  if (
    existing.status === "found" &&
    existing.memory.text.toLocaleLowerCase("en-US") ===
      text.toLocaleLowerCase("en-US")
  ) {
    const memories = await getMemoryRecords(email);
    return {
      memories,
      notes: memories.slice().reverse().map((record) => record.text),
      changed: false,
    };
  }
  const created = await createProfileMemory(email, {
    kind,
    text,
    provenance,
    sourceConversationId,
    sourceMessageId,
  });
  const memories = await getMemoryRecords(email);
  return {
    memory: created,
    memories,
    notes: memories.slice().reverse().map((record) => record.text),
    changed: true,
  };
}

export async function removeMemoryNote(email, match) {
  const records = await getMemoryRecords(email);
  const selection = selectUniqueMemoryMatch(records, match);
  if (selection.status !== "found" || !selection.memory.id) {
    return {
      memories: records,
      notes: records.slice().reverse().map((record) => record.text),
      removed_count: 0,
      changed: false,
      ambiguous: selection.status === "ambiguous",
      match_count: selection.matches?.length || 0,
    };
  }
  const deleted = await deleteProfileMemory(email, selection.memory.id);
  const memories = await getMemoryRecords(email);
  return {
    memories,
    notes: memories.slice().reverse().map((record) => record.text),
    removed_count: deleted.deleted ? 1 : 0,
    changed: deleted.deleted,
    ambiguous: false,
    match_count: 1,
  };
}

/* ——— LLM usage metering (per user) ——— */

function boundedEnvInteger(name, fallback, min, max) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

export async function reserveLlmTurn(email, { reservedTokens } = {}) {
  const e = String(email || "").trim().toLowerCase();
  if (!e) throw new Error("email required");
  const limits = {
    p_reserved_tokens: Number.isFinite(Number(reservedTokens))
      ? Math.min(100_000, Math.max(1_000, Math.round(Number(reservedTokens))))
      : boundedEnvInteger(
          "CHAT_RESERVED_TOKENS_PER_TURN",
          20_000,
          1_000,
          100_000
        ),
    p_minute_limit: boundedEnvInteger("CHAT_REQUESTS_PER_MINUTE", 10, 1, 120),
    p_daily_request_limit: boundedEnvInteger(
      "CHAT_DAILY_REQUEST_LIMIT",
      200,
      1,
      5_000
    ),
    p_daily_token_budget: boundedEnvInteger(
      "CHAT_DAILY_TOKEN_BUDGET",
      2_000_000,
      1_000,
      1_000_000_000
    ),
  };
  try {
    return await sbRpc("reserve_llm_turn", { p_email: e, ...limits });
  } catch (error) {
    const message = String(error?.message || "");
    if (/llm_(?:minute|daily)_limit_reached/i.test(message)) {
      error.code = /minute/i.test(message)
        ? "chat_rate_limit_reached"
        : "chat_daily_limit_reached";
      error.status = 429;
      error.message = /minute/i.test(message)
        ? "You're sending messages too quickly. Wait a moment and try again."
        : "You've reached today's AI chat allowance. Try again tomorrow.";
    }
    throw error;
  }
}

export async function reserveAdditionalLlmTokens(
  email,
  { reservedTokens } = {}
) {
  const e = String(email || "").trim().toLowerCase();
  if (!e) throw new Error("email required");
  const limits = {
    p_reserved_tokens: Number.isFinite(Number(reservedTokens))
      ? Math.min(100_000, Math.max(1_000, Math.round(Number(reservedTokens))))
      : boundedEnvInteger(
          "CHAT_RESERVED_TOKENS_PER_TURN",
          20_000,
          1_000,
          100_000
        ),
    p_daily_token_budget: boundedEnvInteger(
      "CHAT_DAILY_TOKEN_BUDGET",
      2_000_000,
      1_000,
      1_000_000_000
    ),
  };
  try {
    return await sbRpc("reserve_llm_tokens", { p_email: e, ...limits });
  } catch (error) {
    if (/llm_daily_limit_reached/i.test(String(error?.message || ""))) {
      error.code = "chat_daily_limit_reached";
      error.status = 429;
      error.message = "You've reached today's AI chat allowance. Try again tomorrow.";
    }
    throw error;
  }
}

export async function logLlmUsage(email, usage = {}, meta = {}) {
  const e = String(email || "").toLowerCase();
  if (!e) return null;
  const prompt = Math.max(0, Math.round(Number(usage.prompt_tokens) || 0));
  const completion = Math.max(0, Math.round(Number(usage.completion_tokens) || 0));
  const total =
    Math.max(0, Math.round(Number(usage.total_tokens) || 0)) || prompt + completion;
  if (prompt + completion + total <= 0) return null;
  try {
    let convId = meta.conversation_id || null;
    // Only pass real UUIDs (avoid insert failures)
    if (convId && !/^[0-9a-f-]{36}$/i.test(String(convId))) convId = null;
    const body = {
      user_email: e,
      model: meta.model || usage.model || null,
      provider: meta.provider || "openrouter",
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: total,
      cost_usd:
        usage.cost_usd != null && Number.isFinite(Number(usage.cost_usd))
          ? Number(usage.cost_usd)
          : null,
      conversation_id: convId,
      purpose: meta.purpose || "chat",
    };
    const created = await sb("llm_usage", {
      method: "POST",
      body,
      headers: { Prefer: "return=representation" },
    });
    return created?.[0] || { ok: true };
  } catch {
    return null;
  }
}

/** Admin: aggregate usage by user (last N days). */
export async function summarizeLlmUsage({ days = 30, limit = 100 } = {}) {
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - Math.max(1, Math.min(365, Number(days) || 30)));
  const sinceIso = since.toISOString();
  let rows = [];
  try {
    rows =
      (await sb("llm_usage", {
        query: {
          select:
            "user_email,prompt_tokens,completion_tokens,total_tokens,cost_usd,model,created_at",
          created_at: `gte.${sinceIso}`,
          order: "created_at.desc",
          limit: "5000",
        },
      })) || [];
  } catch {
    return { days, users: [], totals: zeroUsage(), error: "table_missing" };
  }

  const byUser = new Map();
  const totals = zeroUsage();
  for (const r of rows) {
    const email = String(r.user_email || "").toLowerCase();
    if (!email) continue;
    if (!byUser.has(email)) {
      byUser.set(email, {
        user_email: email,
        requests: 0,
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
        cost_usd: 0,
        last_at: r.created_at,
        models: {},
      });
    }
    const u = byUser.get(email);
    u.requests += 1;
    u.prompt_tokens += Number(r.prompt_tokens) || 0;
    u.completion_tokens += Number(r.completion_tokens) || 0;
    u.total_tokens += Number(r.total_tokens) || 0;
    if (r.cost_usd != null) u.cost_usd += Number(r.cost_usd) || 0;
    if (r.created_at && (!u.last_at || r.created_at > u.last_at)) u.last_at = r.created_at;
    const m = r.model || "unknown";
    u.models[m] = (u.models[m] || 0) + 1;

    totals.requests += 1;
    totals.prompt_tokens += Number(r.prompt_tokens) || 0;
    totals.completion_tokens += Number(r.completion_tokens) || 0;
    totals.total_tokens += Number(r.total_tokens) || 0;
    if (r.cost_usd != null) totals.cost_usd += Number(r.cost_usd) || 0;
  }

  const users = Array.from(byUser.values())
    .sort((a, b) => b.total_tokens - a.total_tokens)
    .slice(0, limit)
    .map((u) => ({
      ...u,
      cost_usd: Math.round(u.cost_usd * 1e6) / 1e6,
    }));

  totals.cost_usd = Math.round(totals.cost_usd * 1e6) / 1e6;
  return { days, since: sinceIso, users, totals, row_count: rows.length };
}

function zeroUsage() {
  return {
    requests: 0,
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    cost_usd: 0,
  };
}
