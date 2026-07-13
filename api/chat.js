import {
  resolveFood,
  extractJson,
  sendJson,
  readBody,
  toGrams,
  round,
} from "./_lib.js";
import { requireUser } from "./_auth.js";
import {
  dayKeyFor,
  logEvent,
  supabaseConfig,
  upsertWatchTarget,
  evaluateWatches,
  sbRpc,
  getProfile,
  onboardingFromPrefs,
  ensureProfile,
} from "./_supabase.js";
import { submitFeedback } from "./_members.js";
import { llmChat, llmConfig, DOMAIN_CONTRACT } from "./_llm.js";
import { buildStatsReport } from "./_report.js";
import { formatPersonBlock } from "./_coach_context.js";
import { knowledgeForSystemPrompt } from "./_knowledge.js";

/**
 * Conversational control of the food log.
 * User can add, fix amounts, remove, clear, ask about totals — not only "6 eggs".
 */
export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    return res.status(204).end();
  }
  if (req.method !== "POST") return sendJson(res, 405, { error: "POST only" });

  const session = await requireUser(req, res);
  if (!session) return;

  try {
    const body = await readBody(req);
    const text = String(body?.text || "").trim();
    const rows = Array.isArray(body?.rows) ? body.rows : [];
    if (!text) return sendJson(res, 400, { error: "text required" });

    let personCtx = null;
    if (supabaseConfig().ok) {
      try {
        await ensureProfile(session.email, {
          name: session.name,
          picture: session.picture,
        });
        const profile = await getProfile(session.email);
        personCtx = onboardingFromPrefs(profile?.prefs);
      } catch {
        personCtx = null;
      }
    }

    const intent = await interpretIntent(text, rows, {
      email: session.email,
      name: session.name,
      person: personCtx,
    });

    if (intent?.error === "model_failed") {
      // Fallback: treat as add food
      return await doAdd(text, rows, res, "Couldn't fully parse that — tried as a food add.");
    }

    const actions = intent?.actions || [];

    // Export / print stats for doctor or other AI agents
    for (const action of actions) {
      const type = (action.type || action.action || "").toLowerCase();
      if (
        type === "export_report" ||
        type === "export" ||
        type === "stats_report" ||
        type === "print_stats"
      ) {
        try {
          const days = Number(action.days) || 30;
          const { text: reportText } = await buildStatsReport(session.email, {
            days,
          });
          return sendJson(res, 200, {
            reply:
              (intent.reply ? intent.reply + "\n\n" : "") +
              "Here's your data pack (copy/paste for your doctor or another AI):\n\n" +
              reportText,
            rows,
            changed: false,
            report: reportText,
          });
        } catch (err) {
          return sendJson(res, 200, {
            reply: `Couldn't build report: ${err.message}`,
            rows,
            changed: false,
          });
        }
      }
    }

    if (!actions.length && intent?.reply) {
      return sendJson(res, 200, {
        reply: intent.reply,
        rows,
        changed: false,
      });
    }

    // If model just said add with food phrase, or returned empty — try add
    if (!actions.length) {
      return await doAdd(text, rows, res, null);
    }

    let next = rows.map((r) => ({ ...r }));
    const notes = [];
    const sideEvents = [];

    for (const action of actions) {
      const type = (action.type || action.action || "").toLowerCase();

      if (type === "feedback" || type === "suggestion" || type === "product_feedback") {
        const msg = action.message || action.text || text;
        try {
          await submitFeedback(session.email, msg, {
            name: session.name,
            source: "chat",
          });
          notes.push("Got it — sent your suggestion to Brice (not your food log, just the note).");
        } catch (err) {
          notes.push(`Couldn't send feedback: ${err.message}`);
        }
        continue;
      }

      if (type === "set_watch" || type === "watch") {
        if (!supabaseConfig().ok) {
          notes.push("Cloud off — can't save watch target.");
          continue;
        }
        try {
          const mid = action.measure_id || action.measure || action.name;
          const mode = action.mode || "floor";
          await upsertWatchTarget(session.email, {
            measureId: mid,
            label: action.label || mid,
            mode,
            targetMin: action.target_min ?? action.min ?? action.value,
            targetMax: action.target_max ?? action.max,
            windowDays: action.window_days || action.window || 7,
            unit: action.unit || "",
            severity: action.severity || "yellow",
          });
          notes.push(
            `Watching ${action.label || mid}: ${mode} ` +
              `${action.target_min ?? action.min ?? action.value ?? ""}` +
              (action.target_max != null ? `–${action.target_max}` : "") +
              ` ${action.unit || ""}`.trim()
          );
        } catch (err) {
          notes.push(`Couldn't set watch: ${err.message}`);
        }
        continue;
      }

      if (
        type === "log_exercise" ||
        type === "exercise" ||
        type === "workout" ||
        type === "log_activity" ||
        type === "log_life"
      ) {
        const title =
          action.title ||
          action.activity ||
          action.name ||
          [action.exercise, action.detail].filter(Boolean).join(" ") ||
          "Activity";
        // Dynamic category: bike, climb, trt, etc.
        let categoryId = String(action.category_id || action.category || "exercise")
          .toLowerCase()
          .replace(/[^a-z0-9_]+/g, "_");
        const categoryLabel = action.category_label || action.categoryLabel || categoryId;
        const categoryKind = action.category_kind || action.kind || "exercise";
        if (supabaseConfig().ok) {
          try {
            await sbRpc("ensure_category", {
              p_id: categoryId,
              p_label: categoryLabel,
              p_kind: categoryKind,
            });
          } catch {
            /* ok */
          }
        }
        const measures = [];
        const pushM = (id, value, unit, label) => {
          if (value == null || value === "") return;
          const v = Number(value);
          if (!Number.isFinite(v)) return;
          measures.push({ measure_id: id, value: v, unit: unit || "", label });
        };
        pushM("sets", action.sets, "sets");
        pushM("reps", action.reps ?? action.pushups, "reps");
        pushM("load_lb", action.weight ?? action.load_lb, "lb");
        pushM("duration_min", action.duration_min ?? action.minutes, "min");
        pushM("distance_mi", action.distance_mi ?? action.miles, "mi");
        pushM("steps", action.steps, "steps");
        // freeform measures from action.measures array or extras object
        if (Array.isArray(action.measures)) {
          for (const m of action.measures) {
            pushM(m.measure_id || m.id, m.value, m.unit, m.label);
          }
        }
        if (action.extras && typeof action.extras === "object") {
          for (const [k, v] of Object.entries(action.extras)) {
            pushM(k, v, action.unit || "");
          }
        }
        if (supabaseConfig().ok) {
          try {
            const r = await logEvent(session.email, {
              categoryId,
              categoryLabel,
              categoryKind,
              title,
              rawText: text,
              dayKey: dayKeyFor(),
              payload: action,
              measures,
              source: "chat",
            });
            sideEvents.push(r);
            notes.push(`Logged: ${title} (${categoryId})`);
          } catch (err) {
            notes.push(`Activity noted but cloud save failed: ${err.message}`);
          }
        } else {
          notes.push(`Activity noted (cloud off): ${title}`);
        }
        continue;
      }

      if (type === "log_steps" || type === "steps") {
        const steps = Number(action.steps ?? action.value ?? action.count);
        if (!Number.isFinite(steps)) {
          notes.push("Steps need a number.");
          continue;
        }
        if (supabaseConfig().ok) {
          try {
            await logEvent(session.email, {
              categoryId: "steps",
              title: `${Math.round(steps)} steps`,
              rawText: text,
              dayKey: dayKeyFor(),
              payload: { steps },
              measures: [{ measure_id: "steps", value: steps, unit: "steps" }],
              clientId: `steps:${dayKeyFor()}`,
              source: "chat",
            });
            notes.push(`Logged ${Math.round(steps).toLocaleString()} steps.`);
          } catch (err) {
            notes.push(`Steps noted but cloud save failed: ${err.message}`);
          }
        } else {
          notes.push(`Steps noted (cloud off): ${steps}`);
        }
        continue;
      }

      if (type === "log_metric" || type === "metric" || type === "body") {
        const mid = String(action.measure_id || action.metric || action.name || "custom")
          .toLowerCase()
          .replace(/[^a-z0-9_]+/g, "_");
        const value = Number(action.value ?? action.amount);
        if (!mid || !Number.isFinite(value)) {
          notes.push("Metric needs a name and number.");
          continue;
        }
        if (supabaseConfig().ok) {
          try {
            await logEvent(session.email, {
              categoryId: action.categoryId || "body",
              title: `${action.label || mid}: ${value}${action.unit ? " " + action.unit : ""}`,
              rawText: text,
              dayKey: dayKeyFor(),
              payload: action,
              measures: [
                {
                  measure_id: mid,
                  value,
                  unit: action.unit || "",
                  label: action.label || mid,
                  group: action.group || "body",
                },
              ],
              source: "chat",
            });
            notes.push(`Logged ${action.label || mid}: ${value}`);
          } catch (err) {
            notes.push(`Metric noted but cloud save failed: ${err.message}`);
          }
        }
        continue;
      }

      if (type === "add" || type === "add_food") {
        const phrase =
          action.food_text ||
          action.text ||
          [action.amount, action.unit, action.food].filter(Boolean).join(" ");
        if (!phrase) {
          notes.push("Add requested but no food specified.");
          continue;
        }
        const resolved = await resolveFood(String(phrase));
        if (resolved.error === "off_topic") {
          notes.push(`Couldn't add “${phrase}”.`);
          continue;
        }
        if (!resolved.row) {
          notes.push(resolved.note || `No nutrition match for “${phrase}”.`);
          continue;
        }
        if (!rowHasMacros(resolved.row)) {
          notes.push(`Incomplete data for “${phrase}” — try a more specific name.`);
          continue;
        }
        next.push(resolved.row);
        notes.push(`Added: ${resolved.row.label}`);
      } else if (type === "update" || type === "update_amount" || type === "fix") {
        const idx = findRowIndex(next, action);
        if (idx < 0) {
          notes.push(`Couldn't find a row to update (${action.match || action.food || "?"}).`);
          continue;
        }
        const old = next[idx];
        const foodName =
          action.food ||
          action.food_query ||
          stripAmount(old.label) ||
          old.label;
        const amount = action.amount != null ? action.amount : null;
        const unit = action.unit || "serving";
        let phrase;
        if (amount != null) {
          phrase = `${amount} ${unit} ${foodName}`.replace(/\s+/g, " ").trim();
        } else if (action.food_text) {
          phrase = action.food_text;
        } else {
          notes.push("Update needs a new amount.");
          continue;
        }
        const resolved = await resolveFood(phrase);
        if (!resolved.row || !rowHasMacros(resolved.row)) {
          // scale existing row if lookup fails but we know grams ratio
          if (amount != null && old.grams) {
            const newGrams = toGrams(Number(amount), unit);
            const scale = newGrams / old.grams;
            next[idx] = scaleRow(old, scale, phrase);
            notes.push(`Updated to: ${next[idx].label}`);
          } else {
            notes.push(resolved.note || `Couldn't update “${old.label}”.`);
          }
          continue;
        }
        // keep same id so UI stability
        resolved.row.id = old.id;
        next[idx] = resolved.row;
        notes.push(`Updated: ${old.label} → ${resolved.row.label}`);
      } else if (type === "remove" || type === "delete") {
        const idx = findRowIndex(next, action);
        if (idx < 0) {
          notes.push(`Couldn't find row to remove (${action.match || action.food || "?"}).`);
          continue;
        }
        const gone = next[idx].label;
        next.splice(idx, 1);
        notes.push(`Removed: ${gone}`);
      } else if (type === "clear" || type === "clear_day") {
        next = [];
        notes.push("Cleared the day.");
      } else if (type === "message" || type === "reply") {
        if (action.text) notes.push(action.text);
      } else if (type === "add_food_phrase") {
        // alias
        const resolved = await resolveFood(action.food_text || text);
        if (resolved.row && rowHasMacros(resolved.row)) {
          next.push(resolved.row);
          notes.push(`Added: ${resolved.row.label}`);
        }
      }
    }

    // If nothing worked and looks like a food, try plain add
    if (!notes.length || (notes.every((n) => /couldn't|no /i.test(n)) && looksLikeFood(text))) {
      return await doAdd(text, rows, res, notes.join(" "));
    }

    let watchStatuses = null;
    if (supabaseConfig().ok && notes.some((n) => /Watching |Logged /i.test(n))) {
      try {
        watchStatuses = (await evaluateWatches(session.email)).statuses;
      } catch {
        /* optional */
      }
    }

    return sendJson(res, 200, {
      reply: intent.reply || notes.join(" "),
      rows: next,
      changed: JSON.stringify(next) !== JSON.stringify(rows),
      notes,
      sideEvents,
      watchStatuses,
    });
  } catch (e) {
    return sendJson(res, 500, {
      error: String(e.message || e),
      detail: e.detail || null,
    });
  }
}

async function doAdd(text, rows, res, prefix) {
  const resolved = await resolveFood(text);
  if (resolved.error === "off_topic") {
    return sendJson(res, 200, {
      reply:
        (prefix ? prefix + " " : "") +
        "I can add foods, change amounts (e.g. “make blackberries 10 oz”), remove items, or clear the day. What do you want to do?",
      rows,
      changed: false,
    });
  }
  if (!resolved.row || !rowHasMacros(resolved.row)) {
    return sendJson(res, 200, {
      reply: resolved.note || "Couldn't find solid nutrition data for that — try a more specific food name.",
      rows,
      changed: false,
    });
  }
  const next = [...rows, resolved.row];
  return sendJson(res, 200, {
    reply: (prefix ? prefix + " " : "") + `Added: ${resolved.row.label}`,
    rows: next,
    changed: true,
  });
}

async function interpretIntent(text, rows, ctx = {}) {
  if (!llmConfig().ok) {
    // Offline: export keyword still works without model
    if (/export|print.*(stat|report|summary)|stats? pack|for my (doctor|gpt|claude|grok)/i.test(text)) {
      return { reply: "Building your data pack…", actions: [{ type: "export_report", days: 30 }] };
    }
    return { actions: [{ type: "add", food_text: text }] };
  }

  const summary = rows.map((r, i) => ({
    index: i,
    id: r.id,
    label: r.label,
    kcal: r.kcal,
    protein: r.protein,
    fat: r.fat,
    carbs: r.carbs,
    grams: r.grams,
  }));

  const personBlock = formatPersonBlock(ctx);

  const system = `${DOMAIN_CONTRACT}

${personBlock}

${knowledgeForSystemPrompt()}

You manage:
1) TODAY's food table (add/fix/remove/clear) — server looks up real nutrition; NEVER invent macros
2) Forever cloud events — life activity becomes categories automatically
3) Watch targets — "watch my potassium, warn if under 3500mg / 7 days"
4) Product feedback to Brice — app ideas/bugs only, NEVER private food diary
5) Export packs — "print my stats" / "export for my doctor" / "pack for ChatGPT"

Current food log:
${JSON.stringify(summary, null, 0)}

Respond with ONLY valid JSON:
{
  "reply": "short friendly confirmation or clarifying question",
  "actions": [
    {"type":"add","food_text":"1 lb bacon"},
    {"type":"update","match":"blackberries","amount":10,"unit":"oz"},
    {"type":"remove","match":"artichoke"},
    {"type":"clear"},
    {"type":"log_exercise","title":"Incline push-ups","category_id":"pushups","sets":3,"reps":20},
    {"type":"log_activity","title":"Mountain bike 45 min","category_id":"cycling","category_kind":"exercise","duration_min":45},
    {"type":"log_steps","steps":30000},
    {"type":"log_metric","measure_id":"weight_lb","label":"Body weight","value":210,"unit":"lb"},
    {"type":"set_watch","measure_id":"potassium","label":"Potassium","mode":"floor","target_min":3500,"unit":"mg","window_days":7,"severity":"yellow"},
    {"type":"export_report","days":30},
    {"type":"feedback","message":"Would love a barcode scanner"}
  ]
}

Rules:
- Ambiguous food ("sushi") → empty actions + reply asking what kind before add
- Stress/argument → log_activity with category_id stress, title factual (no counseling)
- Export/print/stats for doctor or other AI → export_report with days (7/30/90)
- Watch magnesium/potassium → set_watch
- "30000 steps" → log_steps
- App ideas → feedback only
- Never invent nutrition numbers
- Totals questions → empty actions + answer from log
- Off-topic → empty actions + friendly redirect (DOMAIN CONTRACT)`;

  try {
    const out = await llmChat({
      temperature: 0,
      title: "BigBricey-Chat",
      messages: [
        { role: "system", content: system },
        { role: "user", content: text },
      ],
    });
    const parsed = extractJson(out.content);
    if (parsed?.error === "no_json" || parsed?.error === "bad_json") {
      return { error: "model_failed", raw: out.content };
    }
    return parsed;
  } catch (e) {
    return { error: "model_failed", detail: e.detail || e.message };
  }
}

function findRowIndex(rows, action) {
  if (action.index != null && rows[action.index]) return Number(action.index);
  if (action.id) {
    const i = rows.findIndex((r) => r.id === action.id);
    if (i >= 0) return i;
  }
  const m = String(action.match || action.food || action.label || "").toLowerCase();
  if (!m) return -1;
  // prefer last matching row (most recent)
  for (let i = rows.length - 1; i >= 0; i--) {
    if (String(rows[i].label || "").toLowerCase().includes(m)) return i;
  }
  return -1;
}

function stripAmount(label) {
  return String(label || "")
    .replace(/^[\d./]+\s*(lb|lbs|oz|g|kg|scoop|scoops|egg|eggs|cup|cups|tbsp|tsp|serving|pound|pounds)?\s*/i, "")
    .trim();
}

function scaleRow(old, scale, newLabel) {
  const keys = [
    "kcal",
    "protein",
    "fat",
    "carbs",
    "fiber",
    "sugars",
    "potassium",
    "magnesium",
    "sodium",
    "grams",
  ];
  const next = { ...old, label: newLabel || old.label };
  for (const k of keys) {
    next[k] = round((Number(old[k]) || 0) * scale);
  }
  return next;
}

function rowHasMacros(row) {
  return (
    (Number(row.kcal) || 0) > 0 ||
    (Number(row.protein) || 0) > 0 ||
    (Number(row.fat) || 0) > 0
  );
}

function looksLikeFood(text) {
  return /lb|oz|egg|scoop|cup|bacon|beef|chicken|berry|fruit|shake|salt|oil|avocado|pound|gram|\d/i.test(
    text
  );
}
