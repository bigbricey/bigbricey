import { requireUser, sendJson } from "./_auth.js";
import { readBody } from "./_lib.js";
import {
  dayKeyFor,
  loadFoodDay,
  syncFoodDay,
  ensureProfile,
  logEvent,
  sb,
  supabaseConfig,
  listWatchTargets,
  upsertWatchTarget,
  deleteWatchTarget,
  evaluateWatches,
  seedDefaultWatches,
  getProfile,
  onboardingFromPrefs,
  saveOnboarding,
  computeGoalsFromOnboarding,
  dayTotalsForMeasures,
} from "./_supabase.js";
import { buildStatsReport } from "./_report.js";
import {
  isAdmin,
  listFeedback,
  markFeedback,
  markFeedbackTheme,
  submitFeedback,
  summarizeFeedback,
} from "./_members.js";

/**
 * Unified log API (Hobby-friendly single function).
 *
 * GET  /api/log?date=YYYY-MM-DD
 * GET  /api/log?from=&to=&measure=
 * GET  /api/log?watches=1          → targets + rolling status
 * POST /api/log  { rows }          → sync food day
 * POST /api/log  { categoryId… }   → event
 * POST /api/log  { op:"watch", … } → set/delete watch target
 * POST /api/log  { op:"onboarding", … } → save intake profile for coach
 * GET  /api/log?onboarding=1       → read onboarding profile
 */
