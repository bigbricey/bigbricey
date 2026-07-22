const MODES = Object.freeze(["quiet", "helpful", "coach"]);
const PERSONALITIES = Object.freeze([
  "auto",
  "direct",
  "warm",
  "upbeat",
  "calm",
  "analytical",
]);
const DETAIL_LEVELS = Object.freeze(["auto", "short", "balanced", "detailed"]);
const CATEGORY_KEYS = Object.freeze([
  "nutrition",
  "workouts",
  "measurements",
  "habits",
  "health_snapshot",
]);

export const COMPANION_SETTINGS_DEFAULTS = Object.freeze({
  nickname: "",
  mode: "helpful",
  personality: "auto",
  detail: "auto",
  category_permissions: Object.freeze({
    nutrition: true,
    workouts: true,
    measurements: true,
    habits: true,
    health_snapshot: true,
  }),
  quiet_hours: Object.freeze({
    enabled: false,
    start: "21:00",
    end: "08:00",
  }),
});

function cleanText(value, max = 80) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b\u200e\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function validTime(value) {
  const text = String(value || "").trim();
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(text) ? text : null;
}

export function normalizeCompanionSettings(value = {}) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const categories =
    input.category_permissions &&
    typeof input.category_permissions === "object" &&
    !Array.isArray(input.category_permissions)
      ? input.category_permissions
      : {};
  const quiet =
    input.quiet_hours &&
    typeof input.quiet_hours === "object" &&
    !Array.isArray(input.quiet_hours)
      ? input.quiet_hours
      : {};
  return {
    nickname: cleanText(input.nickname, 60),
    mode: MODES.includes(input.mode) ? input.mode : COMPANION_SETTINGS_DEFAULTS.mode,
    personality: PERSONALITIES.includes(input.personality)
      ? input.personality
      : COMPANION_SETTINGS_DEFAULTS.personality,
    detail: DETAIL_LEVELS.includes(input.detail)
      ? input.detail
      : COMPANION_SETTINGS_DEFAULTS.detail,
    category_permissions: Object.fromEntries(
      CATEGORY_KEYS.map((key) => [
        key,
        typeof categories[key] === "boolean"
          ? categories[key]
          : COMPANION_SETTINGS_DEFAULTS.category_permissions[key],
      ])
    ),
    quiet_hours: {
      enabled: quiet.enabled === true,
      start: validTime(quiet.start) || COMPANION_SETTINGS_DEFAULTS.quiet_hours.start,
      end: validTime(quiet.end) || COMPANION_SETTINGS_DEFAULTS.quiet_hours.end,
    },
  };
}

function settingsError(code, message, path) {
  const error = new Error(message);
  error.code = code;
  error.path = path;
  error.status = 400;
  return error;
}

/** Validate one partial update. Unknown fields fail closed. */
export function validateCompanionSettingsPatch(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw settingsError("INVALID_SETTINGS", "Settings must be an object.", "settings");
  }
  const allowed = new Set([
    "nickname",
    "mode",
    "personality",
    "detail",
    "category_permissions",
    "quiet_hours",
  ]);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) {
    throw settingsError(
      "UNKNOWN_SETTING",
      `Unknown companion setting “${unknown}”.`,
      `settings.${unknown}`
    );
  }
  const patch = {};
  if (value.nickname != null) {
    if (typeof value.nickname !== "string" || value.nickname.length > 60) {
      throw settingsError("INVALID_NICKNAME", "Nickname must be 60 characters or fewer.", "settings.nickname");
    }
    patch.nickname = cleanText(value.nickname, 60);
  }
  if (value.mode != null) {
    if (!MODES.includes(value.mode)) {
      throw settingsError("INVALID_MODE", "Choose Quiet, Helpful, or Coach.", "settings.mode");
    }
    patch.mode = value.mode;
  }
  if (value.personality != null) {
    if (!PERSONALITIES.includes(value.personality)) {
      throw settingsError("INVALID_PERSONALITY", "That personality is not supported.", "settings.personality");
    }
    patch.personality = value.personality;
  }
  if (value.detail != null) {
    if (!DETAIL_LEVELS.includes(value.detail)) {
      throw settingsError("INVALID_DETAIL", "That answer length is not supported.", "settings.detail");
    }
    patch.detail = value.detail;
  }
  if (value.category_permissions != null) {
    if (
      typeof value.category_permissions !== "object" ||
      Array.isArray(value.category_permissions)
    ) {
      throw settingsError("INVALID_PERMISSIONS", "Category permissions must be an object.", "settings.category_permissions");
    }
    const categoryUnknown = Object.keys(value.category_permissions).find(
      (key) => !CATEGORY_KEYS.includes(key)
    );
    if (categoryUnknown) {
      throw settingsError("UNKNOWN_PERMISSION", "That suggestion category is not supported.", `settings.category_permissions.${categoryUnknown}`);
    }
    patch.category_permissions = {};
    for (const [key, enabled] of Object.entries(value.category_permissions)) {
      if (typeof enabled !== "boolean") {
        throw settingsError("INVALID_PERMISSION", "Suggestion permissions must be true or false.", `settings.category_permissions.${key}`);
      }
      patch.category_permissions[key] = enabled;
    }
  }
  if (value.quiet_hours != null) {
    if (typeof value.quiet_hours !== "object" || Array.isArray(value.quiet_hours)) {
      throw settingsError("INVALID_QUIET_HOURS", "Quiet hours must be an object.", "settings.quiet_hours");
    }
    const quietAllowed = new Set(["enabled", "start", "end"]);
    const quietUnknown = Object.keys(value.quiet_hours).find(
      (key) => !quietAllowed.has(key)
    );
    if (quietUnknown) {
      throw settingsError("UNKNOWN_QUIET_HOUR", "Unknown quiet-hours field.", `settings.quiet_hours.${quietUnknown}`);
    }
    patch.quiet_hours = {};
    if (value.quiet_hours.enabled != null) {
      if (typeof value.quiet_hours.enabled !== "boolean") {
        throw settingsError("INVALID_QUIET_HOURS", "Quiet hours enabled must be true or false.", "settings.quiet_hours.enabled");
      }
      patch.quiet_hours.enabled = value.quiet_hours.enabled;
    }
    for (const key of ["start", "end"]) {
      if (value.quiet_hours[key] != null) {
        const time = validTime(value.quiet_hours[key]);
        if (!time) {
          throw settingsError("INVALID_QUIET_HOURS", "Quiet-hour times must use HH:MM.", `settings.quiet_hours.${key}`);
        }
        patch.quiet_hours[key] = time;
      }
    }
  }
  if (!Object.keys(patch).length) {
    throw settingsError("EMPTY_SETTINGS", "Choose at least one setting to change.", "settings");
  }
  return patch;
}

