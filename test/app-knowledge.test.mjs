import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  APP_INTERFACE_GUIDE,
  CORE_TODAY_PANELS,
  buildAppInspection,
  boundedDashboardManifest,
  dashboardManifestForPrompt,
  trackerRemovalConfirmationPrompt,
} from "../api/_app_knowledge.js";

test("the authoritative guide explains the real app surface and 30-day chart semantics", async () => {
  const appHtml = await readFile(new URL("../public/app.html", import.meta.url), "utf8");

  for (const panel of CORE_TODAY_PANELS) {
    assert.match(appHtml, new RegExp(`data-panel=["']${panel.id}["']`));
    assert.match(APP_INTERFACE_GUIDE, new RegExp(panel.label, "i"));
  }

  assert.match(APP_INTERFACE_GUIDE, /30d[^\n]{0,160}(?:display|window|range)/i);
  assert.match(APP_INTERFACE_GUIDE, /not[^\n]{0,80}(?:wait|waiting)/i);
  assert.match(APP_INTERFACE_GUIDE, /one[^\n]{0,100}(?:point|measurement)[^\n]{0,100}(?:immediately|right away)/i);
  assert.match(APP_INTERFACE_GUIDE, /remove[^\n]{0,160}does not delete[^\n]{0,80}(?:history|measurements)/i);
  assert.match(APP_INTERFACE_GUIDE, /Meal[^\n]{0,80}Nutrition Label[^\n]{0,80}Barcode/i);
  assert.match(APP_INTERFACE_GUIDE, /Today[^\n]{0,80}Trends[^\n]{0,80}Goals[^\n]{0,80}You/i);
  assert.match(APP_INTERFACE_GUIDE, /What BigBricey knows about me/i);
  assert.match(APP_INTERFACE_GUIDE, /add[^\n]{0,80}edit[^\n]{0,80}forgotten/i);
  assert.match(APP_INTERFACE_GUIDE, /inferred[^\n]{0,100}not silently saved/i);
  assert.match(APP_INTERFACE_GUIDE, /companion[^\n]{0,180}ready[^\n]{0,100}tracking/i);
  assert.match(APP_INTERFACE_GUIDE, /Saved[^\n]{0,160}committed/i);
  assert.match(APP_INTERFACE_GUIDE, /Review[^\n]{0,160}approval/i);
});

test("the bounded current-dashboard manifest exposes exact tracker identity and position", () => {
  const manifest = boundedDashboardManifest({
    layout: {
      order: ["chat", "c_weight_30d", "kcal", "food"],
      sizes: { chat: "full", c_weight_30d: "full" },
    },
    trackers: [
      {
        id: "c_weight_30d",
        kind: "chart",
        title: "Weight (30-Day)",
        measure_id: "weight_lb",
        measures: ["weight_lb"],
        unit: "lb",
        days: 30,
        chart: "line",
        size: "full",
        color: "#38bdf8",
        arbitrary_private_field: "must-not-leak",
      },
    ],
  });

  assert.deepEqual(manifest.order.slice(0, 2), ["chat", "c_weight_30d"]);
  assert.deepEqual(manifest.trackers[0], {
    id: "c_weight_30d",
    position: 2,
    kind: "chart",
    title: "Weight (30-Day)",
    measure_id: "weight_lb",
    measures: ["weight_lb"],
    unit: "lb",
    size: "full",
    chart: "line",
    days: 30,
  });
  assert.doesNotMatch(JSON.stringify(manifest), /must-not-leak|arbitrary_private_field/);
});

