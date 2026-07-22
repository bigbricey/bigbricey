import {
  accountIdForEmail,
  getProfileByAccountId,
  normalizeAccountId,
  onboardingFromPrefs,
  sb,
  sbRpc,
} from "./_supabase.js";
import { normalizeCompanionSettings } from "./_companion_settings.js";

export const HEALTH_SNAPSHOT_VERSION = "health-snapshot-v1";

const PERIODS = Object.freeze({
  "10w": { key: "10w", label: "10 weeks", days: 70 },
  "6m": { key: "6m", label: "6 months", days: 183 },
  "1y": { key: "1y", label: "1 year", days: 365 },
  all: { key: "all", label: "All available history", days: null },
});

const MEASURES = Object.freeze({
  kcal: { label: "Calories", group: "nutrition" },
  protein: { label: "Protein", group: "nutrition" },
  fat: { label: "Fat", group: "nutrition" },
  carbs: { label: "Carbohydrate", group: "nutrition" },
  fiber: { label: "Fiber", group: "nutrition" },
  sugars: { label: "Sugar", group: "nutrition" },
  potassium: { label: "Potassium", group: "micronutrient" },
  magnesium: { label: "Magnesium", group: "micronutrient" },
  sodium: { label: "Sodium", group: "micronutrient" },
  calcium: { label: "Calcium", group: "micronutrient" },
  iron: { label: "Iron", group: "micronutrient" },
  zinc: { label: "Zinc", group: "micronutrient" },
  vitamin_a: { label: "Vitamin A", group: "micronutrient" },
  vitamin_c: { label: "Vitamin C", group: "micronutrient" },
  vitamin_d: { label: "Vitamin D", group: "micronutrient" },
  vitamin_e: { label: "Vitamin E", group: "micronutrient" },
  vitamin_k: { label: "Vitamin K", group: "micronutrient" },
  b12: { label: "Vitamin B12", group: "micronutrient" },
  folate: { label: "Folate", group: "micronutrient" },
  omega3: { label: "Omega-3", group: "micronutrient" },
  steps: { label: "Steps", group: "activity" },
  duration_min: { label: "Activity duration", group: "activity" },
  distance_mi: { label: "Distance", group: "activity" },
  weight_lb: { label: "Weight", group: "body" },
  waist_in: { label: "Waist", group: "body" },
  body_fat_pct: { label: "Body fat", group: "body" },
  blood_pressure_systolic: { label: "Systolic blood pressure", group: "body" },
  blood_pressure_diastolic: { label: "Diastolic blood pressure", group: "body" },
  glucose_mg_dl: { label: "Recorded glucose", group: "body" },
  sleep_hours: { label: "Sleep", group: "body" },
});

function round(value, places = 1) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const factor = 10 ** places;
  return Math.round(number * factor) / factor;
}

function dateKey(value, fallback = null) {
  const text = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return fallback;
  const parsed = new Date(`${text}T12:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text
    ? fallback
    : text;
}

function shiftDay(day, delta) {
  const parsed = new Date(`${day}T12:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + delta);
  return parsed.toISOString().slice(0, 10);
}

function daysBetween(from, to) {
  return Math.round(
    (new Date(`${to}T12:00:00.000Z`) - new Date(`${from}T12:00:00.000Z`)) /
      86_400_000
  ) + 1;
}

export function resolveHealthSnapshotPeriod(
  requested,
  { to = new Date().toISOString().slice(0, 10), availableFrom = null } = {}
) {
  const key = PERIODS[requested] ? requested : "10w";
  const period = PERIODS[key];
  const dateTo = dateKey(to, new Date().toISOString().slice(0, 10));
  const earliest = dateKey(availableFrom);
  const dateFrom =
    period.days == null
      ? earliest || shiftDay(dateTo, -364)
      : shiftDay(dateTo, -(period.days - 1));
  return {
    key,
    label: period.label,
    from: dateFrom <= dateTo ? dateFrom : dateTo,
    to: dateTo,
    calendar_days: daysBetween(dateFrom <= dateTo ? dateFrom : dateTo, dateTo),
  };
}