export function mergeCompanionSettings(current, patch) {
  const base = normalizeCompanionSettings(current);
  const validated = validateCompanionSettingsPatch(patch);
  return normalizeCompanionSettings({
    ...base,
    ...validated,
    category_permissions: {
      ...base.category_permissions,
      ...(validated.category_permissions || {}),
    },
    quiet_hours: {
      ...base.quiet_hours,
      ...(validated.quiet_hours || {}),
    },
  });
}

export function inferCommunicationStyle(history = []) {
  const messages = (Array.isArray(history) ? history : [])
    .filter((message) => message?.role === "user")
    .slice(-8)
    .map((message) => cleanText(message.content, 2_000))
    .filter(Boolean);
  if (!messages.length) return { detail: "balanced", tone: "natural" };
  const words = messages.map((message) => message.split(/\s+/).filter(Boolean).length);
  const averageWords = words.reduce((sum, count) => sum + count, 0) / words.length;
  const candid = messages.some((message) => /\b(?:fuck|shit|damn|dude)\b/i.test(message));
  return {
    detail: averageWords <= 18 ? "short" : averageWords >= 80 ? "detailed" : "balanced",
    tone: candid ? "candid" : "natural",
  };
}

export function companionSettingsPrompt(settings, inferredStyle = {}) {
  const value = normalizeCompanionSettings(settings);
  const inferred =
    inferredStyle && typeof inferredStyle === "object" ? inferredStyle : {};
  const enabled = Object.entries(value.category_permissions)
    .filter(([, allowed]) => allowed)
    .map(([key]) => key.replace("_", " "));
  const detail = value.detail === "auto" ? inferred.detail || "balanced" : value.detail;
  const tone = value.personality === "auto" ? inferred.tone || "natural" : value.personality;
  return `COMPANION SETTINGS (account-controlled):
- Call the user: ${value.nickname || "their chosen profile name"}
- Proactive mode: ${value.mode}
- Reply personality: ${tone}
- Reply detail: ${detail}
- Proactive categories allowed: ${enabled.join(", ") || "none"}
- Quiet hours: ${value.quiet_hours.enabled ? `${value.quiet_hours.start}–${value.quiet_hours.end} local time` : "off"}

Quiet affects unsolicited nudges only; always answer a direct question. Helpful means at most one occasional, data-grounded suggestion. Coach may be more proactive but only inside allowed categories and never during quiet hours. Match the user's natural vocabulary without becoming sloppy about facts.`;
}

export function suggestionCategoryForMeasure(measureId) {
  const id = String(measureId || "").toLowerCase();
  if (["steps", "duration_min", "distance_mi", "reps", "sets", "load_lb"].includes(id)) {
    return "workouts";
  }
  if (/^(?:weight|waist|body_|blood_|glucose|sleep)/.test(id)) return "measurements";
  return "nutrition";
}

function minutes(time) {
  const [hour, minute] = String(time).split(":").map(Number);
  return hour * 60 + minute;
}

export function isInsideQuietHours(settings, localTime = "12:00") {
  const value = normalizeCompanionSettings(settings);
  if (!value.quiet_hours.enabled) return false;
  const now = validTime(localTime);
  if (!now) return false;
  const current = minutes(now);
  const start = minutes(value.quiet_hours.start);
  const end = minutes(value.quiet_hours.end);
  if (start === end) return true;
  return start < end
    ? current >= start && current < end
    : current >= start || current < end;
}

export function buildGroundedSuggestions({ settings, statuses = [], localTime = "12:00" } = {}) {
  const value = normalizeCompanionSettings(settings);
  if (value.mode === "quiet" || isInsideQuietHours(value, localTime)) return [];
  const max = value.mode === "coach" ? 2 : 1;
  return (Array.isArray(statuses) ? statuses : [])
    .filter((status) => status && status.ok === false && Number(status.days_with_data) > 0)
    .filter((status) => value.category_permissions[suggestionCategoryForMeasure(status.measure_id)] !== false)
    .slice(0, max)
    .map((status) => ({
      id: `watch:${cleanText(status.measure_id, 80)}:${Number(status.window_days) || 1}`,
      category: suggestionCategoryForMeasure(status.measure_id),
      message: cleanText(status.message || status.label, 240),
      source: "recorded_watch_status",
      dismissible: true,
    }));
}