test("the prompt dashboard manifest stays compact without losing the newest exact tracker id", () => {
  const trackers = Array.from({ length: 20 }, (_, index) => ({
    id: `c_${String(index).padStart(2, "0")}_${"i".repeat(40)}`,
    kind: "chart",
    title: `Tracker ${index} ${"t".repeat(70)}`,
    measure_id: `metric_${index}_${"m".repeat(60)}`,
    unit: "units",
    days: 30,
    chart: "line",
  }));
  const promptManifest = dashboardManifestForPrompt({
    layout: { order: ["chat", ...trackers.map((tracker) => tracker.id)] },
    trackers,
  });
  const parsed = JSON.parse(promptManifest);

  assert.deepEqual(parsed.columns, ["id", "position", "title", "kind", "days"]);
  assert.equal(parsed.trackers.length, 20);
  assert.equal(parsed.trackers.at(-1)[0], trackers.at(-1).id);
  assert.equal(parsed.trackers.at(-1)[1], 21);
  assert.match(parsed.trackers.at(-1)[2], /Tracker 19/);
  assert.ok(promptManifest.length < 4_000, `manifest should stay compact, got ${promptManifest.length}`);
});

test("live inspection reports the exact one-point weight chart instead of inventing a wait period", async () => {
  const inspection = await buildAppInspection({
    currentDate: "2026-07-15",
    scene: "fireflies",
    theme: { preset: "forest" },
    layout: {
      order: ["chat", "c_weight_30d", "kcal", "food"],
      sizes: { chat: "full", c_weight_30d: "full" },
    },
    trackers: [
      {
        id: "c_weight_30d",
        kind: "chart",
        title: "Weight (30-Day)",
        measure_id: "weight_lb",
        measures: ["weight_lb"],
        unit: "lb",
        days: 30,
        chart: "line",
        size: "full",
      },
    ],
    loadMeasureSeries: async (measureId, from, to) => {
      assert.equal(measureId, "weight_lb");
      assert.equal(from, "2026-06-16");
      assert.equal(to, "2026-07-15");
      return [
        {
          day_key: "2026-07-15",
          measure_id: "weight_lb",
          total: 215,
          unit: "lb",
        },
      ];
    },
  });

  const tracker = inspection.current_dashboard.trackers[0];
  assert.equal(tracker.title, "Weight (30-Day)");
  assert.equal(tracker.position, 2);
  assert.equal(tracker.summary.point_count, 1);
  assert.equal(tracker.summary.latest, 215);
  assert.equal(tracker.summary.unit, "lb");
  assert.equal(tracker.summary.status, "showing_recorded_data");
  assert.equal(inspection.current_dashboard.scene, "fireflies");
  assert.equal(inspection.current_dashboard.theme.preset, "forest");
});

test("live inspection distinguishes a truly empty chart from one that has data", async () => {
  const inspection = await buildAppInspection({
    currentDate: "2026-07-15",
    trackers: [
      {
        id: "c_pushups_7d",
        kind: "chart",
        title: "Push-ups (7-Day)",
        measure_id: "reps",
        measures: ["reps"],
        unit: "reps",
        days: 7,
        chart: "bar",
      },
    ],
    loadMeasureSeries: async () => [],
  });

  assert.deepEqual(inspection.current_dashboard.trackers[0].summary, {
    status: "no_recorded_data",
    point_count: 0,
    unit: "reps",
    range_from: "2026-07-09",
    range_to: "2026-07-15",
  });
});

test("tracker removal confirmation explains the inspected panel without deleting its history", () => {
  const prompt = trackerRemovalConfirmationPrompt(
    {
      current_dashboard: {
        trackers: [
          {
            id: "c_weight_30d",
            title: "Weight (30-Day)",
            kind: "chart",
            chart: "line",
            days: 30,
            unit: "lb",
            summary: {
              status: "showing_recorded_data",
              point_count: 1,
              latest: 215,
              unit: "lb",
            },
          },
        ],
      },
    },
    {
      tool_name: "remove_tracker",
      arguments: { id: "c_weight_30d" },
      confirmation: { prompt: "Remove this dashboard tracker?" },
    }
  );

  assert.match(prompt, /Weight \(30-Day\)/);
  assert.match(prompt, /display range[^.]*not a wait/i);
  assert.match(prompt, /1 recorded point/i);
  assert.match(prompt, /latest 215 lb/i);
  assert.match(prompt, /does not delete[^.]*measurements/i);
  assert.match(prompt, /Remove this dashboard tracker\?/);
});