function normalizedMeasureSummary(value, calendarDays) {
  const id = String(value?.measure_id || "").trim().toLowerCase();
  if (!id) return null;
  const daysLogged = Math.max(0, Math.min(calendarDays, Number(value.days_logged) || 0));
  const first = round(value.first_value, 2);
  const latest = round(value.latest_value, 2);
  const change = first == null || latest == null ? null : round(latest - first, 2);
  const percentChange =
    change == null || first === 0 ? null : round((change / Math.abs(first)) * 100, 1);
  const metadata = MEASURES[id] || {
    label: id.replace(/_/g, " "),
    group: "other",
  };
  return {
    measure_id: id,
    label: metadata.label,
    group: metadata.group,
    unit: String(value.unit || "").slice(0, 24),
    days_logged: daysLogged,
    missing_days: Math.max(0, calendarDays - daysLogged),
    coverage_percent: round((daysLogged / Math.max(1, calendarDays)) * 100, 1),
    average_on_logged_days: round(value.average, 2),
    minimum_on_logged_days: round(value.minimum, 2),
    maximum_on_logged_days: round(value.maximum, 2),
    first_value: first,
    latest_value: latest,
    change,
    percent_change: percentChange,
    first_day: dateKey(value.first_day),
    latest_day: dateKey(value.latest_day),
    statistical_outlier_count:
      daysLogged >= 5 ? Math.max(0, Number(value.outlier_count) || 0) : 0,
    missing_is_zero: false,
  };
}

function boundedContext(value) {
  if (!value || typeof value !== "object") return null;
  const day = dateKey(value.day_key);
  const title = String(value.title || "").trim().slice(0, 300);
  if (!day || !title) return null;
  return {
    day,
    category: String(value.category_id || "other").slice(0, 80),
    title,
    source: String(value.source || "recorded").slice(0, 40),
  };
}

function boundedMeasurementPoint(value) {
  if (!value || typeof value !== "object") return null;
  const day = dateKey(value.day_key);
  const measureId = String(value.measure_id || "").trim().toLowerCase();
  const total = round(value.total, 3);
  if (!day || !measureId || total == null) return null;
  return {
    day,
    measure_id: measureId,
    value: total,
    unit: String(value.unit || "").slice(0, 24),
  };
}

function trendHighlights(measures) {
  return measures
    .filter(
      (measure) =>
        measure.days_logged >= 2 &&
        measure.change != null &&
        (measure.group === "body" || measure.group === "activity")
    )
    .map((measure) => ({
      measure_id: measure.measure_id,
      label: measure.label,
      from: measure.first_value,
      to: measure.latest_value,
      change: measure.change,
      percent_change: measure.percent_change,
      unit: measure.unit,
      first_day: measure.first_day,
      latest_day: measure.latest_day,
      interpretation:
        "Observed change in recorded values only; this does not establish a cause.",
    }));
}

function clinicianQuestions({ measures, context, coverage }) {
  const questions = [];
  const bodyTrend = measures.find(
    (measure) => measure.group === "body" && measure.days_logged >= 2
  );
  if (bodyTrend) {
    questions.push(
      `Is the recorded ${bodyTrend.label.toLowerCase()} change worth discussing in the context of my goals and medical history?`
    );
  }
  if (context.length) {
    questions.push(
      "Could we review the dates of my recorded symptoms, supplements, medications, laboratory results, or notes alongside the rest of my history?"
    );
  }
  const nutrientCoverage = measures.filter(
    (measure) =>
      ["nutrition", "micronutrient"].includes(measure.group) &&
      measure.days_logged > 0
  );
  if (nutrientCoverage.length) {
    questions.push(
      "Given that these nutrition averages use logged days only, are any patterns useful enough to review further?"
    );
  }
  if (coverage.completeness_percent < 70) {
    questions.push(
      "Which missing measurements or dates would be most useful to collect before drawing conclusions?"
    );
  }
  return questions.slice(0, 5);
}