export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    return res.status(204).end();
  }

  const user = await requireUser(req, res);
  if (!user) return;

  if (!supabaseConfig().ok) {
    return sendJson(res, 503, {
      error: "supabase_not_configured",
      message: "Cloud log not configured yet.",
    });
  }

  try {
    await ensureProfile(user.email, { name: user.name, picture: user.picture });
    const url = new URL(req.url, `https://${req.headers.host}`);
    const path = url.pathname.replace(/\/$/, "");
    const isHistory =
      path.endsWith("/history") ||
      (url.searchParams.has("from") &&
        !url.searchParams.has("watches") &&
        !url.searchParams.has("alerts") &&
        !url.searchParams.has("calendar"));
    const isEvent =
      path.endsWith("/event") ||
      (req.method === "POST" && url.searchParams.get("type") === "event");
    const wantWatches =
      url.searchParams.get("watches") === "1" ||
      url.searchParams.get("section") === "watches";
    const wantAlerts = url.searchParams.get("alerts") === "1";
    const wantCalendar = url.searchParams.get("calendar") === "1";
    const wantFeedback = url.searchParams.get("feedback") === "1";
    const wantOnboarding = url.searchParams.get("onboarding") === "1";
    const wantReport = url.searchParams.get("report") === "1";
    const wantBoxes = url.searchParams.get("boxes") === "1";

    if (req.method === "GET" && wantBoxes) {
      const day = url.searchParams.get("date") || dayKeyFor();
      const profile = await getProfile(user.email);
      const prefs =
        profile?.prefs && typeof profile.prefs === "object" ? profile.prefs : {};
      const boxes = Array.isArray(prefs.boxes) ? prefs.boxes : [];
      const measureIds = boxes.map((b) => b.measure_id).filter(Boolean);
      // also accept ?measures=a,b
      const extra = String(url.searchParams.get("measures") || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const values = await dayTotalsForMeasures(
        user.email,
        [...measureIds, ...extra],
        day
      );
      return sendJson(res, 200, { day, boxes, values, totals: values });
    }

    if (req.method === "GET" && wantReport) {
      const days = Number(url.searchParams.get("days") || 30);
      const result = await buildStatsReport(user.email, { days });
      return sendJson(res, 200, result);
    }

    if (req.method === "GET" && wantOnboarding) {
      const profile = await getProfile(user.email);
      const onboarding = onboardingFromPrefs(profile?.prefs);
      return sendJson(res, 200, { onboarding, goals: onboarding.goals || null });
    }

    if (req.method === "GET" && wantFeedback) {
      if (!(await isAdmin(user.email))) {
        return sendJson(res, 403, { error: "admin_only" });
      }
      const items = await listFeedback({ limit: 200 });
      const summary = await summarizeFeedback({ limit: 200 });
      return sendJson(res, 200, { feedback: items, summary });
    }

    if (req.method === "GET" && wantWatches) {
      await seedDefaultWatches(user.email);
      const targets = await listWatchTargets(user.email);
      const evaluated = await evaluateWatches(user.email);
      return sendJson(res, 200, {
        targets,
        statuses: evaluated.statuses,
        newAlerts: evaluated.newAlerts,
      });
    }

    if (req.method === "GET" && wantAlerts) {
      const email = String(user.email).toLowerCase();
      // refresh watches so new alerts can open
      try {
        await evaluateWatches(user.email);
      } catch {
        /* ok */
      }
      const rows = await sb("alerts", {
        query: {
          select: "*",
          user_email: `eq.${email}`,
          order: "created_at.desc",
          limit: "50",
        },
      });
      return sendJson(res, 200, {
        alerts: rows || [],
        open: (rows || []).filter((a) => a.status === "open"),
      });
    }

    if (req.method === "GET" && wantCalendar) {
      return await handleCalendar(user, url);
    }

    if (req.method === "GET" && isHistory) {
      return await handleHistory(req, res, user, url);
    }
    if (req.method === "GET") {
      const day = url.searchParams.get("date") || dayKeyFor();
      const rows = await loadFoodDay(user.email, day);
      return sendJson(res, 200, { day, rows, source: "supabase" });
    }

    if (req.method === "POST") {
      const body = await readBody(req);

      if (body.op === "watch" || body.op === "set_watch") {
        const result = await upsertWatchTarget(user.email, {
          measureId: body.measureId || body.measure_id || body.measure,
          label: body.label,
          mode: body.mode || "floor",
          targetMin: body.targetMin ?? body.target_min ?? body.min,
          targetMax: body.targetMax ?? body.target_max ?? body.max,
          windowDays: body.windowDays ?? body.window_days ?? 7,
          unit: body.unit || "",
          severity: body.severity || "yellow",
          notes: body.notes,
        });
        const evaluated = await evaluateWatches(user.email);
        return sendJson(res, 200, { ...result, statuses: evaluated.statuses });
      }

      if (body.op === "delete_watch" && body.id) {
        await deleteWatchTarget(user.email, body.id);
        return sendJson(res, 200, { ok: true });
      }

      if (body.op === "ack_alert" && body.id) {
        const email = String(user.email).toLowerCase();
        await sb("alerts", {
          method: "PATCH",
          query: { id: `eq.${body.id}`, user_email: `eq.${email}` },
          body: {
            status: body.status || "acked",
            resolved_at: new Date().toISOString(),
          },
          headers: { Prefer: "return=minimal" },
        });
        return sendJson(res, 200, { ok: true });
      }

      if (body.op === "feedback") {
        const msg = body.message || body.text;
        const row = await submitFeedback(user.email, msg, {
          name: user.name,
          source: body.source || "form",
          category: body.category,
          theme_key: body.theme_key || body.themeKey,
          theme_label: body.theme_label || body.themeLabel,
        });
        return sendJson(res, 200, { ok: true, id: row?.id, theme_key: row?.theme_key });
      }

      if (body.op === "feedback_status" && body.id) {
        if (!(await isAdmin(user.email))) {
          return sendJson(res, 403, { error: "admin_only" });
        }
        await markFeedback(body.id, body.status || "read");
        return sendJson(res, 200, { ok: true });
      }

      if (body.op === "feedback_theme_status" && body.theme_key) {
        if (!(await isAdmin(user.email))) {
          return sendJson(res, 403, { error: "admin_only" });
        }
        await markFeedbackTheme(body.theme_key, body.status || "read");
        return sendJson(res, 200, { ok: true });
      }

      if (body.op === "onboarding_preview") {
        const data = body.onboarding || body.profile || body;
        const draft = {
          first_name: data.first_name ?? data.firstName,
          primary_goal: data.primary_goal ?? data.primaryGoal,
          lose_rate_lb_week:
            data.lose_rate_lb_week ?? data.loseRateLbWeek ?? data.lose_rate,
          activity_level: data.activity_level ?? data.activityLevel,
          training_level: data.training_level ?? data.trainingLevel,
          birthday: data.birthday,
          sex: data.sex,
          height_in: data.height_in ?? data.heightIn,
          current_weight_lb: data.current_weight_lb ?? data.currentWeightLb,
          goal_weight_lb: data.goal_weight_lb ?? data.goalWeightLb,
          kcal_confirmed: data.kcal_confirmed ?? data.kcalConfirmed,
        };
        const goals = computeGoalsFromOnboarding(draft);
        return sendJson(res, 200, {
          goals,
          estimate_only: true,
          note: "Estimate only — not medical advice. Confirm a target you can sustain.",
        });
      }

      if (body.op === "onboarding") {
        const data = body.onboarding || body.profile || body;
        const onboarding = await saveOnboarding(user.email, {
          first_name: data.first_name ?? data.firstName,
          primary_goal: data.primary_goal ?? data.primaryGoal,
          lose_rate_lb_week:
            data.lose_rate_lb_week ?? data.loseRateLbWeek ?? data.lose_rate,
          activity_level: data.activity_level ?? data.activityLevel,
          training_level: data.training_level ?? data.trainingLevel,
          eating_style: data.eating_style ?? data.eatingStyle,
          obstacles: data.obstacles,
          confidence: data.confidence,
          birthday: data.birthday,
          sex: data.sex,
          height_in: data.height_in ?? data.heightIn,
          current_weight_lb: data.current_weight_lb ?? data.currentWeightLb,
          goal_weight_lb: data.goal_weight_lb ?? data.goalWeightLb,
          kcal_confirmed: data.kcal_confirmed ?? data.kcalConfirmed ?? data.kcal,
          consent_health: data.consent_health ?? data.consentHealth,
          consent_marketing: data.consent_marketing ?? data.consentMarketing,
          consented_at: data.consented_at ?? data.consentedAt,
          complete: data.complete !== false,
        });
        // Seed watches at the REAL targets (not 85% of kcal — that was showing as "Goal")
        if (onboarding.goals?.kcal) {
          try {
            await upsertWatchTarget(user.email, {
              measureId: "kcal",
              label: "Calories",
              mode: "ceiling",
              targetMax: onboarding.goals.kcal,
              targetMin: onboarding.goals.kcal,
              windowDays: 1,
              unit: "kcal",
              severity: "yellow",
              notes: "From onboarding",
            });
            if (onboarding.goals.protein) {
              await upsertWatchTarget(user.email, {
                measureId: "protein",
                label: "Protein",
                mode: "floor",
                targetMin: onboarding.goals.protein,
                windowDays: 1,
                unit: "g",
                severity: "yellow",
                notes: "From onboarding",
              });
            }
          } catch {
            /* non-fatal */
          }
        }
        return sendJson(res, 200, {
          ok: true,
          onboarding,
          goals: onboarding.goals || null,
        });
      }

      if (
        isEvent ||
        body.categoryId ||
        body.category ||
        (body.measures && !body.rows)
      ) {
        const result = await logEvent(user.email, {
          categoryId: body.categoryId || body.category || "custom",
          categoryLabel: body.categoryLabel,
          categoryKind: body.categoryKind,
          title: body.title || body.label || "",
          rawText: body.rawText || body.text || null,
          dayKey: body.date || body.day || dayKeyFor(),
          occurredAt: body.occurredAt || null,
          payload: body.payload || body,
          measures: Array.isArray(body.measures) ? body.measures : [],
          clientId: body.clientId || body.id || null,
          source: body.source || "chat",
        });
        return sendJson(res, 200, result);
      }

      const day = body.date || dayKeyFor();
      const rows = Array.isArray(body.rows) ? body.rows : [];
      const result = await syncFoodDay(user.email, day, rows, {
        rawText: body.rawText || null,
      });
      return sendJson(res, 200, result);
    }

    return sendJson(res, 405, { error: "GET or POST only" });
  } catch (e) {
    return sendJson(res, 500, {
      error: String(e.message || e),
      detail: e.detail || null,
    });
  }
}

