import assert from "node:assert/strict";
import test from "node:test";

import {
  buildGroundedSuggestions,
  companionSettingsPrompt,
  inferCommunicationStyle,
  isInsideQuietHours,
  mergeCompanionSettings,
  normalizeCompanionSettings,
  validateCompanionSettingsPatch,
} from "../api/_companion_settings.js";

test("companion defaults are calm, helpful, and fully user controllable", () => {
  const settings = normalizeCompanionSettings({});
  assert.equal(settings.mode, "helpful");
  assert.equal(settings.personality, "auto");
  assert.equal(settings.quiet_hours.enabled, false);
  assert.equal(settings.category_permissions.nutrition, true);
});

test("partial companion updates merge without resetting unrelated choices", () => {
  const settings = mergeCompanionSettings(
    {
      nickname: "B",
      mode: "coach",
      category_permissions: { nutrition: false, workouts: true },
      quiet_hours: { enabled: true, start: "22:00", end: "07:30" },
    },
    { mode: "quiet" }
  );
  assert.equal(settings.nickname, "B");
  assert.equal(settings.mode, "quiet");
  assert.equal(settings.category_permissions.nutrition, false);
  assert.equal(settings.quiet_hours.start, "22:00");
});

test("unknown, malformed, and empty companion patches fail closed", () => {
  assert.throws(() => validateCompanionSettingsPatch({ surprise: true }), /Unknown/);
  assert.throws(() => validateCompanionSettingsPatch({ mode: "nag" }), /Quiet/);
  assert.throws(
    () => validateCompanionSettingsPatch({ quiet_hours: { start: "9pm" } }),
    /HH:MM/
  );
  assert.throws(() => validateCompanionSettingsPatch({}), /at least one/);
});

test("automatic communication style adapts from recent user language", () => {
  assert.deepEqual(
    inferCommunicationStyle([{ role: "user", content: "Just tell me straight, dude." }]),
    { detail: "short", tone: "candid" }
  );
  const verbose = inferCommunicationStyle([
    { role: "user", content: Array.from({ length: 90 }, () => "word").join(" ") },
  ]);
  assert.equal(verbose.detail, "detailed");
  assert.match(companionSettingsPrompt({ nickname: "Ace" }, verbose), /Call the user: Ace/);
});

test("back-off mode and quiet hours suppress unsolicited suggestions only", () => {
  const status = {
    measure_id: "potassium",
    label: "Potassium",
    message: "Your logged-day potassium average is below your watch target.",
    days_with_data: 5,
    window_days: 7,
    ok: false,
  };
  assert.deepEqual(buildGroundedSuggestions({ settings: { mode: "quiet" }, statuses: [status] }), []);
  assert.equal(
    isInsideQuietHours(
      { quiet_hours: { enabled: true, start: "21:00", end: "08:00" } },
      "23:30"
    ),
    true
  );
  assert.deepEqual(
    buildGroundedSuggestions({
      settings: {
        mode: "coach",
        quiet_hours: { enabled: true, start: "21:00", end: "08:00" },
      },
      statuses: [status],
      localTime: "23:30",
    }),
    []
  );
  assert.equal(
    buildGroundedSuggestions({ settings: { mode: "helpful" }, statuses: [status] })[0].source,
    "recorded_watch_status"
  );
});
