const SCENES = [
  "rain",
  "snow",
  "desert",
  "ocean",
  "matrix",
  "stars",
  "confetti",
  "fireflies",
  "aurora",
  "mist",
  "neon_city",
  "none",
];
const PANELS = ["chat", "kcal", "pro", "fat", "carb", "net", "minerals", "summary", "food"];
const PANEL_SIZES = ["full", "half", "third"];
const TRACKER_KINDS = ["counter", "chart"];
const TRACKER_MODES = ["floor", "ceiling"];
const CHART_TYPES = ["line", "bar", "pie"];
const THEME_PRESETS = ["midnight", "light", "neon", "forest", "pink", "terminal", "pastel", "sunset"];
const INCLUDE_SECTIONS = ["food", "totals", "workouts", "metrics", "home"];

const string = (description, extra = {}) => ({ type: "string", description, ...extra });
const number = (description, extra = {}) => ({ type: "number", description, ...extra });
const integer = (description, extra = {}) => ({ type: "integer", description, ...extra });
const array = (description, items, extra = {}) => ({ type: "array", description, items, ...extra });
const objectSchema = (properties, required = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

const DEFINITIONS = [
  ["inspect_app", "Read the authoritative BigBricey interface guide and the user's exact current Today dashboard, including saved tracker definitions, positions, and computed chart summaries. Always use this before explaining what a visible panel, button, chart, label, or 'thing' in the app is or currently shows. Never guess from the user's wording.", objectSchema({
    focus: string("The user's short description of the visible app element or feature they mean."),
  })],
  ["read_today", "Read the user's recorded ledger and home state for one day. Use this before answering totals or what-was-logged questions.", objectSchema({
    day: string("Calendar day in YYYY-MM-DD format."),
    include: array("Sections to return.", { type: "string", enum: INCLUDE_SECTIONS }, { maxItems: 5, uniqueItems: true }),
  })],
  ["add_food", "Look up verified nutrition and add a food entry. Preserve the user's full amount and unit in query. Never supply nutrition values yourself.", objectSchema({
    query: string("Complete specific food phrase including the user's amount and unit, for example '3 large eggs'."),
  }, ["query"])],
  ["update_food", "Replace an existing food entry using one complete new verified lookup phrase.", objectSchema({
    entry_id: string("Food entry id."),
    match: string("Distinctive food label text when the entry id is not in the compact prompt."),
    query: string("Complete new food phrase including amount and unit."),
  }, ["query"])],
  ["remove_food", "Request removal of one food ledger entry now. Call this immediately; the app will collect confirmation before execution.", objectSchema({
    entry_id: string("Food entry id."),
    match: string("Distinctive food label text when the entry id is not in the compact prompt."),
    day: string("Calendar day in YYYY-MM-DD format."),
  })],
  ["clear_food_day", "Request clearing every food entry from a day now. Call this immediately; the app will collect confirmation before execution.", objectSchema({ day: string("Calendar day in YYYY-MM-DD format.") }, ["day"])],
  ["save_food", "Save a reusable food from existing ledger rows or one verified server lookup. Do not supply macros.", objectSchema({
    name: string("User's name for the saved food."),
    source_entry_ids: array("Existing food entry ids to combine.", string("Food entry id."), { minItems: 1, maxItems: 30, uniqueItems: true }),
    food_query: string("Specific food phrase for a verified server lookup."),
    serving_label: string("Human serving label."),
    description: string("Short user description."),
  }, ["name"])],
  ["log_saved_food", "Add a food from the user's private saved-food library.", objectSchema({
    name: string("Saved food name."),
    saved_food_id: string("Saved food id."),
    servings: number("Positive number of servings."),
  })],
  ["list_saved_foods", "List the user's private saved foods.", objectSchema({
    query: string("Optional name filter."),
    limit: integer("Maximum results."),
  })],
  ["delete_saved_food", "Request deletion of a reusable saved food now. Call this immediately; the app will collect confirmation before execution.", objectSchema({
    name: string("Saved food name."),
    saved_food_id: string("Saved food id."),
  })],
  ["set_goals", "Update the adult user's ongoing daily calorie, macro, mineral, or eating-style targets.", objectSchema({
    kcal: number("Daily calorie target."),
    protein: number("Protein grams."),
    fat: number("Fat grams."),
    carbs: number("Total carbohydrate grams."),
    net_carbs: number("Net carbohydrate grams."),
    potassium: number("Potassium milligrams."),
    magnesium: number("Magnesium milligrams."),
    style: string("Eating style id."),
    recompute: { type: "boolean", description: "Recompute macros for a style-only change." },
  })],
  ["log_workout", "Log a workout or physical activity with recorded measurements.", objectSchema({
    title: string("Workout title."),
    category: string("Short category id."),
    duration_min: number("Duration in minutes."),
    sets: integer("Set count."),
    reps: integer("Total repetition count."),
    load_lb: number("Load in pounds."),
    notes: string("Short factual note."),
    day: string("Calendar day in YYYY-MM-DD format."),
  }, ["title"])],
  ["log_steps", "Log a whole-number step count.", objectSchema({
    steps: integer("Step count."),
    day: string("Calendar day in YYYY-MM-DD format."),
  }, ["steps"])],
  ["log_metric", "Log a numeric body or fitness metric.", objectSchema({
    measure_id: string("Stable snake_case measure id."),
    value: number("Finite numeric value."),
    unit: string("Short unit."),
    label: string("Human label."),
    day: string("Calendar day in YYYY-MM-DD format."),
  }, ["measure_id", "value"])],
  ["set_tracker", "Create or update a real Today dashboard counter or chart backed by recorded ledger measurements. For weight use weight_lb. Charts may start empty until that metric is logged.", objectSchema({
    id: string("Optional stable custom panel id beginning with c_."),
    kind: string("Tracker type.", { enum: TRACKER_KINDS }),
    title: string("Short user-facing panel title."),
    measure_id: string("One stable snake_case measurement id. Use this for counters or single-series charts."),
    measures: array("One to six stable snake_case measurement ids for a chart.", { type: "string" }, { minItems: 1, maxItems: 6, uniqueItems: true }),
    unit: string("Short display unit."),
    goal: number("Counter target."),
    mode: string("Whether the counter aims for at least or at most the goal.", { enum: TRACKER_MODES }),
    color: string("Hex accent color."),
    icon: string("One short emoji or symbol."),
    size: string("Dashboard width.", { enum: PANEL_SIZES }),
    chart: string("Chart style.", { enum: CHART_TYPES }),
    days: integer("Number of calendar days shown by a chart."),
  }, ["kind", "title"])],
  ["remove_tracker", "Request removal of one custom dashboard counter or chart now. Supply exactly one identifier: use id when the dashboard manifest provides it, otherwise use match. Never send both. Call this immediately; the app will collect confirmation before execution.", objectSchema({
    id: string("Exact custom panel id. Send id only; do not also send match."),
    match: string("Distinctive tracker title or measurement id. Send match only when an exact id is unavailable."),
  })],
  ["set_theme", "Change the private app look using safe theme fields.", objectSchema({
    preset: string("Theme preset.", { enum: THEME_PRESETS }),
    accent: string("Hex accent color."),
    bg0: string("Hex background color."),
    ring_left: string("Hex remaining-ring color."),
    ring_eaten: string("Hex eaten-ring color."),
    ring_goal: string("Hex goal-ring color."),
    ring_over: string("Hex over-goal color."),
    font_scale: number("Text scale from 0.85 to 1.3."),
    radius: number("Corner radius from 0 to 32."),
    density: string("Layout density.", { enum: ["cozy", "compact"] }),
    shape: string("Corner shape.", { enum: ["square", "round"] }),
  })],
  ["set_scene", "Set a supported ambient background scene.", objectSchema({ scene: string("Scene id.", { enum: SCENES }) }, ["scene"])],
  ["set_layout", "Reorder or resize known Today panels, or reset the layout.", objectSchema({
    order: array("Panel order.", { type: "string", enum: PANELS }, { maxItems: PANELS.length, uniqueItems: true }),
    sizes: { type: "object", description: "Panel size overrides.", properties: Object.fromEntries(PANELS.map((id) => [id, { type: "string", enum: PANEL_SIZES }])), additionalProperties: false },
    reset: { type: "boolean", description: "Reset the layout." },
  })],
  ["remember", "Save a short user-requested preference or fact as permanent memory.", objectSchema({
    note: string("Short memory note."),
    kind: string("Whether this is a fact or a communication/preference setting.", { enum: ["fact", "preference"] }),
  }, ["note"])],
  ["forget_memory", "Request removal of one permanent memory now. Use memory_id when available; otherwise use one distinctive text match. Call this immediately; the app will collect confirmation before execution.", objectSchema({
    memory_id: string("Exact permanent memory id."),
    match: string("Distinctive text to match when an exact id is unavailable."),
  })],
];

export const BIGBRICEY_TOOL_NAMES = Object.freeze(DEFINITIONS.map(([name]) => name));
export const BIGBRICEY_TOOLS = Object.freeze(
  DEFINITIONS.map(([name, description, parameters]) => ({
    type: "function",
    function: { name, description, parameters },
  }))
);

const CONFIRMATIONS = {
  remove_food: {
    required: true,
    reason: "This removes a food entry from the ledger.",
    prompt: "Remove this food entry?",
  },
  clear_food_day: {
    required: true,
    reason: "This removes every food entry recorded for the selected day.",
    prompt: "Clear every food entry for this day?",
  },
  delete_saved_food: {
    required: true,
    reason: "This permanently removes a reusable food from the saved library.",
    prompt: "Delete this saved food?",
  },
  forget_memory: {
    required: true,
    reason: "This removes matching information from permanent memory.",
    prompt: "Forget this remembered information?",
  },
  remove_tracker: {
    required: true,
    reason: "This removes a custom dashboard counter or chart.",
    prompt: "Remove this dashboard tracker?",
  },
};

const READ_ONLY = new Set(["inspect_app", "read_today", "list_saved_foods"]);

export function getToolPolicy(name) {
  const toolName = String(name || "");
  if (!BIGBRICEY_TOOL_NAMES.includes(toolName)) return null;
  const confirmation = CONFIRMATIONS[toolName] || null;
  return {
    mutates: !READ_ONLY.has(toolName),
    destructive: Boolean(confirmation),
    confirmation,
  };
}

function validationError(code, message, path) {
  return { ok: false, status: "error", error: { code, message, path } };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validDay(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function cleanString(value) {
  return String(value)
    .normalize("NFKC")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function range(args, key, { min = -Infinity, max = Infinity, integer = false } = {}) {
  if (args[key] == null) return null;
  if (typeof args[key] !== "number" || !Number.isFinite(args[key])) {
    return validationError("INVALID_TYPE", `"${key}" must be a finite number.`, `function.arguments.${key}`);
  }
  if (integer && !Number.isInteger(args[key])) {
    return validationError("INVALID_TYPE", `"${key}" must be a whole number.`, `function.arguments.${key}`);
  }
  if (args[key] < min || args[key] > max) {
    return validationError("OUT_OF_RANGE", `"${key}" is outside its allowed range.`, `function.arguments.${key}`);
  }
  return null;
}

function stringField(args, key, { min = 1, max = 500, pattern, values } = {}) {
  if (args[key] == null) return null;
  if (typeof args[key] !== "string") {
    return validationError("INVALID_TYPE", `"${key}" must be text.`, `function.arguments.${key}`);
  }
  args[key] = cleanString(args[key]);
  if (args[key].length < min || args[key].length > max) {
    return validationError("OUT_OF_RANGE", `"${key}" is outside its allowed length.`, `function.arguments.${key}`);
  }
  if ((pattern && !pattern.test(args[key])) || (values && !values.includes(args[key]))) {
    return validationError("INVALID_VALUE", `"${key}" is not supported.`, `function.arguments.${key}`);
  }
  return null;
}

function exactlyOne(args, keys) {
  return keys.filter((key) => args[key] != null).length === 1;
}

function validateArguments(name, input) {
  const args = { ...input };
  const tool = BIGBRICEY_TOOLS.find((item) => item.function.name === name);
  const allowed = Object.keys(tool.function.parameters.properties || {});
  for (const key of Object.keys(args)) {
    if (!allowed.includes(key)) {
      return validationError("UNKNOWN_FIELD", `Unknown argument "${key}".`, `function.arguments.${key}`);
    }
  }
  for (const key of tool.function.parameters.required || []) {
    if (args[key] == null || args[key] === "") {
      return validationError("REQUIRED_FIELD", `"${key}" is required.`, `function.arguments.${key}`);
    }
  }

  const textRules = {
    query: { max: 500 }, entry_id: { max: 200 }, name: { max: 120 }, saved_food_id: { max: 200 },
    food_query: { max: 500 }, serving_label: { max: 120 }, description: { max: 500 },
    id: { max: 48, pattern: /^c_[a-z0-9_]+$/ }, unit: { max: 32 }, title: { max: 160 }, category: { max: 60, pattern: /^[a-z0-9_ -]+$/i },
    notes: { max: 500 }, measure_id: { max: 80, pattern: /^[a-z0-9_]+$/ }, label: { max: 120 }, style: { max: 60, pattern: /^[a-z0-9_ -]+$/i },
    note: { max: 300 }, match: { max: 300 }, memory_id: { min: 36, max: 36, pattern: /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i }, focus: { max: 500 }, kind: { max: 16 }, mode: { max: 16 }, chart: { max: 16 }, color: { max: 9 }, icon: { max: 8 },
  };
  for (const [key, rules] of Object.entries(textRules)) {
    const error = stringField(args, key, rules);
    if (error) return error;
  }
  if (args.day != null) {
    const error = stringField(args, "day", { min: 10, max: 10 });
    if (error) return error;
    if (!validDay(args.day)) return validationError("INVALID_VALUE", "The calendar day is invalid.", "function.arguments.day");
  }

  if (args.include != null) {
    if (!Array.isArray(args.include) || args.include.length > 5 || new Set(args.include).size !== args.include.length || args.include.some((item) => typeof item !== "string" || !INCLUDE_SECTIONS.includes(item))) {
      return validationError("INVALID_VALUE", "Requested sections are not supported.", "function.arguments.include");
    }
  }
  if (args.source_entry_ids != null) {
    if (!Array.isArray(args.source_entry_ids) || !args.source_entry_ids.length || args.source_entry_ids.length > 30 || new Set(args.source_entry_ids).size !== args.source_entry_ids.length || args.source_entry_ids.some((id) => typeof id !== "string" || !cleanString(id) || cleanString(id).length > 200)) {
      return validationError("INVALID_VALUE", "Source entry ids are invalid.", "function.arguments.source_entry_ids");
    }
    args.source_entry_ids = args.source_entry_ids.map(cleanString);
  }
  if (args.measures != null) {
    if (
      !Array.isArray(args.measures) ||
      !args.measures.length ||
      args.measures.length > 6 ||
      new Set(args.measures).size !== args.measures.length ||
      args.measures.some(
        (id) =>
          typeof id !== "string" ||
          !/^[a-z0-9_]{1,80}$/.test(cleanString(id))
      )
    ) {
      return validationError(
        "INVALID_VALUE",
        "Chart measurement ids are invalid.",
        "function.arguments.measures"
      );
    }
    args.measures = args.measures.map(cleanString);
  }

  for (const [key, limits] of Object.entries({
    quantity: { min: 0.001, max: 10000 }, servings: { min: 0.001, max: 1000 }, limit: { min: 1, max: 50, integer: true },
    kcal: { min: 1500, max: 10000 }, protein: { min: 0, max: 1000 }, fat: { min: 0, max: 1000 }, carbs: { min: 0, max: 2000 }, net_carbs: { min: 0, max: 2000 }, potassium: { min: 0, max: 30000 }, magnesium: { min: 0, max: 5000 },
    duration_min: { min: 0, max: 1440 }, sets: { min: 0, max: 10000, integer: true }, reps: { min: 0, max: 100000, integer: true }, load_lb: { min: 0, max: 5000 }, steps: { min: 0, max: 200000, integer: true },
    value: { min: -1000000000, max: 1000000000 }, goal: { min: 0, max: 1000000000 }, days: { min: 1, max: 1095, integer: true }, font_scale: { min: 0.85, max: 1.3 }, radius: { min: 0, max: 32 },
  })) {
    const error = range(args, key, limits);
    if (error) return error;
  }

  if (name === "save_food") {
    if (!exactlyOne(args, ["source_entry_ids", "food_query"])) {
      const code = args.source_entry_ids != null && args.food_query != null ? "INVALID_COMBINATION" : "REQUIRED_FIELD";
      return validationError(code, "Use exactly one verified food source.", "function.arguments");
    }
  }
  if (["update_food", "remove_food"].includes(name) && !exactlyOne(args, ["entry_id", "match"])) {
    return validationError(
      args.entry_id != null && args.match != null ? "INVALID_COMBINATION" : "REQUIRED_FIELD",
      "Use exactly one food entry identifier.",
      "function.arguments"
    );
  }
  if (["log_saved_food", "delete_saved_food"].includes(name) && !exactlyOne(args, ["name", "saved_food_id"])) {
    return validationError(
      args.name != null && args.saved_food_id != null ? "INVALID_COMBINATION" : "REQUIRED_FIELD",
      "Use exactly one saved-food identifier.",
      "function.arguments"
    );
  }
  if (name === "set_goals") {
    const goalKeys = ["kcal", "protein", "fat", "carbs", "net_carbs", "potassium", "magnesium", "style"];
    if (!goalKeys.some((key) => args[key] != null)) return validationError("REQUIRED_FIELD", "At least one target is required.", "function.arguments");
  }
  if (name === "set_theme") {
    if (!allowed.some((key) => args[key] != null)) {
      return validationError(
        "REQUIRED_FIELD",
        "At least one theme change is required.",
        "function.arguments"
      );
    }
    if (args.preset != null && !THEME_PRESETS.includes(args.preset)) return validationError("INVALID_VALUE", "Unknown theme preset.", "function.arguments.preset");
    for (const key of ["accent", "bg0", "ring_left", "ring_eaten", "ring_goal", "ring_over"]) {
      if (args[key] != null) {
        const error = stringField(args, key, { min: 4, max: 9, pattern: /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i });
        if (error) return validationError("INVALID_VALUE", `"${key}" must be a hex color.`, `function.arguments.${key}`);
      }
    }
    if (args.density != null && !["cozy", "compact"].includes(args.density)) return validationError("INVALID_VALUE", "Unknown density.", "function.arguments.density");
    if (args.shape != null && !["square", "round"].includes(args.shape)) return validationError("INVALID_VALUE", "Unknown shape.", "function.arguments.shape");
  }
  if (name === "set_tracker") {
    if (!TRACKER_KINDS.includes(args.kind)) {
      return validationError("INVALID_VALUE", "Unknown tracker type.", "function.arguments.kind");
    }
    if (args.color != null && !/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(args.color)) {
      return validationError("INVALID_VALUE", '"color" must be a hex color.', "function.arguments.color");
    }
    if (args.size != null && !PANEL_SIZES.includes(args.size)) {
      return validationError("INVALID_VALUE", "Unknown tracker size.", "function.arguments.size");
    }
    if (args.kind === "chart") {
      if (!exactlyOne(args, ["measure_id", "measures"])) {
        return validationError(
          args.measure_id != null && args.measures != null
            ? "INVALID_COMBINATION"
            : "REQUIRED_FIELD",
          "Use one measurement id or one chart measurement list.",
          "function.arguments"
        );
      }
      if (args.chart != null && !CHART_TYPES.includes(args.chart)) {
        return validationError("INVALID_VALUE", "Unknown chart style.", "function.arguments.chart");
      }
      if (args.goal != null || args.mode != null) {
        return validationError(
          "INVALID_COMBINATION",
          "Chart trackers do not use a counter goal or mode.",
          "function.arguments"
        );
      }
    } else {
      if (args.measure_id == null) {
        return validationError("REQUIRED_FIELD", '"measure_id" is required.', "function.arguments.measure_id");
      }
      if (args.measures != null || args.chart != null || args.days != null) {
        return validationError(
          "INVALID_COMBINATION",
          "Counter trackers cannot include chart-only fields.",
          "function.arguments"
        );
      }
      if (args.mode != null && !TRACKER_MODES.includes(args.mode)) {
        return validationError("INVALID_VALUE", "Unknown tracker goal mode.", "function.arguments.mode");
      }
    }
  }
  if (name === "remove_tracker" && !exactlyOne(args, ["id", "match"])) {
    return validationError(
      args.id != null && args.match != null ? "INVALID_COMBINATION" : "REQUIRED_FIELD",
      "Use exactly one tracker identifier.",
      "function.arguments"
    );
  }
  if (name === "remember" && args.kind != null && !["fact", "preference"].includes(args.kind)) {
    return validationError("INVALID_VALUE", "Unknown memory type.", "function.arguments.kind");
  }
  if (name === "forget_memory" && !exactlyOne(args, ["memory_id", "match"])) {
    return validationError(
      args.memory_id != null && args.match != null
        ? "INVALID_COMBINATION"
        : "REQUIRED_FIELD",
      "Use exactly one memory identifier.",
      "function.arguments"
    );
  }
  if (name === "set_scene" && !SCENES.includes(args.scene)) return validationError("INVALID_VALUE", "Unknown scene.", "function.arguments.scene");
  if (name === "set_layout") {
    if (args.order != null && (!Array.isArray(args.order) || args.order.some((id) => !PANELS.includes(id)) || new Set(args.order).size !== args.order.length)) return validationError("INVALID_VALUE", "Layout order is invalid.", "function.arguments.order");
    if (args.sizes != null) {
      if (!isPlainObject(args.sizes)) return validationError("INVALID_TYPE", "Layout sizes must be an object.", "function.arguments.sizes");
      for (const [id, size] of Object.entries(args.sizes)) {
        if (!PANELS.includes(id)) return validationError("UNKNOWN_FIELD", `Unknown panel "${id}".`, `function.arguments.sizes.${id}`);
        if (!PANEL_SIZES.includes(size)) return validationError("INVALID_VALUE", `Unknown panel size "${size}".`, `function.arguments.sizes.${id}`);
      }
    }
    if (args.reset === true && (args.order != null || args.sizes != null)) return validationError("INVALID_COMBINATION", "Reset cannot be combined with layout changes.", "function.arguments");
    if (args.reset !== true && args.order == null && args.sizes == null) return validationError("REQUIRED_FIELD", "A layout change is required.", "function.arguments");
  }

  return { arguments: args };
}

export function validateNativeToolCall(toolCall, { confirmedToolCallIds = [] } = {}) {
  if (!isPlainObject(toolCall)) return validationError("INVALID_TYPE", "Tool call must be an object.", "tool_call");
  for (const key of Object.keys(toolCall)) {
    if (!["id", "type", "function"].includes(key)) return validationError("UNKNOWN_FIELD", `Unknown tool-call field "${key}".`, key);
  }
  if (typeof toolCall.id !== "string" || !toolCall.id.trim()) return validationError("REQUIRED_FIELD", "Tool call id is required.", "id");
  if (toolCall.type !== "function" || !isPlainObject(toolCall.function)) return validationError("INVALID_TYPE", "Only function tool calls are supported.", "type");
  for (const key of Object.keys(toolCall.function)) {
    if (!["name", "arguments"].includes(key)) return validationError("UNKNOWN_FIELD", `Unknown function field "${key}".`, `function.${key}`);
  }
  const name = String(toolCall.function.name || "");
  if (!BIGBRICEY_TOOL_NAMES.includes(name)) return validationError("UNKNOWN_TOOL", `Tool "${name}" is not allowed.`, "function.name");
  if (typeof toolCall.function.arguments !== "string") return validationError("INVALID_TYPE", "Tool arguments must be a JSON string.", "function.arguments");
  if (toolCall.function.arguments.length > 16_000) return validationError("ARGUMENTS_TOO_LARGE", "Tool arguments are too large.", "function.arguments");
  let parsed;
  try {
    parsed = JSON.parse(toolCall.function.arguments);
  } catch {
    return validationError("INVALID_JSON", "Tool arguments are not valid JSON.", "function.arguments");
  }
  if (!isPlainObject(parsed)) return validationError("INVALID_TYPE", "Tool arguments must be a JSON object.", "function.arguments");
  const checked = validateArguments(name, parsed);
  if (checked.error) return checked;
  const policy = getToolPolicy(name);
  let status = "ready";
  let confirmation = null;
  if (policy.destructive) {
    const confirmed = confirmedToolCallIds.includes(toolCall.id);
    status = confirmed ? "ready" : "needs_confirmation";
    confirmation = { ...policy.confirmation, state: confirmed ? "confirmed" : "required" };
  }
  return {
    ok: true,
    status,
    tool_call_id: toolCall.id,
    tool_name: name,
    arguments: checked.arguments,
    policy,
    confirmation,
  };
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

export function buildToolResultEnvelope({
  toolCallId,
  toolName,
  status,
  changed = false,
  data = null,
  error = null,
  confirmation = null,
  undoToken = null,
} = {}) {
  const success = status === "success";
  const pending = status === "needs_confirmation";
  return {
    schema_version: 1,
    tool_call_id: String(toolCallId || ""),
    tool_name: String(toolName || ""),
    status: success || pending ? status : "error",
    ok: success,
    changed: success ? Boolean(changed) : false,
    data: success ? stable(data) : null,
    error: success || pending ? null : error ? stable({
      code: String(error.code || "TOOL_FAILED"),
      message: String(error.message || "The tool failed."),
      retryable: Boolean(error.retryable),
    }) : { code: "TOOL_FAILED", message: "The tool failed.", retryable: false },
    confirmation: pending ? stable(confirmation) : null,
    undo_token: success && undoToken ? String(undoToken) : null,
  };
}

export function buildNativeToolResultMessage(envelope) {
  return {
    role: "tool",
    tool_call_id: envelope.tool_call_id,
    content: JSON.stringify(envelope),
  };
}
