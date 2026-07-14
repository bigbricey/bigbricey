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
  listSavedFoods,
  findSavedFood,
  upsertSavedFood,
  deleteSavedFood,
  rowFromSavedFood,
  updateUserGoals,
  saveUserLayout,
  saveUserTheme,
  saveUserBoxes,
  listConversations,
  getConversation,
  createConversation,
  touchConversation,
  listMessages,
  appendMessage,
  buildChatContextForModel,
  getMemoryNotes,
  addMemoryNote,
  removeMemoryNote,
  logLlmUsage,
  sb,
} from "./_supabase.js";
import { submitFeedback, summarizeFeedback, isAdmin } from "./_members.js";
import { llmChat, llmConfig, DOMAIN_CONTRACT } from "./_llm.js";
import {
  capabilitiesForSystemPrompt,
  abilitiesReplyText,
  SCENE_IDS,
} from "./_capabilities.js";
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
  const session = await requireUser(req, res);
  if (!session) return;

  // ——— GET: list / load conversations ———
  if (req.method === "GET") {
    try {
      const url = new URL(req.url, `https://${req.headers.host}`);
      const id = url.searchParams.get("id") || url.searchParams.get("conversation_id");
      if (id) {
        const conv = await getConversation(session.email, id);
        if (!conv) return sendJson(res, 404, { error: "not_found" });
        const messages = await listMessages(session.email, id, { limit: 800 });
        return sendJson(res, 200, { conversation: conv, messages });
      }
      const conversations = await listConversations(session.email);
      return sendJson(res, 200, { conversations });
    } catch (e) {
      return sendJson(res, 500, { error: String(e.message || e) });
    }
  }

  if (req.method !== "POST") return sendJson(res, 405, { error: "POST only" });

  try {
    const body = await readBody(req);

    // Create empty conversation
    if (body?.op === "new_conversation" || body?.op === "new_chat") {
      try {
        const conv = await createConversation(session.email, {
          title: body.title || "New chat",
        });
        return sendJson(res, 200, { conversation: conv, messages: [] });
      } catch (e) {
        return sendJson(res, 500, {
          error: String(e.message || e),
          hint: "Run migration_007_chat_history.sql in Supabase if tables missing.",
        });
      }
    }

    const text = String(body?.text || "").trim();
    const rows = Array.isArray(body?.rows) ? body.rows : [];
    if (!text) return sendJson(res, 400, { error: "text required" });

    let personCtx = null;
    let themeSnap = null;
    let memoryNotes = [];
    if (supabaseConfig().ok) {
      try {
        await ensureProfile(session.email, {
          name: session.name,
          picture: session.picture,
        });
        const profile = await getProfile(session.email);
        personCtx = onboardingFromPrefs(profile?.prefs);
        if (profile?.prefs?.theme && typeof profile.prefs.theme === "object") {
          themeSnap = profile.prefs.theme;
        }
        memoryNotes = await getMemoryNotes(session.email);
      } catch {
        personCtx = null;
      }
    }

    let savedList = [];
    if (supabaseConfig().ok) {
      try {
        savedList = await listSavedFoods(session.email);
      } catch {
        savedList = [];
      }
    }

    // Conversation + history
    let conversationId = body.conversation_id || body.conversationId || null;
    let historyMessages = [];
    let chatSummary = null;
    let convMeta = null;
    if (supabaseConfig().ok) {
      try {
        if (conversationId) {
          convMeta = await getConversation(session.email, conversationId);
          if (!convMeta) conversationId = null;
        }
        if (!conversationId) {
          const title =
            text.length > 48 ? text.slice(0, 45) + "…" : text.slice(0, 48) || "Chat";
          convMeta = await createConversation(session.email, { title });
          conversationId = convMeta?.id || null;
        }
        if (conversationId) {
          await appendMessage(session.email, conversationId, "user", text);
          const ctx = await buildChatContextForModel(session.email, conversationId, {
            maxMessages: 120,
          });
          // exclude the message we just added from history for the model? include all recent
          historyMessages = (ctx.messages || []).filter(
            (m) => !(m.role === "user" && m.content === text && m === ctx.messages[ctx.messages.length - 1])
          );
          // Actually include all but last user is the current - better: all except last
          const msgs = ctx.messages || [];
          if (msgs.length && msgs[msgs.length - 1]?.role === "user") {
            historyMessages = msgs.slice(0, -1);
          } else {
            historyMessages = msgs;
          }
          chatSummary = ctx.summary;
          convMeta = ctx.conversation || convMeta;
        }
      } catch (err) {
        // Tables may not exist yet — continue without history
        conversationId = conversationId || null;
      }
    }

    // Fast path: "what can you do?" — never treat as food
    if (isAbilitiesQuestion(text)) {
      const reply = ABILITIES_REPLY;
      if (conversationId) {
        try {
          await appendMessage(session.email, conversationId, "assistant", reply);
        } catch {
          /* */
        }
      }
      return sendJson(res, 200, {
        reply,
        rows,
        changed: false,
        actions: [],
        conversation_id: conversationId,
      });
    }

    let intent = await interpretIntent(text, rows, {
      email: session.email,
      name: session.name,
      person: personCtx,
      savedFoods: savedList,
      history: historyMessages,
      chatSummary,
      theme: themeSnap,
      memoryNotes,
      conversationId,
    });

    // Model often says "Let it snow!" with no set_scene — we force it from user text
    const forcedScene = detectSceneFromText(text);

    if (intent?.error === "model_failed") {
      // Still honor clear scene *commands* without the LLM
      if (forcedScene) {
        intent = {
          reply: sceneReplyFor(forcedScene),
          actions: [{ type: "set_scene", scene: forcedScene }],
        };
      } else if (isSceneChat(text)) {
        return sendJson(res, 200, {
          reply: SCENES_HELP,
          rows,
          changed: false,
          conversation_id: conversationId,
        });
      } else if (isAbilitiesQuestion(text) || isNonFoodUtterance(text)) {
        // Questions / customization talk → never force food add
        return sendJson(res, 200, {
          reply: isAbilitiesQuestion(text)
            ? ABILITIES_REPLY
            : "I can log food & life data, change goals, rearrange Today, restyle colors/text size/corners, add custom boxes & charts, and export packs. Ask “what can you do?” for the full list — or just say what you want (e.g. “make eaten rings pink”).",
          rows,
          changed: false,
          conversation_id: conversationId,
        });
      } else {
        return await doAdd(
          text,
          rows,
          res,
          session.email,
          "Couldn't fully parse that — tried as a food add."
        );
      }
    }

    const actions = Array.isArray(intent?.actions) ? [...intent.actions] : [];
    if (forcedScene) {
      const hasScene = actions.some((a) => {
        const t = String(a?.type || a?.action || "").toLowerCase();
        return (
          t === "set_scene" ||
          t === "scene" ||
          t === "set_effect" ||
          t === "weather" ||
          t === "ambiance"
        );
      });
      if (!hasScene) {
        actions.push({ type: "set_scene", scene: forcedScene });
      }
    }

    let goalsOut = null;
    let layoutOut = null;
    let themeOut = null;
    let boxesOut = null;
    let suggestionsOut = null;
    let sceneOut = null;

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
      const reply = intent.reply;
      if (conversationId) {
        try {
          await appendMessage(session.email, conversationId, "assistant", reply);
        } catch {
          /* */
        }
      }
      return sendJson(res, 200, {
        reply,
        rows,
        changed: false,
        conversation_id: conversationId,
      });
    }

    // If model just said add with food phrase, or returned empty — try add
    if (!actions.length) {
      return await doAdd(text, rows, res, session.email, null, conversationId);
    }

    let next = rows.map((r) => ({ ...r }));
    const notes = [];
    const sideEvents = [];
    let memoryOut = null;

    for (const action of actions) {
      const type = (action.type || action.action || "").toLowerCase();

      if (
        type === "remember" ||
        type === "save_memory" ||
        type === "memory_note" ||
        type === "add_memory"
      ) {
        const note = action.note || action.message || action.text || action.fact;
        try {
          memoryOut = await addMemoryNote(session.email, note);
          notes.push(`Saved permanent note: “${String(note).slice(0, 80)}”.`);
        } catch (err) {
          notes.push(`Couldn't save memory note: ${err.message}`);
        }
        continue;
      }

      if (type === "forget" || type === "remove_memory" || type === "delete_memory") {
        const match = action.note || action.match || action.message || action.text;
        try {
          memoryOut = await removeMemoryNote(session.email, match);
          notes.push(`Removed matching permanent note(s) for “${match}”.`);
        } catch (err) {
          notes.push(`Couldn't remove note: ${err.message}`);
        }
        continue;
      }

      if (type === "feedback" || type === "suggestion" || type === "product_feedback") {
        const msg = action.message || action.text || text;
        try {
          const saved = await submitFeedback(session.email, msg, {
            name: session.name,
            source: "chat",
            category: action.category || action.cat,
            theme_key: action.theme_key || action.theme || action.themeKey,
            theme_label: action.theme_label || action.themeLabel || action.title,
          });
          notes.push(
            "Noted on the BigBricey product backlog for the owner to review (app idea only — not your food diary). Nothing ships until Brice decides."
          );
          if (saved?.theme_key) {
            /* quiet */
          }
        } catch (err) {
          notes.push(`Couldn't save product note: ${err.message}`);
        }
        continue;
      }

      // Admin only: digest of user suggestions (human-in-the-loop, no auto-build)
      if (
        type === "list_suggestions" ||
        type === "suggestion_digest" ||
        type === "feedback_digest" ||
        type === "what_people_want"
      ) {
        try {
          if (!(await isAdmin(session.email))) {
            notes.push("Suggestion digest is admin-only.");
            continue;
          }
          const summary = await summarizeFeedback({ limit: 200 });
          const top = (summary.themes || []).slice(0, 15);
          if (!top.length) {
            notes.push("No product suggestions in the backlog yet.");
          } else {
            const lines = top.map(
              (t, i) =>
                `${i + 1}. [${t.importance}] ${t.theme_label} · ${t.unique_users} people · ${t.count} mentions · ${t.category} · new:${t.new_count}`
            );
            notes.push(
              `Suggestion board (${summary.total_items} notes → ${summary.total_themes} themes). Review with Brice — do NOT auto-build.\n` +
                lines.join("\n")
            );
          }
          suggestionsOut = summary;
        } catch (err) {
          notes.push(`Couldn't load suggestions: ${err.message}`);
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

      if (
        type === "save_food" ||
        type === "save_saved_food" ||
        type === "remember_food" ||
        type === "save_shake"
      ) {
        try {
          const name = action.name || action.food || action.label;
          if (!name) {
            notes.push("Need a name to save that food (e.g. “morning shake”).");
            continue;
          }
          if (
            action.kcal == null &&
            action.protein == null &&
            action.fat == null &&
            action.carbs == null
          ) {
            notes.push(
              `To save “${name}”, give macros once (kcal / protein / fat / carbs). Then you can log it by name forever.`
            );
            continue;
          }
          const saved = await upsertSavedFood(session.email, {
            name,
            description: action.description || null,
            ingredients: action.ingredients || action.recipe || null,
            ingredients_list:
              action.ingredients_list || action.ingredients_detail || null,
            serving_label: action.serving_label || action.serving || "1 serving",
            kcal: action.kcal,
            protein: action.protein,
            fat: action.fat,
            carbs: action.carbs,
            fiber: action.fiber,
            sugars: action.sugars,
            potassium: action.potassium,
            magnesium: action.magnesium,
            sodium: action.sodium,
            grams: action.grams,
            net_carbs: action.net_carbs,
            nutrients: action.nutrients || action.micros || action.vitamins || null,
            extras: action.extras || null,
            // pass through any other flat nutrient fields the model included
            ...Object.fromEntries(
              Object.entries(action).filter(
                ([k]) =>
                  ![
                    "type",
                    "action",
                    "name",
                    "food",
                    "label",
                    "description",
                    "ingredients",
                    "recipe",
                    "ingredients_list",
                    "ingredients_detail",
                    "serving_label",
                    "serving",
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
                    "net_carbs",
                    "nutrients",
                    "micros",
                    "vitamins",
                    "extras",
                  ].includes(k)
              )
            ),
          });
          const microN = saved.extras?.nutrients
            ? Object.keys(saved.extras.nutrients).length
            : 0;
          notes.push(
            `Saved “${saved.name}” (${saved.serving_label}): ${saved.kcal} kcal, ${saved.protein}P / ${saved.fat}F / ${saved.carbs}C` +
              (microN ? ` · ${microN} extra nutrients stored` : "") +
              (saved.ingredients ? ` · ingredients kept` : "") +
              `. Say “log ${saved.name}” anytime.`
          );
        } catch (err) {
          notes.push(`Couldn't save food: ${err.message}`);
        }
        continue;
      }

      if (
        type === "log_saved" ||
        type === "log_saved_food" ||
        type === "add_saved" ||
        type === "use_saved_food"
      ) {
        const name = action.name || action.food || action.match || action.food_text;
        const amount = action.amount != null ? Number(action.amount) : 1;
        if (!name) {
          notes.push("Which saved food? (e.g. “log morning shake”)");
          continue;
        }
        try {
          const saved = await findSavedFood(session.email, name);
          if (!saved) {
            notes.push(
              `No saved food named “${name}”. Save it first with name + macros, or say “list my saved foods”.`
            );
            continue;
          }
          next.push(rowFromSavedFood(saved, amount));
          notes.push(`Added saved: ${amount === 1 ? saved.name : amount + " × " + saved.name}`);
        } catch (err) {
          notes.push(`Couldn't load saved food: ${err.message}`);
        }
        continue;
      }

      if (type === "list_saved" || type === "list_saved_foods") {
        try {
          const list = await listSavedFoods(session.email);
          if (!list.length) {
            notes.push("No saved foods yet. Save one: name + kcal/protein/fat/carbs.");
          } else {
            const lines = list.map(
              (f) =>
                `• ${f.name} (${f.serving_label}): ${f.kcal} kcal, ${f.protein}P/${f.fat}F/${f.carbs}C`
            );
            notes.push(`Your saved foods (${list.length}):\n${lines.join("\n")}`);
          }
        } catch (err) {
          notes.push(`Couldn't list saved foods: ${err.message}`);
        }
        continue;
      }

      if (type === "delete_saved" || type === "remove_saved_food") {
        const name = action.name || action.food || action.match;
        if (!name) {
          notes.push("Which saved food to delete?");
          continue;
        }
        try {
          const gone = await deleteSavedFood(session.email, name);
          notes.push(gone ? `Deleted saved food “${gone.name}”.` : `No saved food “${name}”.`);
        } catch (err) {
          notes.push(`Couldn't delete: ${err.message}`);
        }
        continue;
      }

      if (
        type === "add_box" ||
        type === "set_box" ||
        type === "update_box" ||
        type === "create_box" ||
        type === "add_chart" ||
        type === "set_chart" ||
        type === "chart_box" ||
        type === "remove_box" ||
        type === "delete_box" ||
        type === "clear_boxes"
      ) {
        try {
          const prof = await getProfile(session.email);
          const prefs =
            prof?.prefs && typeof prof.prefs === "object" ? prof.prefs : {};
          let boxes = Array.isArray(prefs.boxes)
            ? prefs.boxes.map((b) => ({ ...b }))
            : [];

          if (type === "clear_boxes") {
            boxesOut = await saveUserBoxes(session.email, []);
            notes.push("Removed all custom boxes.");
            continue;
          }

          if (type === "remove_box" || type === "delete_box") {
            const key = String(
              action.id || action.box || action.measure_id || action.name || action.title || ""
            )
              .toLowerCase()
              .replace(/[^a-z0-9_]+/g, "_");
            const before = boxes.length;
            boxes = boxes.filter((b) => {
              const id = String(b.id || "").toLowerCase();
              const mid = String(b.measure_id || "").toLowerCase();
              const title = String(b.title || "").toLowerCase();
              return (
                id !== key &&
                mid !== key &&
                title !== key &&
                id !== "c_" + key &&
                !title.includes(key)
              );
            });
            if (boxes.length === before) {
              notes.push(`No custom box matched “${key}”.`);
              continue;
            }
            boxesOut = await saveUserBoxes(session.email, boxes);
            // also drop from layout order
            try {
              const lay = prefs.layout && typeof prefs.layout === "object" ? prefs.layout : {};
              const order = Array.isArray(lay.order)
                ? lay.order.filter((x) => !String(x).startsWith("c_") || boxes.some((b) => b.id === x))
                : undefined;
              if (order) {
                layoutOut = await saveUserLayout(session.email, { ...lay, order });
              }
            } catch {
              /* optional */
            }
            notes.push(`Removed custom box “${key}”.`);
            continue;
          }

          // add / update counter or chart
          let kind = String(action.kind || "counter").toLowerCase();
          if (
            type === "add_chart" ||
            type === "set_chart" ||
            type === "chart_box" ||
            kind === "chart" ||
            kind === "graph" ||
            kind === "trend"
          ) {
            kind = "chart";
          }

          const slug = (s) =>
            String(s || "")
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, "_")
              .replace(/^_+|_+$/g, "")
              .slice(0, 32);

          let measures = [];
          if (Array.isArray(action.measures)) {
            measures = action.measures.map(slug).filter(Boolean);
          } else if (action.measure_id || action.measure) {
            measures = [slug(action.measure_id || action.measure)];
          }
          const title =
            action.title ||
            action.label ||
            action.name ||
            action.measure ||
            (kind === "chart" ? "Chart" : "Custom");
          const measure_id =
            measures[0] ||
            slug(action.measure_id || action.measure || action.name || title) ||
            "custom";
          if (kind === "chart" && !measures.length) measures = [measure_id];

          let days = Number(action.days ?? action.range ?? action.window);
          if (action.weeks != null) days = Number(action.weeks) * 7;
          if (action.months != null) days = Number(action.months) * 30;
          if (action.years != null) days = Number(action.years) * 365;
          if (!Number.isFinite(days) || days < 1) days = kind === "chart" ? 30 : null;
          if (days != null) days = Math.min(1095, Math.max(1, Math.round(days)));

          let chart = String(action.chart || action.chart_type || action.style || "line").toLowerCase();
          if (!["line", "bar", "pie"].includes(chart)) chart = "line";

          let id = String(action.id || "").toLowerCase().trim();
          if (!id) {
            id =
              kind === "chart"
                ? "c_chart_" + measures.slice(0, 2).join("_") + "_" + days + "d"
                : "c_" + measure_id;
          }
          if (!id.startsWith("c_")) id = "c_" + id.replace(/[^a-z0-9_]/g, "");
          id = id.slice(0, 48);

          const goal =
            action.goal ?? action.target ?? action.target_min ?? action.min ?? null;
          const box = {
            id,
            kind,
            title: String(title).slice(0, 48),
            measure_id,
            measures: kind === "chart" ? measures.slice(0, 6) : [measure_id],
            unit: action.unit || "",
            goal:
              kind === "counter" && goal != null && goal !== ""
                ? Number(goal)
                : null,
            mode: action.mode || "floor",
            color: action.color || action.accent || "#38bdf8",
            icon: action.icon || action.emoji || (kind === "chart" ? "📈" : "◎"),
            size: action.size || (kind === "chart" ? "full" : "half"),
            chart: kind === "chart" ? chart : undefined,
            days: kind === "chart" ? days : undefined,
          };

          const idx = boxes.findIndex(
            (b) => b.id === id || (kind === "counter" && b.measure_id === measure_id && b.kind !== "chart")
          );
          if (idx >= 0) boxes[idx] = { ...boxes[idx], ...box };
          else boxes.push(box);

          boxesOut = await saveUserBoxes(session.email, boxes);

          // put new box into layout (near top after chat) if new
          try {
            const lay =
              prefs.layout && typeof prefs.layout === "object"
                ? { ...prefs.layout }
                : { order: [], sizes: {} };
            let order = Array.isArray(lay.order) ? lay.order.slice() : [];
            if (!order.includes(id)) {
              const chatAt = order.indexOf("chat");
              if (chatAt >= 0) order.splice(chatAt + 1, 0, id);
              else order.unshift(id);
            }
            const sizes = { ...(lay.sizes || {}), [id]: box.size || "half" };
            layoutOut = await saveUserLayout(session.email, { order, sizes });
          } catch {
            /* optional */
          }

          // optional: watch for counter goals
          if (
            kind === "counter" &&
            box.goal != null &&
            Number.isFinite(Number(box.goal))
          ) {
            try {
              await upsertWatchTarget(session.email, {
                measureId: measure_id,
                label: box.title,
                mode: box.mode || "floor",
                targetMin: box.mode === "ceiling" ? null : Number(box.goal),
                targetMax: box.mode === "ceiling" ? Number(box.goal) : null,
                windowDays: 1,
                unit: box.unit || "",
                severity: "yellow",
              });
            } catch {
              /* optional */
            }
          }

          if (kind === "chart") {
            notes.push(
              `Chart box “${box.title}” · ${measures.join(", ")} · last ${days} days · ${chart}. Drag ⠿ to move · × to remove.`
            );
          } else {
            notes.push(
              `Custom box “${box.title}” ready${
                box.goal != null
                  ? ` · goal ${box.goal}${box.unit ? " " + box.unit : ""}`
                  : ""
              }. Drag ⠿ to move it. Log with measure “${measure_id}”.`
            );
          }
        } catch (err) {
          notes.push(`Couldn't update custom box: ${err.message}`);
        }
        continue;
      }

      if (
        type === "set_scene" ||
        type === "scene" ||
        type === "set_effect" ||
        type === "weather" ||
        type === "ambiance"
      ) {
        try {
          let scene = String(
            action.scene || action.effect || action.name || action.id || "none"
          )
            .toLowerCase()
            .replace(/\s+/g, "_");
          const aliases = {
            raining: "rain",
            rainy: "rain",
            cats_and_dogs: "rain",
            dust: "desert",
            sandy: "desert",
            sand: "desert",
            mud: "desert",
            muddy: "desert",
            dust_storm: "desert",
            beach: "ocean",
            sea: "ocean",
            space: "stars",
            party: "confetti",
            clear: "none",
            off: "none",
            stop: "none",
          };
          if (aliases[scene]) scene = aliases[scene];
          if (!SCENE_IDS.includes(scene)) {
            notes.push(
              `Unknown scene “${scene}”. Try: ${SCENE_IDS.join(", ")}.`
            );
            continue;
          }
          // persist on prefs.scene
          const profile = await getProfile(session.email);
          const prefs =
            profile?.prefs && typeof profile.prefs === "object"
              ? { ...profile.prefs }
              : {};
          prefs.scene = scene;
          await sb("profiles", {
            method: "PATCH",
            query: { email: `eq.${String(session.email).toLowerCase()}` },
            body: { prefs, updated_at: new Date().toISOString() },
            headers: { Prefer: "return=minimal" },
          });
          sceneOut = scene;
          notes.push(
            scene === "none"
              ? "Scene cleared."
              : `Scene set to “${scene}”. Look up — ambient effect on.`
          );
        } catch (err) {
          notes.push(`Couldn't set scene: ${err.message}`);
        }
        continue;
      }

      if (
        type === "set_theme" ||
        type === "update_theme" ||
        type === "set_look" ||
        type === "restyle" ||
        type === "reset_theme"
      ) {
        try {
          if (type === "reset_theme" || action.reset) {
            themeOut = await saveUserTheme(session.email, {
              preset: "midnight",
              accent: "#38bdf8",
              good: "#34d399",
              warn: "#fbbf24",
              bad: "#f87171",
              bg0: "#06080f",
              text: "#f1f5f9",
              muted: "#8b95a8",
              card: "rgba(14, 18, 28, 0.75)",
              ring_left: "#34d399",
              ring_eaten: "#38bdf8",
              ring_goal: "#facc15",
              ring_over: "#f87171",
              glow1: "56,189,248",
              glow2: "52,211,153",
              glow3: "167,139,250",
            });
            notes.push("Theme reset to Midnight.");
            continue;
          }
          const PRESET_MAP = {
            midnight: {
              preset: "midnight",
              accent: "#38bdf8",
              bg0: "#06080f",
              text: "#f1f5f9",
              muted: "#8b95a8",
              card: "rgba(14, 18, 28, 0.75)",
              good: "#34d399",
              warn: "#fbbf24",
              bad: "#f87171",
              ring_left: "#34d399",
              ring_eaten: "#38bdf8",
              ring_goal: "#facc15",
              ring_over: "#f87171",
              glow1: "56,189,248",
              glow2: "52,211,153",
              glow3: "167,139,250",
            },
            light: {
              preset: "light",
              accent: "#0284c7",
              bg0: "#f1f5f9",
              text: "#0f172a",
              muted: "#64748b",
              card: "rgba(255,255,255,0.88)",
              good: "#059669",
              warn: "#d97706",
              bad: "#dc2626",
              ring_left: "#059669",
              ring_eaten: "#0284c7",
              ring_goal: "#ca8a04",
              ring_over: "#dc2626",
              glow1: "14,165,233",
              glow2: "16,185,129",
              glow3: "139,92,246",
            },
            neon: {
              preset: "neon",
              accent: "#22d3ee",
              bg0: "#050510",
              text: "#f5f3ff",
              muted: "#a5b4fc",
              card: "rgba(20, 10, 40, 0.8)",
              good: "#a3e635",
              warn: "#fde047",
              bad: "#fb7185",
              ring_left: "#a3e635",
              ring_eaten: "#e879f9",
              ring_goal: "#fde047",
              ring_over: "#fb7185",
              glow1: "232,121,249",
              glow2: "34,211,238",
              glow3: "163,230,53",
            },
            forest: {
              preset: "forest",
              accent: "#34d399",
              bg0: "#07140f",
              text: "#ecfdf5",
              muted: "#86efac",
              card: "rgba(6, 28, 18, 0.8)",
              good: "#4ade80",
              warn: "#fbbf24",
              bad: "#f87171",
              ring_left: "#4ade80",
              ring_eaten: "#2dd4bf",
              ring_goal: "#fbbf24",
              ring_over: "#f87171",
              glow1: "52,211,153",
              glow2: "16,185,129",
              glow3: "251,191,36",
            },
            pink: {
              preset: "pink",
              accent: "#f472b6",
              bg0: "#1a0a14",
              text: "#fdf2f8",
              muted: "#f9a8d4",
              card: "rgba(40, 12, 28, 0.8)",
              good: "#fb7185",
              warn: "#fbbf24",
              bad: "#e11d48",
              ring_left: "#fb7185",
              ring_eaten: "#f472b6",
              ring_goal: "#fde047",
              ring_over: "#e11d48",
              glow1: "244,114,182",
              glow2: "251,113,133",
              glow3: "192,132,252",
            },
            terminal: {
              preset: "terminal",
              accent: "#4ade80",
              bg0: "#020403",
              text: "#d1fae5",
              muted: "#6ee7b7",
              card: "rgba(0, 20, 10, 0.85)",
              good: "#22c55e",
              warn: "#eab308",
              bad: "#ef4444",
              ring_left: "#4ade80",
              ring_eaten: "#22c55e",
              ring_goal: "#a3e635",
              ring_over: "#ef4444",
              glow1: "74,222,128",
              glow2: "34,197,94",
              glow3: "163,230,53",
              radius: 8,
              density: "compact",
            },
            pastel: {
              preset: "pastel",
              accent: "#c084fc",
              bg0: "#1e1230",
              text: "#faf5ff",
              muted: "#d8b4fe",
              card: "rgba(45, 25, 70, 0.75)",
              good: "#86efac",
              warn: "#fcd34d",
              bad: "#f9a8d4",
              ring_left: "#86efac",
              ring_eaten: "#f9a8d4",
              ring_goal: "#fde68a",
              ring_over: "#fb7185",
              glow1: "244,114,182",
              glow2: "192,132,252",
              glow3: "125,211,252",
              font_scale: 1.05,
              radius: 24,
            },
            sunset: {
              preset: "sunset",
              accent: "#fb923c",
              bg0: "#1a0c08",
              text: "#fff7ed",
              muted: "#fdba74",
              card: "rgba(40, 18, 12, 0.8)",
              good: "#fbbf24",
              warn: "#f97316",
              bad: "#ef4444",
              ring_left: "#fbbf24",
              ring_eaten: "#fb923c",
              ring_goal: "#fde047",
              ring_over: "#ef4444",
              glow1: "251,146,60",
              glow2: "244,63,94",
              glow3: "250,204,21",
            },
          };
          const VIBE = {
            my_little_pony: "pastel",
            mlp: "pastel",
            pony: "pastel",
            kawaii: "pastel",
            cute: "pastel",
            barbie: "pink",
            matrix: "terminal",
            hacker: "terminal",
            cyber: "neon",
            nature: "forest",
          };
          // Load current as base for partial patches
          let cur = {};
          try {
            const prof = await getProfile(session.email);
            if (prof?.prefs?.theme && typeof prof.prefs.theme === "object") {
              cur = { ...prof.prefs.theme };
            }
          } catch {
            /* */
          }

          let next = { ...cur };
          let presetName = String(
            action.preset || action.theme || action.name || action.vibe || ""
          )
            .toLowerCase()
            .replace(/\s+/g, "_");
          if (VIBE[presetName]) presetName = VIBE[presetName];
          if (PRESET_MAP[presetName]) {
            next = { ...PRESET_MAP[presetName] };
          }
          // color aliases from natural language
          const pick = (...keys) => {
            for (const k of keys) {
              if (action[k] != null) return action[k];
            }
            return null;
          };
          const accent = pick("accent", "accent_color", "primary");
          const bg0 = pick("bg0", "background", "bg", "background_color");
          const ring_left = pick("ring_left", "left_color", "left");
          const ring_eaten = pick("ring_eaten", "eaten_color", "eaten");
          const ring_goal = pick("ring_goal", "goal_color", "goal");
          const ring_over = pick("ring_over", "over_color", "over");
          if (accent) next.accent = accent;
          if (bg0) next.bg0 = bg0;
          if (ring_left) next.ring_left = ring_left;
          if (ring_eaten) next.ring_eaten = ring_eaten;
          if (ring_goal) next.ring_goal = ring_goal;
          if (ring_over) next.ring_over = ring_over;
          if (action.text && String(action.text).startsWith("#")) next.text = action.text;
          if (action.good) next.good = action.good;
          if (action.font_scale != null || action.fontScale != null || action.font_size != null) {
            next.font_scale = action.font_scale ?? action.fontScale ?? action.font_size;
          }
          if (action.radius != null) next.radius = action.radius;
          if (action.shape || action.corners) next.shape = action.shape || action.corners;
          if (action.density) next.density = action.density;
          if (action.compact === true) next.density = "compact";

          // free-text color words → hex (small map)
          const COLOR_WORDS = {
            pink: "#f472b6",
            hotpink: "#ec4899",
            blue: "#38bdf8",
            green: "#34d399",
            purple: "#a78bfa",
            yellow: "#facc15",
            red: "#f87171",
            orange: "#fb923c",
            white: "#f8fafc",
            black: "#06080f",
            neon: "#22d3ee",
            cyan: "#22d3ee",
            lime: "#a3e635",
          };
          const wordHex = (v) => {
            if (v == null) return null;
            const s = String(v).toLowerCase().trim();
            if (s.startsWith("#")) return s;
            return COLOR_WORDS[s] || null;
          };
          for (const k of [
            "accent",
            "bg0",
            "ring_left",
            "ring_eaten",
            "ring_goal",
            "ring_over",
            "text",
            "good",
          ]) {
            if (next[k]) {
              const h = wordHex(next[k]);
              if (h) next[k] = h;
            }
          }
          if (!Object.keys(next).length) {
            notes.push(
              "Try a preset: midnight, light, neon, forest, pink, terminal — or “accent pink, background black”."
            );
            continue;
          }
          if (!PRESET_MAP[presetName] && (accent || bg0 || ring_left || ring_eaten || ring_goal)) {
            next.preset = "custom";
          }
          themeOut = await saveUserTheme(session.email, next);
          notes.push(
            `Look updated${themeOut.preset ? ` (${themeOut.preset})` : ""}. Open You → Look & theme anytime.`
          );
        } catch (err) {
          notes.push(`Couldn't update theme: ${err.message}`);
        }
        continue;
      }

      if (
        type === "set_layout" ||
        type === "update_layout" ||
        type === "arrange" ||
        type === "move_panel" ||
        type === "reset_layout"
      ) {
        try {
          // Load current layout from prefs as base
          let cur = null;
          if (supabaseConfig().ok) {
            try {
              const prof = await getProfile(session.email);
              cur =
                prof?.prefs?.layout && typeof prof.prefs.layout === "object"
                  ? prof.prefs.layout
                  : null;
            } catch {
              cur = null;
            }
          }
          const PANEL_IDS = [
            "chat",
            "kcal",
            "pro",
            "fat",
            "carb",
            "net",
            "minerals",
            "summary",
            "food",
          ];
          const SIZES = new Set(["full", "half", "third"]);
          let order = Array.isArray(cur?.order)
            ? cur.order.slice()
            : PANEL_IDS.slice();
          let sizes = {
            chat: "full",
            kcal: "full",
            pro: "full",
            fat: "full",
            carb: "full",
            net: "full",
            minerals: "half",
            summary: "half",
            food: "full",
            ...(cur?.sizes || {}),
          };

          if (type === "reset_layout" || action.reset) {
            order = PANEL_IDS.slice();
            sizes = {
              chat: "full",
              kcal: "full",
              pro: "full",
              fat: "full",
              carb: "full",
              net: "full",
              minerals: "half",
              summary: "half",
              food: "full",
            };
          } else {
            if (Array.isArray(action.order) && action.order.length) {
              order = action.order.map((x) => String(x).toLowerCase());
            }
            if (action.sizes && typeof action.sizes === "object") {
              for (const [k, v] of Object.entries(action.sizes)) {
                const id = String(k).toLowerCase();
                const s = String(v).toLowerCase();
                if (PANEL_IDS.includes(id) && SIZES.has(s)) sizes[id] = s;
              }
            }
            const panel = String(
              action.panel || action.id || action.put || action.move || ""
            ).toLowerCase();
            if (action.size && PANEL_IDS.includes(panel)) {
              const s = String(action.size).toLowerCase();
              if (SIZES.has(s)) sizes[panel] = s;
            }
            // put X before/after Y
            const put = String(
              action.put || action.move || action.panel || ""
            ).toLowerCase();
            const before = action.before
              ? String(action.before).toLowerCase()
              : null;
            const after = action.after
              ? String(action.after).toLowerCase()
              : null;
            if (put && PANEL_IDS.includes(put) && (before || after)) {
              order = order.filter((x) => x !== put);
              const anchor = before || after;
              const ai = order.indexOf(anchor);
              if (ai >= 0) {
                order.splice(before ? ai : ai + 1, 0, put);
              } else {
                order.push(put);
              }
            }
            if (action.chat_bottom || action.chat === "bottom") {
              order = order.filter((x) => x !== "chat").concat(["chat"]);
            }
            if (action.chat_top || action.chat === "top") {
              order = ["chat"].concat(order.filter((x) => x !== "chat"));
            }
          }

          // ensure full set
          const seen = new Set();
          order = order.filter((id) => {
            if (!PANEL_IDS.includes(id) || seen.has(id)) return false;
            seen.add(id);
            return true;
          });
          for (const id of PANEL_IDS) {
            if (!seen.has(id)) order.push(id);
          }

          const layout = await saveUserLayout(session.email, { order, sizes });
          layoutOut = layout;
          notes.push(
            `Layout updated: ${layout.order.join(" → ")}. Use Edit layout to fine-tune.`
          );
        } catch (err) {
          notes.push(`Couldn't update layout: ${err.message}`);
        }
        continue;
      }

      if (
        type === "set_goals" ||
        type === "update_goals" ||
        type === "change_goals" ||
        type === "set_macros" ||
        type === "set_diet"
      ) {
        try {
          const patch = {
            kcal: action.kcal ?? action.calories,
            protein: action.protein,
            fat: action.fat,
            carbs: action.carbs ?? action.carbohydrates,
            net_carbs:
              action.net_carbs ??
              action.netCarbs ??
              action.net_carb ??
              action.net,
            potassium: action.potassium,
            magnesium: action.magnesium,
            eating_style: action.eating_style || action.diet || action.style,
            recompute: Boolean(action.recompute),
          };
          // style-only → recompute macros from formula
          if (
            patch.eating_style &&
            patch.kcal == null &&
            patch.protein == null &&
            patch.fat == null &&
            patch.carbs == null &&
            patch.net_carbs == null
          ) {
            patch.recompute = true;
          }
          const hasAny =
            patch.kcal != null ||
            patch.protein != null ||
            patch.fat != null ||
            patch.carbs != null ||
            patch.net_carbs != null ||
            patch.eating_style != null;
          if (!hasAny) {
            notes.push(
              "Tell me what to change — e.g. “100g carbs, 50g net carbs” or “2200 calories, 180 protein”."
            );
            continue;
          }
          const out = await updateUserGoals(session.email, patch);
          const g = out.goals || {};
          const netBit =
            g.net_carbs != null ? ` · net C ${g.net_carbs}g` : "";
          notes.push(
            `Targets updated${out.eating_style ? ` (${out.eating_style})` : ""}: ${g.kcal} kcal · P ${g.protein}g · F ${g.fat}g · C ${g.carbs}g${netBit}. Rings use these now.`
          );
          goalsOut = out.goals;
        } catch (err) {
          notes.push(`Couldn't update goals: ${err.message}`);
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
        // Prefer personal library if name matches a saved food (always new row id)
        try {
          const maybeName = String(action.food || action.match || phrase);
          const saved = await findSavedFood(session.email, maybeName);
          if (saved && !/\d+\s*(oz|g|lb|egg)/i.test(phrase)) {
            const amount = action.amount != null ? Number(action.amount) : 1;
            next.push(rowFromSavedFood(saved, amount));
            notes.push(`Added saved: ${amount === 1 ? saved.name : amount + " × " + saved.name}`);
            continue;
          }
        } catch {
          /* USDA path */
        }
        const resolved = await resolveFood(String(phrase), {
          email: session.email,
          findSavedFood,
          rowFromSavedFood,
        });
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
        const resolved = await resolveFood(phrase, {
          email: session.email,
          findSavedFood,
          rowFromSavedFood,
        });
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
        const resolved = await resolveFood(action.food_text || text, {
          email: session.email,
          findSavedFood,
          rowFromSavedFood,
        });
        if (resolved.row && rowHasMacros(resolved.row)) {
          next.push(resolved.row);
          notes.push(`Added: ${resolved.row.label}`);
        }
      }
    }

    // If nothing worked and looks like a food, try plain add
    if (!notes.length || (notes.every((n) => /couldn't|no /i.test(n)) && looksLikeFood(text))) {
      return await doAdd(text, rows, res, session.email, notes.join(" "), conversationId);
    }

    let watchStatuses = null;
    if (supabaseConfig().ok && notes.some((n) => /Watching |Logged /i.test(n))) {
      try {
        watchStatuses = (await evaluateWatches(session.email)).statuses;
      } catch {
        /* optional */
      }
    }

    if (goalsOut && supabaseConfig().ok) {
      try {
        const prof = await getProfile(session.email);
        const ob = onboardingFromPrefs(prof?.prefs);
        if (ob?.goals) goalsOut = ob.goals;
      } catch {
        /* keep */
      }
    }

    let reply = intent.reply || notes.join(" ");
    // Prefer a reply that matches the scene we actually applied
    if (sceneOut != null) {
      const ok = sceneReplyMatches(reply, sceneOut);
      if (!reply || !ok) reply = sceneReplyFor(sceneOut);
    }
    if (conversationId && reply) {
      try {
        await appendMessage(session.email, conversationId, "assistant", reply);
        // Title from first user line if still default
        if (convMeta && (!convMeta.title || convMeta.title === "Chat" || convMeta.title === "New chat")) {
          const t = text.length > 48 ? text.slice(0, 45) + "…" : text;
          await touchConversation(session.email, conversationId, { title: t });
        }
      } catch {
        /* */
      }
    }

    return sendJson(res, 200, {
      reply,
      rows: next,
      changed: JSON.stringify(next) !== JSON.stringify(rows),
      notes,
      sideEvents,
      watchStatuses,
      goals: goalsOut,
      eating_style: goalsOut?.eating_style || null,
      layout: layoutOut,
      theme: themeOut,
      boxes: boxesOut,
      suggestions: suggestionsOut,
      scene: sceneOut,
      conversation_id: conversationId,
      memory_notes: memoryOut,
    });
  } catch (e) {
    return sendJson(res, 500, {
      error: String(e.message || e),
      detail: e.detail || null,
    });
  }
}

async function doAdd(text, rows, res, email, prefix, conversationId) {
  // Direct hit on personal library by whole phrase (e.g. "log my shake")
  if (email && supabaseConfig().ok) {
    try {
      const saved = await findSavedFood(email, text);
      if (saved) {
        const next = [...rows, rowFromSavedFood(saved, 1)];
        const reply = (prefix ? prefix + " " : "") + `Added saved: ${saved.name}`;
        if (conversationId) {
          try {
            await appendMessage(email, conversationId, "assistant", reply);
          } catch {
            /* */
          }
        }
        return sendJson(res, 200, {
          reply,
          rows: next,
          changed: true,
          conversation_id: conversationId,
        });
      }
    } catch {
      /* continue */
    }
  }
  const resolved = await resolveFood(text, {
    email,
    findSavedFood,
    rowFromSavedFood,
  });
  if (resolved.error === "off_topic") {
    const reply =
      (prefix ? prefix + " " : "") +
      "I can add foods, save shakes/favorites, change amounts, remove items, or clear the day. What do you want to do?";
    if (conversationId) {
      try {
        await appendMessage(email, conversationId, "assistant", reply);
      } catch {
        /* */
      }
    }
    return sendJson(res, 200, {
      reply,
      rows,
      changed: false,
      conversation_id: conversationId,
    });
  }
  if (!resolved.row || !rowHasMacros(resolved.row)) {
    const reply =
      resolved.note ||
      "Couldn't find solid nutrition data for that — try a more specific food name.";
    if (conversationId) {
      try {
        await appendMessage(email, conversationId, "assistant", reply);
      } catch {
        /* */
      }
    }
    return sendJson(res, 200, {
      reply,
      rows,
      changed: false,
      conversation_id: conversationId,
    });
  }
  const next = [...rows, resolved.row];
  const reply = (prefix ? prefix + " " : "") + `Added: ${resolved.row.label}`;
  if (conversationId) {
    try {
      await appendMessage(email, conversationId, "assistant", reply);
    } catch {
      /* */
    }
  }
  return sendJson(res, 200, {
    reply,
    rows: next,
    changed: true,
    conversation_id: conversationId,
  });
}

const ABILITIES_REPLY = abilitiesReplyText();

function sceneReplyFor(scene) {
  if (scene === "none") return "Scene cleared.";
  const labels = {
    snow: "Let it snow — flakes are falling. ❄️",
    rain: "Rain’s on. 🌧️",
    desert: "Desert / sand dust rolling in.",
    ocean: "Ocean vibes up.",
    matrix: "Welcome to the Matrix.",
    stars: "Starfield online.",
    confetti: "Confetti time.",
    fireflies: "Fireflies out.",
    aurora: "Aurora lights up.",
    mist: "Mist rolling in.",
    neon_city: "Neon city online.",
  };
  return labels[scene] || `Scene set to ${scene}.`;
}

function sceneReplyMatches(reply, scene) {
  if (!reply) return false;
  if (scene === "none") return /clear|stop|off|none/i.test(reply);
  return (
    new RegExp(String(scene).replace(/_/g, "[ _]"), "i").test(reply) ||
    (scene === "desert" && /\b(sand|dust|mud|desert)\b/i.test(reply)) ||
    /scene|look up|ambient|effect|vibe|falling|rolling/i.test(reply)
  );
}

/**
 * Only force a scene on clear *commands* — never on "how did you make snow?"
 * or "can you do mud?" (those are questions, not apply requests).
 */
function detectSceneFromText(text) {
  const t = String(text || "").toLowerCase().trim();
  if (!t) return null;

  // Capability / how-it-works questions — never force a scene
  // "how you made snow", "can you do like mud?", "what else can you do?"
  // Still allow "can you make it snow?" (has make it / let it).
  if (
    /\b(how (did|do|you|does|it)|what else|tell me (about|how)|explain|how (it|you) (made|make|works?))\b/.test(
      t
    )
  ) {
    // unless they also issue a clear apply after ("… and make it rain")
    if (!/\b(make it|let it)\s+(snow|rain)\b|\b(do|apply|set|switch to)\s+(the\s+)?(sand|rain|snow|desert|mud)\b/.test(t)) {
      return null;
    }
  }
  if (
    /\b(can you|could you)\b/.test(t) &&
    (/\?/.test(t) || /\b(do like|do mud|do sand)\b/.test(t)) &&
    !/\b(make it|let it)\b/.test(t) &&
    !/\b(i want|please (make|set|turn)|switch to|turn on)\b/.test(t)
  ) {
    return null;
  }

  // Imperative apply patterns (must look like a request, not a mention)
  // Order matters: first match wins among alternatives in one message.
  const applyPatterns = [
    [
      /\b(make it|let it)\s+snow\b|\b(start|enable|turn on)\s+(the\s+)?snow\b|\b(do|apply|set|switch to|use)\s+(the\s+)?snow\b|\bsnow\s+scene\b|\bsnowing\b(?!\s+(on|was|is)\b)/,
      "snow",
    ],
    [
      /\b(make it|let it)\s+rain\b|\b(start|enable|turn on)\s+(the\s+)?rain\b|\b(do|apply|set|switch to|use|try)\s+(the\s+)?rain\b|\brain\s+scene\b|\braining\b/,
      "rain",
    ],
    [
      /\b(make it|do|apply|set|switch to|use|try)\s+(like\s+)?(the\s+)?(sand|desert|dust|mud|dusty)\b|\bdesert\s+(dust|scene)\b|\bsand\s+scene\b|\bmud\s+scene\b/,
      "desert",
    ],
    [
      /\b(make it|do|apply|set|switch to|use|try)\s+(the\s+)?(ocean|underwater|bubbles)\b|\bocean\s+scene\b/,
      "ocean",
    ],
    [/\b(make it|do|apply|set|switch to|use|try)\s+(the\s+)?matrix\b|\bmatrix\s+(rain|scene)\b/, "matrix"],
    [
      /\b(make it|do|apply|set|switch to|use|try)\s+(the\s+)?(stars|starry|space)\b|\bstars?\s+scene\b/,
      "stars",
    ],
    [/\b(make it|do|apply|set|switch to|use|try)\s+(the\s+)?confetti\b/, "confetti"],
    [/\b(make it|do|apply|set|switch to|use|try)\s+(the\s+)?fireflies\b/, "fireflies"],
    [
      /\b(make it|do|apply|set|switch to|use|try)\s+(the\s+)?(aurora|northern lights)\b/,
      "aurora",
    ],
    [/\b(make it|do|apply|set|switch to|use|try)\s+(the\s+)?(mist|fog)\b/, "mist"],
    [
      /\b(make it|do|apply|set|switch to|use|try)\s+(the\s+)?(neon( city)?|cyberpunk)\b/,
      "neon_city",
    ],
  ];

  // "I don't want snow — do sand or rain" → apply alternate, don't clear-only
  // Pick earliest match in the message so "sand or rain" prefers sand.
  const applied = [];
  for (const [re, id] of applyPatterns) {
    if (!SCENE_IDS.includes(id)) continue;
    const m = t.match(re);
    if (m && m.index != null) applied.push({ id, at: m.index });
  }
  applied.sort((a, b) => a.at - b.at);

  // Explicit stop/clear (no alternate apply in same message)
  const wantsClear =
    /\b(stop|clear|turn off|disable|no more|get rid of)\b.{0,24}\b(the\s+)?(scene|effect|effects|rain|snow|weather|sand|desert|matrix|particles|ambiance)\b/.test(
      t
    ) ||
    /\b(stop|clear)\s+(the\s+)?(snow|rain|effects?|scene)\b/.test(t) ||
    (/\b(don'?t want|do not want|no more)\b.{0,16}\b(snow|rain|effects?|scene)\b/.test(t) &&
      !applied.length);

  if (wantsClear && !applied.length) return "none";
  if (applied.length) {
    // Prefer non-snow if they also said they don't want snow
    if (/\b(don'?t want|do not want|no|stop|not)\b.{0,20}\bsnow\b/.test(t)) {
      const other = applied.find((x) => x.id !== "snow");
      if (other) return other.id;
    }
    return applied[0].id;
  }

  return null;
}

/** Scene-related talk that is NOT a hard apply command (answer, don't food-log). */
function isSceneChat(text) {
  const t = String(text || "").toLowerCase();
  if (!t.trim()) return false;
  if (detectSceneFromText(t)) return true;
  return /\b(scene|scenes|effect|effects|snow|rain|desert|sand|mud|matrix|stars|confetti|fireflies|aurora|mist|neon|weather|ambiance|ambient|particles|how you made|what else can you)\b/.test(
    t
  );
}

const SCENES_HELP =
  "Scenes I can put on the screen: rain, snow, desert (sand/dust/mud vibe), ocean, matrix, stars, confetti, fireflies, aurora, mist, neon city — or “stop the snow” / “clear effects”. Say e.g. “make it rain” or “desert dust”. No freeform mud physics yet — desert is the sandy one.";

function isAbilitiesQuestion(text) {
  const t = String(text || "").toLowerCase();
  if (!t.trim()) return false;
  // If they also ask to DO something (snow/rain/theme), don't trap in abilities-only path
  if (
    /\b(make it|change|set|switch|turn|apply|use)\b/.test(t) &&
    /\b(rain|snow|desert|ocean|matrix|stars|confetti|theme|color|colour|background|font|layout|box|chart)\b/.test(
      t
    )
  ) {
    return false;
  }
  if (
    /what (can|do) you (do|know)|your abilities|what are you (able|capable)|what all can i|how does this work|what can i (ask|do|change|customize)|do you (even )?know|capabilities|help me (use|customize)|what.?s possible/.test(
      t
    )
  ) {
    return true;
  }
  // Pure capability probes (no action request)
  if (
    /^(are you able|can you|could you)\b/.test(t.trim()) &&
    /(color|colour|theme|layout|size|font|square|round|customize|custom|ring|circle|box|chart|graph|snow|rain)/.test(
      t
    ) &&
    !/\b(make|change|set|please do)\b/.test(t) &&
    !/(ate|eaten|had|log|bacon|egg|oz|lb|protein shake|calories?\s+\d)/.test(t)
  ) {
    return true;
  }
  return false;
}

function isNonFoodUtterance(text) {
  const t = String(text || "").toLowerCase().trim();
  if (!t) return true;
  if (/^(hi|hello|hey|thanks|thank you|ok|okay)\b/.test(t)) return true;
  if (
    /\?/.test(t) &&
    !/(ate|eaten|had|food|log|bacon|egg|oz|lb|kcal|calorie)/.test(t)
  ) {
    return true;
  }
  if (
    /(theme|color|colour|layout|font|corner|square|round|pastel|neon|customize|custom|background|ring)/.test(
      t
    )
  ) {
    return true;
  }
  return false;
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

  const saved = Array.isArray(ctx.savedFoods) ? ctx.savedFoods : [];
  const savedBlock = saved.length
    ? `USER SAVED FOODS (personal library — use these exact names; macros already known):\n${saved
        .map(
          (f) =>
            `- "${f.name}" (${f.serving_label}): ${f.kcal} kcal, P${f.protein} F${f.fat} C${f.carbs}${
              f.ingredients ? " | " + String(f.ingredients).slice(0, 80) : ""
            }`
        )
        .join("\n")}`
    : `USER SAVED FOODS: (none yet)`;

  const theme = ctx.theme && typeof ctx.theme === "object" ? ctx.theme : null;
  const themeBlock = theme
    ? `CURRENT THEME (live UI — use for “change it back” / undo):\n${JSON.stringify({
        preset: theme.preset,
        accent: theme.accent,
        bg0: theme.bg0,
        ring_left: theme.ring_left,
        ring_eaten: theme.ring_eaten,
        ring_goal: theme.ring_goal,
        ring_over: theme.ring_over,
        font_scale: theme.font_scale,
        radius: theme.radius,
        density: theme.density,
      })}`
    : `CURRENT THEME: default midnight (eaten ring #38bdf8)`;

  const memNotes = Array.isArray(ctx.memoryNotes) ? ctx.memoryNotes : [];
  const memoryBlock = memNotes.length
    ? `PERMANENT USER NOTES (across all chats):\n${memNotes.map((n) => `- ${n}`).join("\n")}`
    : `PERMANENT USER NOTES: (none)`;

  const summaryBlock = ctx.chatSummary
    ? `EARLIER IN THIS CONVERSATION (compacted summary):\n${String(ctx.chatSummary).slice(0, 12000)}`
    : "";

  const system = `${DOMAIN_CONTRACT}

${personBlock}

${savedBlock}

${themeBlock}

${memoryBlock}

${summaryBlock}

${knowledgeForSystemPrompt()}

${capabilitiesForSystemPrompt()}

You manage:
1) TODAY's food table (add/fix/remove/clear) — server looks up real nutrition; NEVER invent macros
2) Personal SAVED FOODS library — shakes/recipes/favorites the user teaches once, then logs by name
3) DAILY TARGETS (kcal + macros + eating style) — user can change ANY day by talking: low carb, high carb, vegan, carnivore, fruit day, whatever. Use set_goals.
4) Forever cloud events — life activity becomes categories automatically
5) Watch targets — "watch my potassium, warn if under 3500mg / 7 days"
6) Product backlog — app ideas/bugs via feedback action with message + category + theme_key + theme_label. Categories: layout, charts, themes, boxes, food, goals, chat, bugs, mobile, export, other. theme_key = short snake_case cluster id (same idea → same key). NEVER say you are messaging Brice/Bryce. Say product backlog for the owner to review. NEVER auto-promise builds. NEVER private food diary.
11) ADMIN ONLY: if the logged-in user asks “what are people asking for / suggestion digest / backlog summary” → list_suggestions (owner reviews; nothing auto-builds).
12) PERMANENT NOTES — remember facts across conversations with remember/save_memory (short notes). forget/remove_memory to drop. Use for preferences like “likes black eaten rings” only when user asks to remember. Max short facts, not a diary dump.
7) Export packs — "print my stats" / "export for my doctor" / "pack for ChatGPT"
8) TODAY LAYOUT — reorder/resize boxes on the Today screen. Use set_layout. Panels: chat, kcal, pro, fat, carb, net, minerals, summary, food. Sizes: full, half, third.
9) LOOK / THEME — set_theme. Presets: midnight, light, neon, forest, pink, terminal, pastel, sunset. Vibes: mlp/my_little_pony/cute→pastel, matrix/hacker→terminal, barbie→pink. Fields: accent, bg0/background, ring_left, ring_eaten (eaten circle), ring_goal, ring_over, font_scale (0.85–1.3), radius (0–32) or shape square|round, density cozy|compact.
10) CUSTOM BOXES — (a) counters: push-ups/water goals via add_box kind counter. (b) CHARTS: any history graph via add_box kind:chart (or add_chart). Fields: measures[] (protein,kcal,fat,carbs,magnesium,potassium,sodium,fiber,steps,pushups,water_oz…), days|weeks|months|years, chart: line|bar|pie, title, color, size. Example: magnesium last 6 months line chart. remove_box deletes.

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
    {"type":"save_food","name":"HLTH Code shake","serving_label":"3 scoops","kcal":600,"protein":40,"fat":40,"carbs":19,"fiber":9,"net_carbs":10,"potassium":400,"magnesium":80,"sodium":200,"iron":2,"ingredients":"3 scoops HLTH Code, water","ingredients_list":["3 scoops HLTH Code Complete Meal","water"],"nutrients":{"iron":2,"calcium":200,"vitamin_d":10}},
    {"type":"log_saved","name":"morning shake","amount":1},
    {"type":"list_saved"},
    {"type":"delete_saved","name":"morning shake"},
    {"type":"set_goals","eating_style":"low_carb","recompute":true},
    {"type":"set_goals","kcal":2200,"protein":180,"fat":140,"carbs":100,"net_carbs":50,"eating_style":"low_carb"},
    {"type":"set_goals","carbs":100,"net_carbs":50},
    {"type":"set_layout","put":"chat","after":"food"},
    {"type":"set_layout","chat":"bottom"},
    {"type":"set_layout","order":["chat","kcal","pro","fat","carb","net","food","minerals","summary"],"sizes":{"minerals":"half","summary":"half","pro":"half","fat":"half"}},
    {"type":"set_layout","panel":"kcal","size":"half"},
    {"type":"reset_layout"},
    {"type":"set_theme","preset":"neon"},
    {"type":"set_theme","preset":"pink"},
    {"type":"set_theme","preset":"pastel"},
    {"type":"set_theme","vibe":"my_little_pony"},
    {"type":"set_theme","accent":"#f472b6","bg0":"#1a0a14","ring_eaten":"#f472b6"},
    {"type":"set_theme","ring_eaten":"#f472b6","ring_left":"#34d399","ring_goal":"#facc15"},
    {"type":"set_theme","font_scale":1.15},
    {"type":"set_theme","shape":"square","radius":6},
    {"type":"set_theme","shape":"round","radius":24},
    {"type":"set_theme","density":"compact"},
    {"type":"reset_theme"},
    {"type":"add_box","title":"Push-ups","measure_id":"pushups","goal":100,"unit":"reps","icon":"💪","color":"#a78bfa","size":"half"},
    {"type":"add_box","title":"Water","measure_id":"water_oz","goal":100,"unit":"oz","icon":"💧","color":"#38bdf8","size":"half"},
    {"type":"add_chart","kind":"chart","title":"Magnesium 6 mo","measures":["magnesium"],"months":6,"chart":"line","size":"full","icon":"📈"},
    {"type":"add_chart","kind":"chart","title":"Macros 30d","measures":["protein","fat","carbs"],"days":30,"chart":"line","size":"full"},
    {"type":"add_chart","kind":"chart","title":"Protein pie 7d","measures":["protein","fat","carbs"],"days":7,"chart":"pie","size":"half"},
    {"type":"remove_box","name":"pushups"},
    {"type":"log_exercise","title":"Incline push-ups","category_id":"pushups","sets":3,"reps":20},
    {"type":"log_activity","title":"Mountain bike 45 min","category_id":"cycling","category_kind":"exercise","duration_min":45},
    {"type":"log_steps","steps":30000},
    {"type":"log_metric","measure_id":"weight_lb","label":"Body weight","value":210,"unit":"lb"},
    {"type":"set_watch","measure_id":"potassium","label":"Potassium","mode":"floor","target_min":3500,"unit":"mg","window_days":7,"severity":"yellow"},
    {"type":"export_report","days":30},
    {"type":"feedback","message":"Show total carbs and net carbs in the daily view","category":"food","theme_key":"net_carbs_display","theme_label":"Show net carbs in daily view"},
    {"type":"list_suggestions"},
    {"type":"remember","note":"Prefers black eaten rings"},
    {"type":"forget","match":"black eaten"},
    {"type":"set_scene","scene":"rain"},
    {"type":"set_scene","scene":"desert"},
    {"type":"set_scene","scene":"matrix"},
    {"type":"set_scene","scene":"none"}
  ]
}

Rules:
- You HAVE conversation history in prior messages. “Change it back” / undo → use CURRENT THEME + recent turns. Default eaten ring is #38bdf8 if they want original blue.
- “Remember that I like X” → remember action. Do not remember medical diagnoses.
- Ambient vibes: “make it rain”, “desert”, “snow”, “matrix”, “stars”, “clear the effects” → set_scene with scene id from CAPABILITIES list. Optionally also set_theme to match.
- "save my shake / remember this food / store this recipe" → save_food. User MUST supply numbers — NEVER invent macros/micros. When they give a FULL label/breakdown, store ALL of it: kcal, macros, fiber, sugars, net_carbs, potassium, magnesium, sodium, iron, calcium, vitamins, and ingredients_list. Put extra vitamins/minerals in nutrients:{}. One saved food can hold many ingredients + many micros (not one number only).
- "I had my morning shake" / "log the HLTH shake" when name matches SAVED FOODS → log_saved (not USDA guess)
- "list my saved foods" → list_saved
- "delete saved X" → delete_saved
- Diet/goal changes ANY time: "I'm low carb today", "set carbs to 40", "2000 calories", "high protein day", "vegan this week", "carnivore", "fruit day" → set_goals. Map styles to: low_carb, keto, carnivore, higher_protein, plant_forward, vegan, flexible, no_pref, or short free text. If they only change style, set recompute:true so macros rebalance near their calorie target. If they give exact numbers, use those (don't invent). NEVER invent macros for food logging.
- TOTAL CARBS vs NET CARBS are SEPARATE goals. "100g carbs and 50g net carbs" → set_goals with carbs:100 AND net_carbs:50. Do NOT say this is impossible. Both fields exist; the UI has separate Carbs and Net carbs rings.
- Layout moves: "put chat at the bottom", "chat below food", "make protein half width", "put macros side by side", "reset layout" → set_layout (or reset_layout). Prefer put/before/after or chat:top|bottom for simple moves; full order+sizes when rearranging many boxes. Panel ids only: chat,kcal,pro,fat,carb,net,minerals,summary,food.
- Look/theme: "make it neon", "pastel / My Little Pony vibe", "eaten rings pink", "make circles/goal yellow", "bigger text", "smaller text", "square corners", "round corners", "compact mode", "light mode", "reset theme" → set_theme (include ring_eaten/ring_left/ring_goal, font_scale, radius or shape).
- "What can you do / abilities / what are you able to change" → empty actions + reply listing food logging, goals, layout, theme/colors/font/corners, custom boxes, charts, export. NEVER try to add food for capability questions.
- Custom counters: "add a push-up box with goal 100", "track water 100oz" → add_box kind counter.
- Charts/graphs: "show magnesium last 6 months", "graph protein 3 weeks", "pie of macros this week", "bar chart calories 90 days" → add_chart / add_box kind:chart with measures + days/weeks/months + chart line|bar|pie. Always create a box they can keep/move — don't only describe data in text if they asked for a graph.
- remove_box to delete any custom box.
- Ambiguous food ("sushi") → empty actions + reply asking what kind before add
- Stress/argument → log_activity with category_id stress, title factual (no counseling)
- Export/print/stats for doctor or other AI → export_report with days (7/30/90)
- Watch magnesium/potassium → set_watch
- "30000 steps" → log_steps
- App ideas / “I wish the app had X” → feedback with message + category + theme_key + theme_label. Same idea from many people should reuse the same theme_key. Phrase as backlog for owner review — NEVER “send to Brice/Bryce”. Do NOT promise it will be built.
- Admin “what are people asking for?” → list_suggestions only for admin; summarize themes/counts; do not implement features from that list unless owner decides.
- Never invent nutrition numbers
- Totals questions → empty actions + answer from log
- Off-topic → empty actions + friendly redirect (DOMAIN CONTRACT)
- You are BigBricey (the product). The logged-in user’s name is for addressing them only — never treat them as a third-party product owner.`;

  const history = Array.isArray(ctx.history) ? ctx.history : [];
  const prior = [];
  for (const m of history) {
    const role = m.role === "assistant" || m.role === "bot" ? "assistant" : "user";
    const content = String(m.content || "").trim();
    if (!content) continue;
    prior.push({ role, content: content.slice(0, 8000) });
  }
  // Cap prior messages for safety while still using a large window
  const priorCapped = prior.length > 100 ? prior.slice(-100) : prior;

  try {
    const out = await llmChat({
      temperature: 0,
      title: "BigBricey-Chat",
      messages: [
        { role: "system", content: system },
        ...priorCapped,
        { role: "user", content: text },
      ],
    });
    // Meter tokens per user (fire-and-forget)
    if (ctx.email && out?.usage) {
      logLlmUsage(ctx.email, out.usage, {
        model: out.model,
        provider: out.provider,
        conversation_id: ctx.conversationId || null,
        purpose: "chat",
      }).catch(() => {});
    } else if (ctx.email && out && !out.usage) {
      // Still record a hit if provider omitted usage
      logLlmUsage(
        ctx.email,
        { prompt_tokens: 0, completion_tokens: 0, total_tokens: 1 },
        { model: out.model, provider: out.provider, purpose: "chat_no_usage" }
      ).catch(() => {});
    }
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
