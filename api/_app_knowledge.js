const CONTROL_CHARS =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b\u200e\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g;

export const CORE_TODAY_PANELS = Object.freeze([
  { id: "chat", label: "Chat", purpose: "Talk to BigBricey and perform app actions." },
  { id: "kcal", label: "Calories", purpose: "Calories left, eaten, and daily goal." },
  { id: "pro", label: "Protein", purpose: "Protein left, eaten, and daily goal." },
  { id: "fat", label: "Fat", purpose: "Fat left, eaten, and daily goal." },
  { id: "carb", label: "Carbs", purpose: "Total carbohydrates left, eaten, and daily goal." },
  { id: "net", label: "Net carbs", purpose: "Net carbohydrates left, eaten, and daily goal." },
  { id: "minerals", label: "Minerals", purpose: "Potassium, magnesium, sodium, and fiber." },
  { id: "summary", label: "Day summary", purpose: "Food count and quick daily totals." },
  { id: "food", label: "Food diary", purpose: "The selected day's recorded foods." },
]);

const CORE_IDS = new Set(CORE_TODAY_PANELS.map((panel) => panel.id));
const SAFE_SIZES = new Set(["full", "half", "third"]);
const SAFE_THEME_FIELDS = new Set([
  "preset",
  "accent",
  "bg0",
  "ring_left",
  "ring_eaten",
  "ring_goal",
  "ring_over",
  "font_scale",
  "radius",
  "density",
  "shape",
]);

export const APP_INTERFACE_GUIDE = `AUTHORITATIVE APP GUIDE
- BigBricey is a chat-first private nutrition and fitness ledger. It talks naturally, records food/workouts/steps/body metrics, reads verified records, remembers requested preferences, and controls supported parts of its own interface.
- Header: change the selected date with Previous, Next, or Today. Customize enables Today-panel rearranging and sizing.
- Today panels: Chat; Calories; Protein; Fat; Carbs; Net carbs; Minerals; Day summary; Food diary; plus saved custom counters or charts. History opens earlier chats, New starts one, and the camera offers Meal, Nutrition Label, and Barcode review modes.
- Navigation: Today is the daily home; Trends shows 7d/30d/90d recorded trends; Goals manages rolling targets; You contains profile, targets, setup, exports, theme, scenes, the full table, and account controls.
- A custom tracker is a real saved Today panel backed by recorded measurements. In a tracker, "30d" is the rolling 30-calendar-day display range; it is not a waiting period and does not require 30 entries. One recorded measurement appears immediately as one point.
- A chart summary states how many recorded points exist and the latest value. Never describe a chart as empty unless live inspection reports zero points.
- Removing a custom tracker removes the panel after confirmation; it does not delete the recorded measurement history. Changing the layout only moves or resizes panels.
- Background/theme requests change the page palette or ambient scene. They do not create a dashboard card. Food photos always produce a reviewable draft and never enter the ledger until confirmed.`;