export function buildHealthSnapshotDocument(
  raw,
  { period, nickname = "", generatedAt = new Date().toISOString() } = {}
) {
  const resolvedPeriod = period || resolveHealthSnapshotPeriod("10w");
  const calendarDays = Math.max(
    1,
    Number(raw?.period?.calendar_days) || resolvedPeriod.calendar_days
  );
  const rawCoverage = raw?.coverage && typeof raw.coverage === "object" ? raw.coverage : {};
  const daysWithAnyData = Math.max(
    0,
    Math.min(calendarDays, Number(rawCoverage.days_with_any_data) || 0)
  );
  const coverage = {
    calendar_days: calendarDays,
    days_with_any_data: daysWithAnyData,
    missing_days: Math.max(0, calendarDays - daysWithAnyData),
    completeness_percent: round((daysWithAnyData / calendarDays) * 100, 1),
    food_logged_days: Math.max(0, Number(rawCoverage.food_logged_days) || 0),
    workout_logged_days: Math.max(0, Number(rawCoverage.workout_logged_days) || 0),
    measurement_logged_days: Math.max(
      0,
      Number(rawCoverage.measurement_logged_days) || 0
    ),
    missing_days_are_unknown_not_zero: true,
  };
  const measures = (Array.isArray(raw?.measure_summaries)
    ? raw.measure_summaries
    : []
  )
    .map((item) => normalizedMeasureSummary(item, calendarDays))
    .filter(Boolean);
  const context = (Array.isArray(raw?.recorded_context)
    ? raw.recorded_context
    : []
  )
    .map(boundedContext)
    .filter(Boolean);
  const measurementSeries = (Array.isArray(raw?.measurement_points)
    ? raw.measurement_points
    : []
  )
    .map(boundedMeasurementPoint)
    .filter(Boolean)
    .slice(0, 5_000);
  const provenanceRaw =
    raw?.food_provenance && typeof raw.food_provenance === "object"
      ? raw.food_provenance
      : {};
  const entries = Math.max(0, Number(provenanceRaw.entries) || 0);
  const verified = Math.max(0, Number(provenanceRaw.verified_entries) || 0);
  const estimated = Math.max(0, Number(provenanceRaw.estimated_entries) || 0);
  const document = {
    schema: HEALTH_SNAPSHOT_VERSION,
    generated_at: generatedAt,
    subject: nickname ? { nickname: String(nickname).slice(0, 60) } : {},
    period: {
      key: resolvedPeriod.key,
      label: resolvedPeriod.label,
      from: dateKey(raw?.period?.from, resolvedPeriod.from),
      to: dateKey(raw?.period?.to, resolvedPeriod.to),
      calendar_days: calendarDays,
    },
    scope:
      "User-recorded observational data. No diagnosis, treatment recommendation, or causal conclusion.",
    completeness: coverage,
    observed_changes: trendHighlights(measures),
    nutrition_patterns: measures.filter((measure) => measure.group === "nutrition"),
    micronutrient_patterns: measures.filter(
      (measure) => measure.group === "micronutrient"
    ),
    activity_patterns: {
      sessions: Math.max(0, Number(raw?.workouts?.sessions) || 0),
      days: Math.max(0, Number(raw?.workouts?.days) || 0),
      measures: measures.filter((measure) => measure.group === "activity"),
    },
    body_measurements: measures.filter((measure) => measure.group === "body"),
    measurement_series: measurementSeries,
    recorded_context: context,
    statistical_outliers: measures
      .filter((measure) => measure.statistical_outlier_count > 0)
      .map((measure) => ({
        measure_id: measure.measure_id,
        label: measure.label,
        count: measure.statistical_outlier_count,
        definition:
          "Recorded daily value more than 2.5 standard deviations from this period's logged-day average.",
      })),
    data_quality: {
      food_entries: entries,
      verified_or_user_confirmed_entries: Math.min(entries, verified),
      estimated_or_unclassified_entries: Math.max(0, Math.min(entries, estimated)),
      estimated_portions: Math.max(
        0,
        Number(provenanceRaw.estimated_portions) || 0
      ),
      limitations: [
        `${coverage.missing_days} of ${calendarDays} calendar days have no recorded data and are treated as missing, not zero.`,
        "Nutrition totals reflect only foods and quantities that were recorded.",
        "Food-database values, labels, visual estimates, and user-entered measurements can each have different uncertainty.",
        "Observed timing and trends do not prove that one recorded factor caused another.",
      ],
    },
    optional_clinician_questions: [],
  };
  document.optional_clinician_questions = clinicianQuestions({
    measures,
    context,
    coverage,
  });
  return document;
}

