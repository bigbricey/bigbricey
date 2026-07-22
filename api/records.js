import { requireUser, sendJson } from "./_auth.js";
import {
  buildHealthSnapshot,
  buildHealthSnapshotDocument,
  getHealthSnapshot,
  listHealthSnapshots,
  readHealthRangeSummary,
} from "./_health_snapshot.js";
import {
  accountIdForEmail,
  consumeAccountRateLimit,
  ensureProfile,
  getProfileByAccountId,
  normalizeAccountId,
  onboardingFromPrefs,
  recordAccountAudit,
  sbRpc,
} from "./_supabase.js";

const RESOURCES = new Set([
  "summary",
  "nutrition",
  "food_history",
  "workouts",
  "measurements",
  "goals",
  "trends",
  "snapshots",
  "snapshot",
]);

function dateKey(value) {
  const day = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

function uuid(value) {
  return normalizeAccountId(value);
}

function calendarDays(from, to) {
  return Math.round(
    (new Date(`${to}T12:00:00.000Z`) - new Date(`${from}T12:00:00.000Z`)) /
      86_400_000
  ) + 1;
}

async function documentForRequest(email, accountId, url) {
  const from = dateKey(url.searchParams.get("from"));
  const to = dateKey(url.searchParams.get("to"));
  if (from || to) {
    if (!from || !to || from > to || calendarDays(from, to) > 36_525) {
      const error = new Error("Choose a valid date range of 100 years or less.");
      error.code = "invalid_date_range";
      error.status = 400;
      throw error;
    }
    const raw = await readHealthRangeSummary(accountId, from, to);
    return buildHealthSnapshotDocument(raw, {
      period: {
        key: "custom",
        label: "Custom range",
        from,
        to,
        calendar_days: calendarDays(from, to),
      },
    });
  }
  return (await buildHealthSnapshot(email, {
    period: url.searchParams.get("period") || "10w",
  })).document;
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.setHeader("Allow", "GET, OPTIONS");
    return res.status(204).end();
  }
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET, OPTIONS");
    return sendJson(res, 405, { error: "read_only_service" });
  }
  const user = await requireUser(req, res);
  if (!user) return;
  let accountId = null;
  try {
    await ensureProfile(user.email);
    accountId = await accountIdForEmail(user.email);
    const allowed = await consumeAccountRateLimit(accountId, "records_read", {
      maxEvents: 60,
      windowSeconds: 60,
    });
    if (!allowed) return sendJson(res, 429, { error: "rate_limited" });
    const url = new URL(req.url, `https://${req.headers.host}`);
    const resource = String(url.searchParams.get("resource") || "summary");
    if (!RESOURCES.has(resource)) {
      return sendJson(res, 400, { error: "unsupported_record_resource" });
    }

    let data;
    if (resource === "snapshots") {
      data = { snapshots: await listHealthSnapshots(accountId) };
    } else if (resource === "snapshot") {
      const id = uuid(url.searchParams.get("id"));
      if (!id) return sendJson(res, 400, { error: "snapshot_id_required" });
      const snapshot = await getHealthSnapshot(accountId, id);
      if (!snapshot) return sendJson(res, 404, { error: "snapshot_not_found" });
      data = { snapshot };
    } else if (resource === "goals") {
      const profile = await getProfileByAccountId(accountId);
      const onboarding = onboardingFromPrefs(profile?.prefs);
      data = {
        goals: {
          primary_goal: onboarding.primary_goal,
          eating_style: onboarding.eating_style,
          targets: onboarding.goals || null,
        },
      };
    } else {
      const document = await documentForRequest(user.email, accountId, url);
      if (resource === "summary") data = { summary: document };
      if (resource === "nutrition") {
        data = {
          period: document.period,
          completeness: document.completeness,
          nutrition: document.nutrition_patterns,
          micronutrients: document.micronutrient_patterns,
          data_quality: document.data_quality,
        };
      }
      if (resource === "workouts") {
        data = {
          period: document.period,
          completeness: document.completeness,
          activity: document.activity_patterns,
        };
      }
      if (resource === "measurements") {
        data = {
          period: document.period,
          completeness: document.completeness,
          body_measurements: document.body_measurements,
          measurement_series: document.measurement_series,
          observed_changes: document.observed_changes,
        };
      }
      if (resource === "trends") {
        data = {
          period: document.period,
          completeness: document.completeness,
          observed_changes: document.observed_changes,
          statistical_outliers: document.statistical_outliers,
        };
      }
      if (resource === "food_history") {
        data = await sbRpc("read_food_history_summary", {
          p_account_id: accountId,
          p_from: document.period.from,
          p_to: document.period.to,
          p_limit: Math.max(
            1,
            Math.min(200, Number(url.searchParams.get("limit")) || 50)
          ),
        });
      }
    }

    recordAccountAudit(accountId, {
      action: "read",
      resourceType: `record_${resource}`,
      metadata: { aggregated: true },
    }).catch(() => {});
    return sendJson(res, 200, {
      resource,
      account_scope: "current_session",
      aggregated: true,
      data,
    });
  } catch (error) {
    const status = Number(error?.status);
    return sendJson(res, status >= 400 && status < 500 ? status : 503, {
      error: String(error?.code || "records_unavailable"),
      message:
        status >= 400 && status < 500
          ? String(error.message)
          : "The requested records are temporarily unavailable.",
    });
  }
}