async function handleHistory(req, res, user, url) {
  const to = url.searchParams.get("to") || dayKeyFor();
  const from =
    url.searchParams.get("from") ||
    shiftDay(to, -29);
  const measure = url.searchParams.get("measure");
  const measuresRaw = url.searchParams.get("measures");
  const email = String(user.email).toLowerCase();

  const measureList = measuresRaw
    ? measuresRaw.split(",").map((s) => s.trim()).filter(Boolean)
    : measure
      ? [measure]
      : [];

  if (measureList.length) {
    const byMeasure = {};
    for (const m of measureList) {
      const rows = await sb("day_totals", {
        query: {
          select: "day_key,measure_id,total,unit",
          user_email: `eq.${email}`,
          measure_id: `eq.${m}`,
          day_key: `gte.${from}`,
          order: "day_key.asc",
        },
      });
      byMeasure[m] = (rows || []).filter(
        (r) => r.day_key >= from && r.day_key <= to
      );
    }
    // fill continuous day axis
    const days = enumerateDays(from, to);
    return sendJson(res, 200, {
      from,
      to,
      days,
      measures: measureList,
      series: byMeasure,
    });
  }

  const events = await sb("events", {
    query: {
      select: "id,category_id,day_key,title,payload,occurred_at",
      user_email: `eq.${email}`,
      day_key: `gte.${from}`,
      deleted_at: "is.null",
      order: "occurred_at.desc",
      limit: "500",
    },
  });
  const filtered = (events || []).filter((r) => r.day_key <= to);
  return sendJson(res, 200, { from, to, events: filtered });
}