function valueLine(measure) {
  if (measure.average_on_logged_days == null) return null;
  return `${measure.label}: ${measure.average_on_logged_days} ${measure.unit || ""} average on ${measure.days_logged} logged day${measure.days_logged === 1 ? "" : "s"}; ${measure.missing_days} missing day${measure.missing_days === 1 ? "" : "s"}.`;
}

export function formatHealthSnapshot(document) {
  const lines = [
    "BIGBRICEY HEALTH SNAPSHOT",
    `${document.period.label}: ${document.period.from} through ${document.period.to}`,
    `Generated: ${document.generated_at}`,
    "",
    "Purpose",
    document.scope,
    "",
    "Record completeness",
    `${document.completeness.days_with_any_data} of ${document.completeness.calendar_days} days contain recorded data (${document.completeness.completeness_percent}%). ${document.completeness.missing_days} days are missing—not zero.`,
    `Food logged: ${document.completeness.food_logged_days} days · Workouts logged: ${document.completeness.workout_logged_days} days · Measurements logged: ${document.completeness.measurement_logged_days} days`,
    "",
    "Observed changes from recorded values",
    ...(document.observed_changes.length
      ? document.observed_changes.map(
          (item) =>
            `${item.label}: ${item.from} ${item.unit} on ${item.first_day} to ${item.to} ${item.unit} on ${item.latest_day} (${item.change >= 0 ? "+" : ""}${item.change} ${item.unit}). ${item.interpretation}`
        )
      : ["No body or activity measure has enough recorded points for a change summary."]),
    "",
    "Nutrition and micronutrients (logged days only)",
    ...[
      ...document.nutrition_patterns,
      ...document.micronutrient_patterns,
    ]
      .map(valueLine)
      .filter(Boolean),
    ...(document.nutrition_patterns.length || document.micronutrient_patterns.length
      ? []
      : ["No nutrition data is recorded in this period."]),
    "",
    "Workouts and activity",
    `${document.activity_patterns.sessions} recorded sessions across ${document.activity_patterns.days} days.`,
    ...document.activity_patterns.measures.map(valueLine).filter(Boolean),
    "",
    "Body measurements",
    ...(document.body_measurements.length
      ? document.body_measurements.map(valueLine).filter(Boolean)
      : ["No body measurements are recorded in this period."]),
    "",
    "User-recorded context",
    ...(document.recorded_context.length
      ? document.recorded_context.map(
          (item) => `${item.day}: ${item.title} (${item.category})`
        )
      : ["No symptom, supplement, medication, laboratory, or contextual note was identified in this period."]),
    "",
    "Statistical outliers",
    ...(document.statistical_outliers.length
      ? document.statistical_outliers.map(
          (item) => `${item.label}: ${item.count}. ${item.definition}`
        )
      : ["No qualifying outliers were found among measures with at least five logged days."]),
    "",
    "Data quality and limits",
    `${document.data_quality.verified_or_user_confirmed_entries} food entries are marked verified or user-confirmed; ${document.data_quality.estimated_or_unclassified_entries} are estimated or do not yet have modern provenance; ${document.data_quality.estimated_portions} use estimated portions.`,
    ...document.data_quality.limitations.map((item) => `- ${item}`),
    "",
    "Optional questions for a clinician",
    ...(document.optional_clinician_questions.length
      ? document.optional_clinician_questions.map((item) => `- ${item}`)
      : ["- What additional measurements would make this record more useful?"]),
    "",
    "This snapshot is a user-controlled data summary, not medical advice. It was not sent anywhere automatically.",
  ];
  return lines.join("\n");
}