function cleanText(value, limit = 120) {
  return String(value || "")
    .normalize("NFKC")
    .replace(CONTROL_CHARS, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

function cleanPanelId(value) {
  const id = cleanText(value, 64).toLowerCase();
  if (CORE_IDS.has(id)) return id;
  return /^c_[a-z0-9_]{1,48}$/.test(id) ? id : null;
}

function cleanMeasureId(value) {
  const id = cleanText(value, 80).toLowerCase();
  return /^[a-z0-9_]{1,80}$/.test(id) ? id : null;
}

function compactObject(value) {
  return Object.fromEntries(
    Object.entries(value || {}).filter(([, item]) => item !== undefined)
  );
}

function safeTheme(theme) {
  if (!theme || typeof theme !== "object" || Array.isArray(theme)) return null;
  const out = {};
  for (const [key, value] of Object.entries(theme)) {
    if (!SAFE_THEME_FIELDS.has(key)) continue;
    if (typeof value === "string") out[key] = cleanText(value, 40);
    else if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
  }
  return Object.keys(out).length ? out : null;
}

function safeTracker(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const id = cleanPanelId(raw.id);
  if (!id || !id.startsWith("c_")) return null;
  const kind = String(raw.kind || "counter").toLowerCase() === "chart" ? "chart" : "counter";
  const measureId = cleanMeasureId(raw.measure_id || raw.measure);
  const measures = (Array.isArray(raw.measures) ? raw.measures : [measureId])
    .map(cleanMeasureId)
    .filter(Boolean)
    .slice(0, 6);
  if (!measureId && !measures.length) return null;
  const title = cleanText(raw.title || raw.label || measureId || measures[0], 80);
  const size = SAFE_SIZES.has(raw.size) ? raw.size : kind === "chart" ? "full" : "half";
  const daysNumber = Number(raw.days);
  const days = kind === "chart"
    ? Math.min(1095, Math.max(1, Number.isFinite(daysNumber) ? Math.round(daysNumber) : 30))
    : undefined;
  const chart = kind === "chart" && ["line", "bar", "pie"].includes(raw.chart)
    ? raw.chart
    : kind === "chart"
      ? "line"
      : undefined;
  const goalNumber = Number(raw.goal);

  return compactObject({
    id,
    kind,
    title,
    measure_id: measureId || measures[0],
    measures: kind === "chart" ? measures : [measureId || measures[0]],
    unit: cleanText(raw.unit, 24),
    size,
    chart,
    days,
    goal:
      kind === "counter" && raw.goal != null && Number.isFinite(goalNumber)
        ? goalNumber
        : undefined,
    mode:
      kind === "counter"
        ? String(raw.mode || "floor").toLowerCase() === "ceiling"
          ? "ceiling"
          : "floor"
        : undefined,
  });
}

export function boundedDashboardManifest({ layout = null, trackers = [] } = {}) {
  const safeTrackers = (Array.isArray(trackers) ? trackers : [])
    .map(safeTracker)
    .filter(Boolean)
    .slice(0, 20);
  const available = new Set([
    ...CORE_TODAY_PANELS.map((panel) => panel.id),
    ...safeTrackers.map((tracker) => tracker.id),
  ]);
  const order = [];
  const seen = new Set();
  const incoming = Array.isArray(layout?.order) ? layout.order : [];
  for (const rawId of incoming) {
    const id = cleanPanelId(rawId);
    if (!id || !available.has(id) || seen.has(id)) continue;
    seen.add(id);
    order.push(id);
  }
  for (const id of available) {
    if (!seen.has(id)) order.push(id);
  }

  return {
    order,
    trackers: safeTrackers.map((tracker) => ({
      id: tracker.id,
      position: order.indexOf(tracker.id) + 1,
      ...Object.fromEntries(Object.entries(tracker).filter(([key]) => key !== "id")),
    })),
  };
}

/** Compact exact identity/order block for every model turn; live values stay tool-only. */
export function dashboardManifestForPrompt(input = {}) {
  const manifest = boundedDashboardManifest(input);
  return JSON.stringify({
    order: manifest.order,
    trackers: manifest.trackers.map((tracker) =>
      compactObject({
        id: tracker.id,
        position: tracker.position,
        title: tracker.title,
        kind: tracker.kind,
        measure_id: tracker.measure_id,
        unit: tracker.unit || undefined,
        days: tracker.days,
        chart: tracker.chart,
        goal: tracker.goal,
        mode: tracker.mode,
      })
    ),
  });
}

function validDay(value) {
  const raw = String(value || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return false;
  const [year, month, day] = raw.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function shiftDay(dayKey, delta) {
  const [year, month, day] = dayKey.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

function normalizeSeries(rows, from, to) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => ({
      day_key: String(row?.day_key || ""),
      total: Number(row?.total),
      unit: cleanText(row?.unit, 24),
    }))
    .filter(
      (row) =>
        validDay(row.day_key) &&
        row.day_key >= from &&
        row.day_key <= to &&
        Number.isFinite(row.total)
    )
    .sort((left, right) => left.day_key.localeCompare(right.day_key));
}

function seriesSummary(rows, { unit, from, to } = {}) {
  const points = normalizeSeries(rows, from, to);
  const safeUnit = cleanText(unit || points.at(-1)?.unit, 24);
  if (!points.length) {
    return {
      status: "no_recorded_data",
      point_count: 0,
      unit: safeUnit,
      range_from: from,
      range_to: to,
    };
  }
  const first = points[0].total;
  const latest = points.at(-1).total;
  return {
    status: "showing_recorded_data",
    point_count: points.length,
    first,
    latest,
    change: latest - first,
    unit: safeUnit,
    range_from: from,
    range_to: to,
  };
}

async function loadSeriesInBatches(requests, loadMeasureSeries) {
  const results = new Map();
  const entries = Array.from(requests.entries());
  for (let index = 0; index < entries.length; index += 6) {
    const batch = entries.slice(index, index + 6);
    const loaded = await Promise.all(
      batch.map(async ([measureId, from]) => {
        try {
          return [
            measureId,
            { rows: await loadMeasureSeries(measureId, from), unavailable: false },
          ];
        } catch {
          return [measureId, { rows: [], unavailable: true }];
        }
      })
    );
    for (const [measureId, result] of loaded) results.set(measureId, result);
  }
  return results;
}

export async function buildAppInspection({
  currentDate,
  scene = "none",
  theme = null,
  layout = null,
  trackers = [],
  loadMeasureSeries = async () => [],
} = {}) {
  const day = validDay(currentDate) ? currentDate : new Date().toISOString().slice(0, 10);
  const manifest = boundedDashboardManifest({ layout, trackers });
  const requests = new Map();
  for (const tracker of manifest.trackers) {
    const from = shiftDay(day, -((tracker.kind === "chart" ? tracker.days : 1) - 1));
    for (const measureId of tracker.measures || [tracker.measure_id]) {
      const previous = requests.get(measureId);
      if (!previous || from < previous) requests.set(measureId, from);
    }
  }
  const loaded = await loadSeriesInBatches(
    requests,
    async (measureId, from) => loadMeasureSeries(measureId, from, day)
  );

  const inspectedTrackers = manifest.trackers.map((tracker) => {
    const from = shiftDay(day, -((tracker.kind === "chart" ? tracker.days : 1) - 1));
    const measureIds = tracker.measures || [tracker.measure_id];
    const summaries = measureIds.map((measureId) => {
      const result = loaded.get(measureId) || { rows: [], unavailable: true };
      if (result.unavailable) {
        return {
          measure_id: measureId,
          status: "temporarily_unavailable",
          range_from: from,
          range_to: day,
        };
      }
      return {
        measure_id: measureId,
        ...seriesSummary(result.rows, { unit: tracker.unit, from, to: day }),
      };
    });

    let summary;
    if (tracker.kind === "counter") {
      const metric = summaries[0];
      summary = metric.status === "temporarily_unavailable"
        ? metric
        : {
            status: metric.status,
            current: metric.point_count ? metric.latest : 0,
            recorded_today: metric.point_count > 0,
            unit: metric.unit,
            goal: tracker.goal ?? null,
            mode: tracker.mode || "floor",
            day,
          };
    } else if (summaries.length === 1) {
      const { measure_id, ...single } = summaries[0];
      summary = single;
    } else {
      summary = {
        status: summaries.some((item) => item.status === "showing_recorded_data")
          ? "showing_recorded_data"
          : summaries.every((item) => item.status === "temporarily_unavailable")
            ? "temporarily_unavailable"
            : "no_recorded_data",
        point_count: summaries.reduce(
          (sum, item) => sum + (Number(item.point_count) || 0),
          0
        ),
        range_from: from,
        range_to: day,
        series: summaries,
      };
    }
    return { ...tracker, summary };
  });

  return {
    app: {
      name: "BigBricey",
      purpose: "A chat-first private nutrition and fitness ledger.",
      current_surface: "Today",
    },
    interface_guide: APP_INTERFACE_GUIDE,
    core_today_panels: CORE_TODAY_PANELS,
    current_dashboard: {
      date: day,
      scene: cleanText(scene || "none", 40) || "none",
      theme: safeTheme(theme),
      order: manifest.order,
      trackers: inspectedTrackers,
    },
  };
}

export function trackerRemovalConfirmationPrompt(
  inspection,
  evaluation,
  fallback = "Remove this dashboard tracker?"
) {
  if (evaluation?.tool_name !== "remove_tracker") {
    return cleanText(evaluation?.confirmation?.prompt || fallback, 700) || fallback;
  }
  const trackers = Array.isArray(inspection?.current_dashboard?.trackers)
    ? inspection.current_dashboard.trackers
    : [];
  const id = cleanText(evaluation?.arguments?.id, 64).toLowerCase();
  const match = cleanText(evaluation?.arguments?.match, 120).toLowerCase();
  const tracker = trackers.find((item) => {
    if (id && String(item?.id || "").toLowerCase() === id) return true;
    if (!match) return false;
    return [item?.title, item?.measure_id, ...(item?.measures || [])]
      .map((value) => String(value || "").toLowerCase())
      .some((value) => value.includes(match) || match.includes(value));
  });
  if (!tracker) {
    return cleanText(evaluation?.confirmation?.prompt || fallback, 700) || fallback;
  }

  const title = cleanText(tracker.title || "this tracker", 80);
  const summary = tracker.summary && typeof tracker.summary === "object"
    ? tracker.summary
    : {};
  let explanation = `That's your ${title}`;
  if (tracker.kind === "chart") {
    const chartType = cleanText(tracker.chart || "line", 16);
    explanation += ` ${chartType} chart. “${Number(tracker.days) || 30}-Day” is its display range, not a wait.`;
    const count = Number(summary.point_count);
    const unit = cleanText(summary.unit || tracker.unit, 24);
    if (summary.status === "showing_recorded_data" && Number.isFinite(count)) {
      explanation += ` It currently has ${count} recorded point${count === 1 ? "" : "s"}`;
      if (Number.isFinite(Number(summary.latest))) {
        explanation += `; latest ${Number(summary.latest)}${unit ? ` ${unit}` : ""}`;
      }
      explanation += ".";
    } else if (summary.status === "no_recorded_data") {
      explanation += " It currently has no recorded points in that range.";
    }
  } else {
    explanation += " counter.";
  }
  return `${explanation} Removing this panel does not delete its recorded measurements. Remove this dashboard tracker?`.slice(
    0,
    700
  );
}