async function handleCalendar(user, url) {
  const email = String(user.email).toLowerCase();
  const to = url.searchParams.get("to") || dayKeyFor();
  const days = Math.min(90, Math.max(7, Number(url.searchParams.get("days") || 30)));
  const from = shiftDay(to, -(days - 1));

  // food event counts per day
  const events = await sb("events", {
    query: {
      select: "day_key,category_id",
      user_email: `eq.${email}`,
      day_key: `gte.${from}`,
      deleted_at: "is.null",
      limit: "2000",
    },
  });

  const byDay = {};
  for (const d of enumerateDays(from, to)) {
    byDay[d] = { day: d, food: 0, other: 0, total: 0 };
  }
  for (const ev of events || []) {
    if (!byDay[ev.day_key] || ev.day_key > to) continue;
    if (ev.category_id === "food") byDay[ev.day_key].food += 1;
    else byDay[ev.day_key].other += 1;
    byDay[ev.day_key].total += 1;
  }

  // pull kcal totals for heat
  const kcals = await sb("day_totals", {
    query: {
      select: "day_key,total",
      user_email: `eq.${email}`,
      measure_id: "eq.kcal",
      day_key: `gte.${from}`,
      order: "day_key.asc",
    },
  });
  for (const r of kcals || []) {
    if (byDay[r.day_key]) byDay[r.day_key].kcal = Number(r.total) || 0;
  }

  return sendJson(res, 200, {
    from,
    to,
    days: Object.values(byDay),
  });
}

function shiftDay(dayKey, delta) {
  const [y, m, d] = String(dayKey).split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
}

function enumerateDays(from, to) {
  const out = [];
  let cur = from;
  let guard = 0;
  while (cur <= to && guard < 400) {
    out.push(cur);
    cur = shiftDay(cur, 1);
    guard++;
  }
  return out;
}