export async function readHealthRangeSummary(accountId, from, to) {
  const id = normalizeAccountId(accountId);
  if (!id) throw new Error("invalid account id");
  const result = await sbRpc("read_health_range_summary", {
    p_account_id: id,
    p_from: from,
    p_to: to,
  });
  return result && typeof result === "object" ? result : {};
}

export async function buildHealthSnapshot(email, { period = "10w", to } = {}) {
  const accountId = await accountIdForEmail(email);
  const profile = await getProfileByAccountId(accountId);
  const availableFrom = dateKey(String(profile?.created_at || "").slice(0, 10));
  const resolved = resolveHealthSnapshotPeriod(period, { to, availableFrom });
  const raw = await readHealthRangeSummary(accountId, resolved.from, resolved.to);
  const settings = normalizeCompanionSettings(profile?.prefs?.assistant_settings);
  const onboarding = onboardingFromPrefs(profile?.prefs);
  const nickname = settings.nickname || onboarding.preferred_name || "";
  const document = buildHealthSnapshotDocument(raw, {
    period: resolved,
    nickname,
  });
  return {
    account_id: accountId,
    document,
    report_text: formatHealthSnapshot(document),
  };
}

export function validateSnapshotEdit(value) {
  const text = String(value || "").replace(/\u0000/g, "").trim();
  if (!text || text.length > 60_000) {
    const error = new Error("Snapshot text must be between 1 and 60,000 characters.");
    error.code = "invalid_snapshot_text";
    error.status = 400;
    throw error;
  }
  return text;
}

export async function saveHealthSnapshot(
  accountId,
  { periodKey, title = "Health Snapshot", document, reportText } = {}
) {
  const id = normalizeAccountId(accountId);
  if (!id) throw new Error("invalid account id");
  const safeTitle = String(title || "Health Snapshot").trim().slice(0, 120);
  const text = validateSnapshotEdit(reportText);
  const rows = await sb("health_snapshots", {
    method: "POST",
    body: {
      account_id: id,
      period_key: PERIODS[periodKey] ? periodKey : "10w",
      date_from: document.period.from,
      date_to: document.period.to,
      title: safeTitle || "Health Snapshot",
      report_text: text,
      structured_data: document,
      source_version: HEALTH_SNAPSHOT_VERSION,
    },
  });
  return rows?.[0] || null;
}

export async function listHealthSnapshots(accountId, { limit = 20 } = {}) {
  const id = normalizeAccountId(accountId);
  if (!id) throw new Error("invalid account id");
  return (
    (await sb("health_snapshots", {
      query: {
        select:
          "id,period_key,date_from,date_to,title,source_version,created_at,updated_at",
        account_id: `eq.${id}`,
        order: "created_at.desc",
        limit: String(Math.max(1, Math.min(50, Number(limit) || 20))),
      },
    })) || []
  );
}

export async function getHealthSnapshot(accountId, snapshotId) {
  const id = normalizeAccountId(accountId);
  const snapshot = normalizeAccountId(snapshotId);
  if (!id || !snapshot) return null;
  const rows = await sb("health_snapshots", {
    query: {
      select: "*",
      id: `eq.${snapshot}`,
      account_id: `eq.${id}`,
      limit: "1",
    },
  });
  return rows?.[0] || null;
}

export async function updateHealthSnapshot(
  accountId,
  snapshotId,
  { title, reportText } = {}
) {
  const existing = await getHealthSnapshot(accountId, snapshotId);
  if (!existing) return null;
  const body = {};
  if (title != null) {
    const safeTitle = String(title).trim().slice(0, 120);
    if (!safeTitle) throw new Error("snapshot title required");
    body.title = safeTitle;
  }
  if (reportText != null) body.report_text = validateSnapshotEdit(reportText);
  if (!Object.keys(body).length) throw new Error("snapshot update required");
  const rows = await sb("health_snapshots", {
    method: "PATCH",
    query: {
      id: `eq.${existing.id}`,
      account_id: `eq.${normalizeAccountId(accountId)}`,
    },
    body,
  });
  return rows?.[0] || null;
}
