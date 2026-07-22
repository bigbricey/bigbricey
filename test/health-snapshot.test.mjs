import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildHealthSnapshotDocument,
  formatHealthSnapshot,
  resolveHealthSnapshotPeriod,
  validateSnapshotEdit,
} from "../api/_health_snapshot.js";

const fixture = {
  period: { from: "2026-05-14", to: "2026-07-22", calendar_days: 70 },
  coverage: {
    days_with_any_data: 12,
    food_logged_days: 10,
    workout_logged_days: 4,
    measurement_logged_days: 2,
  },
  measure_summaries: [
    {
      measure_id: "kcal",
      unit: "kcal",
      days_logged: 10,
      average: 1910,
      minimum: 0,
      maximum: 2400,
      first_value: 0,
      latest_value: 2100,
      first_day: "2026-05-15",
      latest_day: "2026-07-22",
      outlier_count: 1,
    },
    {
      measure_id: "weight_lb",
      unit: "lb",
      days_logged: 2,
      average: 211,
      minimum: 207,
      maximum: 215,
      first_value: 215,
      latest_value: 207,
      first_day: "2026-05-14",
      latest_day: "2026-07-20",
      outlier_count: 0,
    },
  ],
  workouts: { sessions: 5, days: 4 },
  food_provenance: {
    entries: 20,
    verified_entries: 16,
    estimated_entries: 4,
    estimated_portions: 2,
  },
  recorded_context: [
    {
      day_key: "2026-06-11",
      category_id: "note",
      title: "Started a new sleep schedule",
      source: "chat",
    },
  ],
};

test("Health Snapshot distinguishes logged days from missing days and never fills missing with zero", () => {
  const period = resolveHealthSnapshotPeriod("10w", { to: "2026-07-22" });
  const document = buildHealthSnapshotDocument(fixture, {
    period,
    generatedAt: "2026-07-22T12:00:00.000Z",
  });
  assert.equal(document.completeness.calendar_days, 70);
  assert.equal(document.completeness.days_with_any_data, 12);
  assert.equal(document.completeness.missing_days, 58);
  assert.equal(document.completeness.missing_days_are_unknown_not_zero, true);
  assert.equal(document.nutrition_patterns[0].days_logged, 10);
  assert.equal(document.nutrition_patterns[0].missing_days, 60);
  assert.equal(document.nutrition_patterns[0].minimum_on_logged_days, 0);
  assert.equal(document.nutrition_patterns[0].missing_is_zero, false);
});

test("Health Snapshot reports observational changes, provenance, context, and limits without diagnosing", () => {
  const period = resolveHealthSnapshotPeriod("10w", { to: "2026-07-22" });
  const document = buildHealthSnapshotDocument(fixture, { period, nickname: "Ace" });
  const text = formatHealthSnapshot(document);
  assert.equal(document.subject.nickname, "Ace");
  assert.equal(document.observed_changes[0].measure_id, "weight_lb");
  assert.equal(document.observed_changes[0].change, -8);
  assert.equal(document.data_quality.verified_or_user_confirmed_entries, 16);
  assert.equal(document.recorded_context[0].day, "2026-06-11");
  assert.match(text, /58 days are missing—not zero/i);
  assert.match(text, /does not establish a cause/i);
  assert.match(text, /not medical advice/i);
  assert.doesNotMatch(text, /you (?:have|suffer from|were diagnosed with)/i);
});

test("periods support 10 weeks, six months, one year, and all available history", () => {
  assert.equal(resolveHealthSnapshotPeriod("10w", { to: "2026-07-22" }).calendar_days, 70);
  assert.equal(resolveHealthSnapshotPeriod("6m", { to: "2026-07-22" }).calendar_days, 183);
  assert.equal(resolveHealthSnapshotPeriod("1y", { to: "2026-07-22" }).calendar_days, 365);
  const all = resolveHealthSnapshotPeriod("all", {
    to: "2026-07-22",
    availableFrom: "2021-01-03",
  });
  assert.equal(all.from, "2021-01-03");
  assert.equal(all.to, "2026-07-22");
});

test("snapshot edits are bounded and reject empty exports", () => {
  assert.equal(validateSnapshotEdit("  my reviewed report  "), "my reviewed report");
  assert.throws(() => validateSnapshotEdit(""), /between 1 and 60,000/);
  assert.throws(() => validateSnapshotEdit("x".repeat(60_001)), /between 1 and 60,000/);
});

test("snapshot API and persistence queries bind every saved record to the random account id", async () => {
  const route = await readFile(new URL("../api/snapshots.js", import.meta.url), "utf8");
  const service = await readFile(
    new URL("../api/_health_snapshot.js", import.meta.url),
    "utf8"
  );
  assert.match(route, /accountIdForEmail\(user\.email\)/);
  assert.match(route, /getHealthSnapshot\(accountId, id\)/);
  assert.match(service, /account_id: `eq\.\$\{id\}`/);
  assert.match(service, /id: `eq\.\$\{snapshot\}`/);
  assert.doesNotMatch(service, /health_snapshots[\s\S]{0,1000}user_email/);
});

test("the interface makes the snapshot editable and offers local print and machine exports", async () => {
  const html = await readFile(new URL("../public/app.html", import.meta.url), "utf8");
  const client = await readFile(new URL("../public/snapshot.js", import.meta.url), "utf8");
  assert.match(html, /id="healthSnapshot"/);
  assert.match(html, /id="snapshotPeriod"/);
  assert.match(html, /<textarea id="snapshotEditor"/);
  assert.match(html, /Preview and edit before exporting/);
  assert.match(html, /Nothing is diagnosed, shared, or sent automatically/);
  assert.match(client, /user_edited_report_text/);
  assert.match(client, /application\/json/);
  assert.match(client, /report\.textContent = text/);
  assert.doesNotMatch(client, /document\.write|innerHTML/);
});
