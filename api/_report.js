/**
 * Stats export packs — paste into another AI / hand a doctor.
 * Not medical advice. Averages from day_totals + profile.
 */
import { dayKeyFor, sb, getProfile, onboardingFromPrefs } from "./_supabase.js";

function shiftDay(day, delta) {
  const d = new Date(day + "T12:00:00");
  d.setDate(d.getDate() + delta);
  return d.toISOString().slice(0, 10);
}

function avg(nums) {
  const a = nums.filter((n) => Number.isFinite(n));
  if (!a.length) return null;
  return a.reduce((s, n) => s + n, 0) / a.length;
}

/**
 * @param {string} email
 * @param {{ days?: number, to?: string }} opts
 */
export async function buildStatsReport(email, opts = {}) {
  const e = String(email || "").toLowerCase();
  const days = Math.min(365, Math.max(7, Number(opts.days) || 30));
  const to = opts.to || dayKeyFor();
  const from = shiftDay(to, -(days - 1));

  const profile = await getProfile(e);
  const onboarding = onboardingFromPrefs(profile?.prefs);
  const goals = onboarding.goals || {};

  const measureIds = [
    "kcal",
    "protein",
    "fat",
    "carbs",
    "fiber",
    "potassium",
    "magnesium",
    "sodium",
    "steps",
  ];

  const series = {};
  for (const m of measureIds) {
    const rows = await sb("day_totals", {
      query: {
        select: "day_key,measure_id,total,unit",
        user_email: `eq.${e}`,
        measure_id: `eq.${m}`,
        day_key: `gte.${from}`,
        order: "day_key.asc",
        limit: "500",
      },
    });
    const filtered = (rows || []).filter((r) => r.day_key <= to);
    series[m] = filtered;
  }

  const averages = {};
  for (const m of measureIds) {
    const vals = (series[m] || []).map((r) => Number(r.total));
    const a = avg(vals);
    averages[m] =
      a == null
        ? null
        : {
            avg: Math.round(a * 10) / 10,
            days_logged: vals.filter((v) => Number.isFinite(v) && v > 0).length,
            unit:
              m === "kcal"
                ? "kcal"
                : m === "steps"
                  ? "steps"
                  : m === "potassium" || m === "magnesium" || m === "sodium"
                    ? "mg"
                    : "g",
          };
  }

  const weightRows = await sb("day_totals", {
    query: {
      select: "day_key,total",
      user_email: `eq.${e}`,
      measure_id: "eq.weight_lb",
      day_key: `gte.${from}`,
      order: "day_key.asc",
      limit: "100",
    },
  }).catch(() => []);

  const events = await sb("events", {
    query: {
      select: "day_key,category_id,title,occurred_at",
      user_email: `eq.${e}`,
      day_key: `gte.${from}`,
      deleted_at: "is.null",
      order: "occurred_at.desc",
      limit: "80",
    },
  }).catch(() => []);

  const exercise = (events || []).filter(
    (ev) =>
      ev.category_id === "exercise" ||
      String(ev.category_id || "").includes("push") ||
      /workout|run|bike|lift|train/i.test(ev.title || "")
  );

  const pack = {
    generated_at: new Date().toISOString(),
    product: "BigBricey",
    disclaimer:
      "Data export only — not medical advice. Discuss with a qualified professional. Food quality and context matter; averages are incomplete without that.",
    period: { from, to, days },
    profile: {
      first_name: onboarding.first_name,
      sex: onboarding.sex,
      birthday: onboarding.birthday,
      height_in: onboarding.height_in,
      current_weight_lb: onboarding.current_weight_lb,
      goal_weight_lb: onboarding.goal_weight_lb,
      primary_goal: onboarding.primary_goal,
      activity_level: onboarding.activity_level,
      training_level: onboarding.training_level,
      eating_style: onboarding.eating_style,
      targets: {
        kcal: goals.kcal,
        protein_g: goals.protein,
        fat_g: goals.fat,
        carbs_g: goals.carbs,
        tdee_est: goals.tdee,
      },
    },
    averages_per_logged_day: averages,
    weight_points: (weightRows || []).map((r) => ({
      day: r.day_key,
      lb: Number(r.total),
    })),
    recent_exercise_titles: exercise.slice(0, 25).map((ev) => ({
      day: ev.day_key,
      title: ev.title,
    })),
    reference_baselines_not_prescriptions: {
      potassium_mg_common_target: 3500,
      magnesium_mg_common_target: 350,
    },
  };

  const text = formatReportText(pack);
  return { pack, text };
}

function formatReportText(pack) {
  const a = pack.averages_per_logged_day || {};
  const line = (m, label) => {
    const x = a[m];
    if (!x || x.avg == null) return `${label}: (no data)`;
    return `${label}: ~${x.avg} ${x.unit}/day (${x.days_logged} days with data)`;
  };
  const p = pack.profile || {};
  const t = p.targets || {};
  const lines = [
    "=== BigBricey health data export ===",
    `Generated: ${pack.generated_at}`,
    `Period: ${pack.period.from} → ${pack.period.to} (${pack.period.days} days)`,
    "",
    pack.disclaimer,
    "",
    "— Profile —",
    `Name: ${p.first_name || "—"}`,
    `Sex: ${p.sex || "—"} · Birthday: ${p.birthday || "—"}`,
    `Height: ${p.height_in != null ? p.height_in + " in" : "—"} · Weight: ${p.current_weight_lb ?? "—"} lb · Goal wt: ${p.goal_weight_lb ?? "—"} lb`,
    `Goal: ${p.primary_goal || "—"} · Activity: ${p.activity_level || "—"} · Training: ${p.training_level || "—"}`,
    `Eating style: ${p.eating_style || "—"}`,
    `Targets: ${t.kcal ?? "—"} kcal · P ${t.protein_g ?? "—"}g · F ${t.fat_g ?? "—"}g · C ${t.carbs_g ?? "—"}g · TDEE est ${t.tdee_est ?? "—"}`,
    "",
    "— Averages (from logged days) —",
    line("kcal", "Calories"),
    line("protein", "Protein"),
    line("fat", "Fat"),
    line("carbs", "Carbs"),
    line("fiber", "Fiber"),
    line("potassium", "Potassium"),
    line("magnesium", "Magnesium"),
    line("sodium", "Sodium"),
    line("steps", "Steps"),
    "",
    "— Recent weight points —",
    ...(pack.weight_points?.length
      ? pack.weight_points.map((w) => `${w.day}: ${w.lb} lb`)
      : ["(none)"]),
    "",
    "— Recent exercise / activity titles —",
    ...(pack.recent_exercise_titles?.length
      ? pack.recent_exercise_titles.map((x) => `${x.day}: ${x.title}`)
      : ["(none)"]),
    "",
    "— Reference baselines (not prescriptions) —",
    `Potassium common target: ${pack.reference_baselines_not_prescriptions.potassium_mg_common_target} mg`,
    `Magnesium common target: ${pack.reference_baselines_not_prescriptions.magnesium_mg_common_target} mg`,
    "",
    "Paste this into your doctor visit notes or another AI agent for discussion.",
    "=== end export ===",
  ];
  return lines.join("\n");
}
