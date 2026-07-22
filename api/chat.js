import { randomUUID } from "node:crypto";

import {
  resolveFood,
  resolveNutritionLookup,
  sendJson,
  readBody,
  toConvertibleGrams,
  round,
} from "./_lib.js";
import { getAuthSecret, requireUser } from "./_auth.js";
import {
  dayKeyFor,
  loadFoodDay,
  loadFoodDaySnapshot,
  syncFoodDay,
  logEvent,
  supabaseConfig,
  upsertWatchTarget,
  evaluateWatches,
  sbRpc,
  getProfile,
  mergeProfilePrefs,
  saveCompanionSettings,
  onboardingFromPrefs,
  ensureProfile,
  listSavedFoods,
  findSavedFood,
  findSavedFoodById,
  upsertSavedFood,
  deleteSavedFood,
  deleteSavedFoodById,
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
  deleteProfileMemory,
  removeMemoryNote,
  reserveAdditionalLlmTokens,
  reserveLlmTurn,
  logLlmUsage,
  latestDailyMeasureSeries,
  measureUsesLatestDailyValue,
  listFoodCorrections,
  recordFoodCorrection,
  sb,
} from "./_supabase.js";
import { usualPortionCorrectionFromUpdate } from "./_food_corrections.js";
import {
  inferCommunicationStyle,
  normalizeCompanionSettings,
} from "./_companion_settings.js";
import { submitFeedback, summarizeFeedback, isAdmin } from "./_members.js";
import { llmConfig, usageForMetering } from "./_llm.js";
import {
  abilitiesReplyText,
  SCENE_IDS,
} from "./_capabilities.js";
import { buildStatsReport } from "./_report.js";
import { formatPersonBlock } from "./_coach_context.js";
import {
  buildCurrentLogContext,
  composeActionReply,
  prepareModelHistory,
  recordedDayReply,
} from "./_chat_wrapper.js";
import { buildBuddySystemPrompt } from "./_buddy_prompt.js";
import {
  appInspectionReply,
  buildAppInspection,
  trackerRemovalConfirmationPrompt,
} from "./_app_knowledge.js";
import {
  callBuddyAfterTools,
  callBuddyFirstPass,
  minimalFoodQuantityReply,
} from "./_buddy_turn.js";
import {
  authorizeBuddyContinuationPlan,
  classifyBuddyTurn,
  requiredAppInspection,
  requiredTodayLedgerRead,
  toolsForBuddyTurn,
} from "./_buddy_tool_routing.js";
import {
  BIGBRICEY_TOOLS,
  buildNativeToolResultMessage,
  buildToolResultEnvelope,
  validateNativeToolCall,
} from "./_tool_contracts.js";
import {
  actionFromValidatedToolCall,
  assistantMessageForValidatedCalls,
  classifyNativeToolExecution,
  continuationPlanForNativeReads,
  invalidNativeToolExecution,
  selectNativeContinuation,
  selectVerifiedNativeToolReply,
  unresolvedContinuationReply,
} from "./_native_tool_loop.js";
import {
  isKnownReadOnlyToolName,
  repairInvalidReadTurn,
  shouldRepairInvalidReadCalls,
} from "./_read_tool_repair.js";
import { executeSavedFoodContinuation } from "./_saved_food_continuation.js";
import { removeDashboardTrackers } from "./_tracker_mutation.js";
import {
  createToolConfirmationToken,
  verifyToolConfirmationToken,
} from "./_tool_confirmation.js";

/**
 * Conversational control of the food log.
 * User can add, fix amounts, remove, clear, ask about totals — not only "6 eggs".
 */
export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.setHeader("Allow", "GET, POST, OPTIONS");
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
    } catch {
      return sendJson(res, 500, { error: "conversation_request_failed" });
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
      } catch {
        return sendJson(res, 500, {
          error: "conversation_create_failed",
          hint: "Run migration_007_chat_history.sql in Supabase if tables missing.",
        });
      }
    }

    const requestedDay = normalizeRequestedDay(body?.date || dayKeyFor());
    if (!requestedDay) {
      return sendJson(res, 400, { error: "valid date required" });
    }
    const requestId = normalizeClientRequestId(body?.request_id) || randomUUID();
    if (Array.isArray(body?.rows) && body.rows.length > 500) {
      return sendJson(res, 413, { error: "too many food rows" });
    }
    let rows = Array.isArray(body?.rows) ? body.rows : [];
    let foodDayRevision = null;
    let authoritativeRowsLoaded = false;
    if (supabaseConfig().ok) {
      try {
        const snapshot = await loadFoodDaySnapshot(session.email, requestedDay);
        rows = snapshot.rows;
        foodDayRevision = snapshot.revision;
        authoritativeRowsLoaded = true;
      } catch {
        // The authenticated client's current rows are an availability fallback;
        // every mutation is still validated and synced under this account.
      }
    }

    let confirmedNativeCall = null;
    const isConfirmation = body?.op === "confirm_tool";
    if (isConfirmation) {
      try {
        const rawCall = verifyToolConfirmationToken(body?.confirmation_token, {
          email: session.email,
          secret: getAuthSecret(),
        });
        confirmedNativeCall = validateNativeToolCall(rawCall, {
          confirmedToolCallIds: [rawCall.id],
        });
        if (!confirmedNativeCall?.ok || confirmedNativeCall.status !== "ready") {
          return sendJson(res, 400, { error: "invalid_confirmation" });
        }
      } catch (error) {
        return sendJson(res, 400, {
          error: error?.code || "invalid_confirmation",
          message: "That confirmation is invalid or expired. Ask me to do it again.",
        });
      }
    }

    const text = isConfirmation
      ? String(body?.text || "Yes, confirm that change.").trim()
      : String(body?.text || "").trim();
    if (!text) return sendJson(res, 400, { error: "text required" });
    if (text.length > 8_000) {
      return sendJson(res, 413, { error: "message too long" });
    }

    let personCtx = null;
    let themeSnap = null;
    let layoutSnap = null;
    let boxesSnap = [];
    let sceneSnap = null;
    let scenesSeenSnap = [];
    let memoryNotes = [];
    let foodCorrectionHints = [];
    let assistantSettingsSnap = normalizeCompanionSettings();
    let profileSnapshotLoaded = false;
    if (supabaseConfig().ok) {
      try {
        await ensureProfile(session.email);
        const profile = await getProfile(session.email);
        profileSnapshotLoaded = true;
        personCtx = onboardingFromPrefs(profile?.prefs);
        if (profile?.prefs?.theme && typeof profile.prefs.theme === "object") {
          themeSnap = profile.prefs.theme;
        }
        if (profile?.prefs?.layout && typeof profile.prefs.layout === "object") {
          layoutSnap = profile.prefs.layout;
        }
        if (Array.isArray(profile?.prefs?.boxes)) {
          boxesSnap = profile.prefs.boxes.slice(0, 20);
        }
        sceneSnap = profile?.prefs?.scene || null;
        if (Array.isArray(profile?.prefs?.scenes_seen)) {
          scenesSeenSnap = profile.prefs.scenes_seen;
        }
        assistantSettingsSnap = normalizeCompanionSettings(
          profile?.prefs?.assistant_settings
        );
        memoryNotes = await getMemoryNotes(session.email);
        foodCorrectionHints = await listFoodCorrections(session.email, {
          limit: 12,
        });
      } catch {
        personCtx = null;
      }
    }

    // Conversation + history
    let conversationId = body.conversation_id || body.conversationId || null;
    let historyMessages = [];
    let chatSummary = null;
    let convMeta = null;
    let currentUserMessageId = null;
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
          const userMessageRow = await appendMessage(
            session.email,
            conversationId,
            "user",
            text
          );
          currentUserMessageId = userMessageRow?.id || null;
          const ctx = await buildChatContextForModel(session.email, conversationId, {
            maxMessages: 24,
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

    if (body?.op === "cancel_tool") {
      const reply = "Okay — I didn't change anything.";
      if (conversationId) {
        try {
          await appendMessage(session.email, conversationId, "assistant", reply);
        } catch {
          /* best effort */
        }
      }
      return sendJson(res, 200, {
        reply,
        rows,
        changed: false,
        ledger_committed: false,
        conversation_id: conversationId,
        day_revision: foodDayRevision,
      });
    }

    // Put a hard per-user reservation in front of any paid model work. This is
    // intentionally before both the first pass and confirmed tool voice pass.
    if (llmConfig().ok) {
      try {
        await reserveLlmTurn(session.email);
      } catch (error) {
        const reply =
          error?.status === 429
            ? error.message
            : "AI chat is temporarily unavailable. Try again in a moment.";
        if (conversationId) {
          try {
            await appendMessage(session.email, conversationId, "assistant", reply);
          } catch {
            /* best effort */
          }
        }
        return sendJson(res, 200, {
          reply,
          rows,
          changed: false,
          conversation_id: conversationId,
          error: error?.code || "chat_quota_unavailable",
          day_revision: foodDayRevision,
        });
      }
    }

    // Let the LLM talk. Code only *executes* validated actions after.
    let intent = await interpretIntent(text, rows, {
      email: session.email,
      name: session.name,
      person: personCtx,
      history: historyMessages,
      chatSummary,
      theme: themeSnap,
      scene: sceneSnap,
      scenesSeen: scenesSeenSnap,
      memoryNotes,
      conversationId,
      currentDate: requestedDay,
      confirmedNativeCall,
      layout: layoutSnap,
      trackers: boxesSnap,
      companionSettings: assistantSettingsSnap,
      foodCorrections: foodCorrectionHints,
    });

    if (intent?.error === "model_failed") {
      // Prefer raw model text if we have it (never hide the brain)
      if (intent.raw && String(intent.raw).trim()) {
        const reply = String(intent.raw).trim();
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
      // Clear scene apply if model totally failed
      const applyOnly = resolveSceneIntent(text);
      if (applyOnly.scene) {
        try {
          await persistUserScene(session.email, applyOnly.scene);
        } catch {
          /* */
        }
        const reply = sceneReplyFor(applyOnly.scene);
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
          actions: [{ type: "set_scene", scene: applyOnly.scene }],
          scene: applyOnly.scene,
          conversation_id: conversationId,
        });
      }
      if (isAbilitiesQuestion(text)) {
        return sendJson(res, 200, {
          reply: ABILITIES_REPLY,
          rows,
          changed: false,
          conversation_id: conversationId,
        });
      }
      // Real outage only
      const reply =
        "I hit a glitch talking to the model. Try that again in a sec.";
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

    const actions = Array.isArray(intent?.actions)
      ? intent.actions.map((action, index) => ({
          ...action,
          __request_id: `chat:${requestId}:${action.__tool_call_id || index}`.slice(
            0,
            200
          ),
        }))
      : [];
    const nativeEvaluations = Array.isArray(intent?.nativeTurn?.evaluations)
      ? intent.nativeTurn.evaluations
      : [];

    let goalsOut = null;
    let layoutOut = null;
    let themeOut = null;
    let boxesOut = null;
    let suggestionsOut = null;
    let companionSettingsOut = null;
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
        } catch {
          return sendJson(res, 200, {
            reply: "I couldn't build that report right now.",
            rows,
            changed: false,
          });
        }
      }
    }

    // Empty actions — show whatever the model said. Never canned-menu overwrite.
    if (!actions.length && !nativeEvaluations.length) {
      const modelReply = intent?.reply && String(intent.reply).trim();
      if (modelReply) {
        if (conversationId) {
          try {
            await appendMessage(session.email, conversationId, "assistant", modelReply);
          } catch {
            /* */
          }
        }
        return sendJson(res, 200, {
          reply: modelReply,
          rows,
          changed: false,
          conversation_id: conversationId,
        });
      }
      // No reply + no actions: only food-add if it actually looks like food
      if (
        !isPresenceOrSmallTalk(text) &&
        !isSceneChat(text) &&
        !isNonFoodUtterance(text)
      ) {
        return await doAdd(
          text,
          rows,
          res,
          session.email,
          null,
          conversationId,
          requestedDay,
          requestId,
          authoritativeRowsLoaded,
          foodDayRevision
        );
      }
      const reply = isPresenceOrSmallTalk(text)
        ? presenceReply()
        : "I'm here — say that again?";
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

    let next = rows.map((r) => ({ ...r }));
    const notes = [];
    const sideEvents = [];
    let memoryOut = null;
    const executionByCall = new Map();
    const pendingFoodCorrections = [];
    let ledgerCommitted = false;
    let ledgerReloaded = false;

    for (const action of actions) {
      const type = (action.type || action.action || "").toLowerCase();
      const noteStart = notes.length;
      const beforeRows = JSON.stringify(next);
      const beforeSideEvents = sideEvents.length;
      let toolData = null;
      let actionChanged = false;
      try {

      if (
        action.__tool_name &&
        ["add_food", "update_food", "remove_food", "clear_food_day", "log_saved_food"].includes(
          action.__tool_name
        ) &&
        !authoritativeRowsLoaded
      ) {
        notes.push("Couldn't change food because the authoritative ledger is temporarily unavailable. Nothing changed.");
        continue;
      }

      if (type === "inspect_app") {
        if (!profileSnapshotLoaded) {
          notes.push(
            "Couldn't inspect the current app interface because the private profile state is temporarily unavailable."
          );
          continue;
        }
        try {
          toolData = await buildAppInspection({
            currentDate: requestedDay,
            focus: action.focus,
            scene: sceneOut ?? sceneSnap ?? "none",
            theme: themeOut ?? themeSnap ?? null,
            layout: layoutOut ?? layoutSnap ?? null,
            trackers: boxesOut ?? boxesSnap,
            loadMeasureSeries: (measureId, from, to) =>
              loadMeasureSeriesForAppInspection(
                session.email,
                measureId,
                from,
                to
              ),
          });
          notes.push("Inspected the current BigBricey interface and dashboard.");
        } catch {
          notes.push("Couldn't inspect the current app interface right now.");
        }
        continue;
      }

      if (type === "read_today") {
        const day = normalizeRequestedDay(action.day || requestedDay) || requestedDay;
        const include = Array.isArray(action.include) && action.include.length
          ? action.include
          : ["food", "totals", "workouts", "metrics", "home"];
        const readFailures = new Set();
        let readRows = day === requestedDay ? next : [];
        if (
          day === requestedDay &&
          (include.includes("food") || include.includes("totals")) &&
          !authoritativeRowsLoaded
        ) {
          if (include.includes("food")) readFailures.add("food");
          if (include.includes("totals")) readFailures.add("totals");
        } else if (
          day !== requestedDay &&
          (include.includes("food") || include.includes("totals"))
        ) {
          try {
            readRows = await loadFoodDay(session.email, day);
          } catch {
            if (include.includes("food")) readFailures.add("food");
            if (include.includes("totals")) readFailures.add("totals");
          }
        }
        const data = { day };
        if (
          (include.includes("food") && !readFailures.has("food")) ||
          (include.includes("totals") && !readFailures.has("totals"))
        ) {
          const log =
            day === requestedDay
              ? buildCurrentLogContext(next)
              : buildCurrentLogContext(readRows);
          const boundedLog = boundedLedgerToolRead(log);
          if (include.includes("food") && !readFailures.has("food")) {
            data.food = boundedLog.items;
            data.food_omitted_count = boundedLog.omitted_count;
          }
          if (include.includes("totals") && !readFailures.has("totals")) {
            data.totals = boundedLog.totals;
            data.known_subtotals = boundedLog.known_subtotals;
            data.coverage = boundedLog.coverage;
            data.data_quality = boundedLog.data_quality;
            if (boundedLog.extra_nutrient_totals) {
              data.extra_nutrient_totals = boundedLog.extra_nutrient_totals;
              data.extra_nutrient_known_subtotals =
                boundedLog.extra_nutrient_known_subtotals;
              data.extra_nutrient_coverage = boundedLog.extra_nutrient_coverage;
            }
          }
        }
        if (include.includes("workouts") || include.includes("metrics")) {
          try {
            if (!supabaseConfig().ok) throw new Error("ledger_unavailable");
            const events = await sb("events", {
              query: {
                select: "category_id,title,payload,occurred_at,source",
                user_email: `eq.${String(session.email).toLowerCase()}`,
                day_key: `eq.${day}`,
                category_id: "neq.food",
                deleted_at: "is.null",
                order: "occurred_at.desc",
                limit: "101",
              },
            });
            const nonFood = (events || [])
              .filter((event) => event.category_id !== "food")
              .map(projectPrivateReadEvent);
            if (include.includes("workouts")) {
              const workouts = nonFood.filter((event) =>
                /exercise|workout|strength|cardio|run|walk|bike|sport/i.test(
                  String(event.category_id || "")
                )
              );
              data.workouts = workouts.slice(0, 40).reverse();
              data.workouts_omitted_count = Math.max(0, workouts.length - 40);
            }
            if (include.includes("metrics")) {
              const metrics = nonFood.filter((event) =>
                !/exercise|workout|strength|cardio|run|walk|bike|sport/i.test(
                  String(event.category_id || "")
                )
              );
              data.metrics = metrics.slice(0, 40).reverse();
              data.metrics_omitted_count = Math.max(0, metrics.length - 40);
            }
          } catch {
            if (include.includes("workouts")) readFailures.add("workouts");
            if (include.includes("metrics")) readFailures.add("metrics");
          }
        }
        if (include.includes("home")) {
          if (!profileSnapshotLoaded) {
            readFailures.add("home");
          } else {
            data.home = {
              scene: sceneOut ?? sceneSnap ?? "none",
              theme: themeOut ?? themeSnap ?? null,
              layout: layoutOut ?? layoutSnap ?? null,
              trackers: boxesOut ?? boxesSnap,
            };
          }
        }
        if (readFailures.size) {
          toolData = { day, unavailable: Array.from(readFailures) };
          notes.push(
            `Couldn't read the requested private app data (${Array.from(readFailures).join(", ")}).`
          );
          continue;
        }
        toolData = data;
        notes.push(`Read the recorded ledger for ${day}.`);
        continue;
      }

      if (type === "lookup_food") {
        const lookup = await resolveNutritionLookup({
          query: action.query,
          amount: action.amount,
          unit: action.unit,
          size: action.size,
        });
        toolData = lookup;
        if (!lookup?.nutrition) {
          notes.push(
            lookup?.note || "No credible nutrition database match was found."
          );
          continue;
        }
        notes.push(
          `Looked up verified nutrition for ${lookup.match?.description || action.query}. Nothing was logged.`
        );
        continue;
      }

      if (
        type === "remember" ||
        type === "save_memory" ||
        type === "memory_note" ||
        type === "add_memory"
      ) {
        const note = action.note || action.message || action.text || action.fact;
        try {
          const memoryResult = await addMemoryNote(session.email, note, {
            kind: action.kind || "fact",
            provenance: "user_chat",
            sourceConversationId: conversationId,
            sourceMessageId: currentUserMessageId,
          });
          memoryOut = memoryResult.notes;
          actionChanged = memoryResult.changed === true;
          toolData = { changed: actionChanged };
          notes.push(
            actionChanged
              ? `Saved permanent note: “${String(note).slice(0, 80)}”.`
              : "That permanent note was already saved."
          );
        } catch {
          notes.push("Couldn't save that memory note right now.");
        }
        continue;
      }

      if (type === "forget" || type === "remove_memory" || type === "delete_memory") {
        const match = action.note || action.match || action.message || action.text;
        try {
          let memoryResult;
          if (action.memory_id) {
            const deletion = await deleteProfileMemory(
              session.email,
              action.memory_id
            );
            memoryResult = {
              ...deletion,
              removed_count: deletion.deleted ? 1 : 0,
              changed: deletion.deleted,
              notes: await getMemoryNotes(session.email),
            };
          } else {
            memoryResult = await removeMemoryNote(session.email, match);
          }
          memoryOut = memoryResult.notes;
          actionChanged = memoryResult.removed_count > 0;
          toolData = {
            removed_count: memoryResult.removed_count,
            changed: actionChanged,
            ambiguous: memoryResult.ambiguous === true,
          };
          notes.push(
            actionChanged
              ? `Removed ${memoryResult.removed_count} matching permanent note${memoryResult.removed_count === 1 ? "" : "s"}.`
              : memoryResult.ambiguous
                ? "More than one permanent memory matched. Nothing was removed; ask which one to forget."
              : "No permanent memory note matched that request."
          );
        } catch {
          notes.push("Couldn't remove that memory note right now.");
        }
        continue;
      }

      if (type === "feedback" || type === "suggestion" || type === "product_feedback") {
        const msg = action.message || action.text || text;
        try {
          const saved = await submitFeedback(session.email, msg, {
            name: assistantSettingsSnap.nickname || null,
            source: "chat",
            category: action.category || action.cat,
            theme_key: action.theme_key || action.theme || action.themeKey,
            theme_label: action.theme_label || action.themeLabel || action.title,
            consent: true,
            feedbackKind: "idea",
          });
          notes.push(
            "Noted on the BigBricey product backlog for the owner to review (app idea only — not your food diary). Nothing ships until Brice decides."
          );
          if (saved?.theme_key) {
            /* quiet */
          }
        } catch {
          notes.push("Couldn't save that product note right now.");
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
        } catch {
          notes.push("Couldn't load suggestions right now.");
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
        } catch {
          notes.push("Couldn't set that goal watch right now.");
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
              dayKey: normalizeRequestedDay(action.day) || requestedDay,
              payload: action,
              measures,
              clientId: action.__request_id,
              source: "chat",
            });
            sideEvents.push(r);
            toolData = { event: r, title, category_id: categoryId };
            notes.push(`Logged: ${title} (${categoryId})`);
          } catch {
            notes.push("The workout could not be safely saved, so nothing changed.");
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
              dayKey: normalizeRequestedDay(action.day) || requestedDay,
              payload: { steps },
              measures: [{ measure_id: "steps", value: steps, unit: "steps" }],
              clientId: `steps:${normalizeRequestedDay(action.day) || requestedDay}`,
              source: "chat",
            });
            toolData = {
              day: normalizeRequestedDay(action.day) || requestedDay,
              steps: Math.round(steps),
            };
            notes.push(`Logged ${Math.round(steps).toLocaleString()} steps.`);
          } catch {
            notes.push("The step count could not be safely saved, so nothing changed.");
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
              dayKey: normalizeRequestedDay(action.day) || requestedDay,
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
              clientId: action.__request_id,
              source: "chat",
            });
            toolData = {
              day: normalizeRequestedDay(action.day) || requestedDay,
              measure_id: mid,
              value,
              unit: action.unit || "",
            };
            notes.push(`Logged ${action.label || mid}: ${value}`);
          } catch {
            notes.push("That metric could not be safely saved, so nothing changed.");
          }
        } else {
          notes.push(
            "The metric could not be safely saved because the cloud ledger is unavailable. Nothing changed."
          );
        }
        continue;
      }

      if (type === "save_food_native") {
        try {
          let sourceRows = [];
          if (Array.isArray(action.source_entry_ids)) {
            sourceRows = action.source_entry_ids
              .map((id) => next.find((row) => String(row.id) === String(id)))
              .filter(Boolean);
            if (sourceRows.length !== action.source_entry_ids.length) {
              notes.push("Couldn't save that food because one or more source entries were not found.");
              continue;
            }
          } else if (action.food_query) {
            const resolved = await resolveFood(action.food_query, {
              email: session.email,
              findSavedFood,
              rowFromSavedFood,
              foodCorrections: foodCorrectionHints,
            });
            if (!resolved.row || !rowHasMacros(resolved.row)) {
              notes.push(
                resolved.note ||
                  "Couldn't save that food because no complete verified nutrition match was found."
              );
              continue;
            }
            sourceRows = [resolved.row];
          }
          if (!sourceRows.length) {
            notes.push("Couldn't save that food because it had no verified source.");
            continue;
          }
          const aggregate = buildCurrentLogContext(sourceRows);
          const totals = aggregate.totals;
          if (
            totals.kcal == null ||
            totals.protein == null ||
            totals.fat == null ||
            totals.carbs == null
          ) {
            notes.push("Couldn't save that food because its recorded macros are incomplete.");
            continue;
          }
          const nutrients = {
            ...(aggregate.extra_nutrient_totals || {}),
          };
          const saved = await upsertSavedFood(session.email, {
            name: action.name,
            description: action.description || null,
            serving_label: action.serving_label || "1 serving",
            ingredients: sourceRows.map((row) => row.label).join("; "),
            kcal: totals.kcal,
            protein: totals.protein,
            fat: totals.fat,
            carbs: totals.carbs,
            fiber: totals.fiber,
            sugars: totals.sugars,
            potassium: totals.potassium,
            magnesium: totals.magnesium,
            sodium: totals.sodium,
            net_carbs: totals.net_carbs,
            nutrients,
          });
          toolData = {
            saved_food: {
              id: saved.id,
              name: saved.name,
              serving_label: saved.serving_label,
              kcal: saved.kcal,
              protein: saved.protein,
              fat: saved.fat,
              carbs: saved.carbs,
            },
          };
          notes.push(`Saved “${saved.name}” from verified recorded nutrition.`);
        } catch {
          notes.push("Couldn't save that food to your library right now.");
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
        } catch {
          notes.push("Couldn't save that food to your library right now.");
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
        const savedFoodId = action.saved_food_id || action.id;
        const amount = action.amount != null ? Number(action.amount) : 1;
        if (!name && !savedFoodId) {
          notes.push("Which saved food? (e.g. “log morning shake”)");
          continue;
        }
        try {
          const saved = savedFoodId
            ? await findSavedFoodById(session.email, savedFoodId)
            : await findSavedFood(session.email, name);
          if (!saved) {
            notes.push(
              name
                ? `No saved food named “${name}”. Save it first or ask to list saved foods.`
                : "No saved food matched that id."
            );
            continue;
          }
          const savedRow = rowFromSavedFood(saved, amount);
          if (action.__request_id) savedRow.id = action.__request_id;
          next = next.filter((row) => String(row.id) !== String(savedRow.id));
          next.push(savedRow);
          toolData = {
            saved_food: { id: saved.id, name: saved.name },
            servings: amount,
          };
          notes.push(`Added saved: ${amount === 1 ? saved.name : amount + " × " + saved.name}`);
        } catch {
          notes.push("Couldn't load that saved food right now.");
        }
        continue;
      }

      if (type === "list_saved" || type === "list_saved_foods") {
        try {
          let list = await listSavedFoods(session.email);
          const query = String(action.query || "").trim().toLowerCase();
          if (query) {
            list = list.filter((food) =>
              String(food.name || "").toLowerCase().includes(query)
            );
          }
          const requestedLimit = Math.min(
            50,
            Math.max(1, Math.round(Number(action.limit) || 20))
          );
          const totalMatches = list.length;
          list = list.slice(0, requestedLimit);
          toolData = {
            saved_foods: list.map((food) => ({
              id: food.id,
              name: food.name,
              serving_label: food.serving_label,
              kcal: food.kcal,
              protein: food.protein,
              fat: food.fat,
              carbs: food.carbs,
            })),
            omitted_count: Math.max(0, totalMatches - list.length),
          };
          if (!list.length) {
            notes.push("No saved foods matched. Ask me to save one from a recorded entry or a specific verified food lookup.");
          } else {
            const lines = list.map(
              (f) =>
                `• ${f.name} (${f.serving_label}): ${f.kcal} kcal, ${f.protein}P/${f.fat}F/${f.carbs}C`
            );
            notes.push(`Your saved foods (${list.length}):\n${lines.join("\n")}`);
          }
        } catch {
          notes.push("Couldn't list saved foods right now.");
        }
        continue;
      }

      if (type === "delete_saved_native") {
        try {
          const gone = action.saved_food_id
            ? await deleteSavedFoodById(session.email, action.saved_food_id)
            : await deleteSavedFood(session.email, action.name);
          if (!gone) {
            notes.push("No saved food matched that request.");
            continue;
          }
          toolData = { deleted_saved_food: { id: gone.id, name: gone.name } };
          notes.push(`Deleted saved food “${gone.name}”.`);
        } catch {
          notes.push("Couldn't delete that saved food right now.");
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
        } catch {
          notes.push("Couldn't delete that saved item right now.");
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
            const removal = removeDashboardTrackers(boxes, {
              selector: action.id || key,
              exactIdOnly: action.__tool_name === "remove_tracker",
            });
            boxes = removal.trackers;
            const nativeExactRemoval = action.__tool_name === "remove_tracker";
            if (
              removal.removedCount === 0 ||
              (nativeExactRemoval && removal.removedCount !== 1)
            ) {
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
        } catch {
          notes.push("Couldn't update that custom panel right now.");
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
          scene = normalizeSceneId(scene) || scene;
          if (!SCENE_IDS.includes(scene)) {
            notes.push(
              `Unknown scene “${scene}”. Try: ${SCENE_IDS.join(", ")}.`
            );
            continue;
          }
          await persistUserScene(session.email, scene);
          sceneOut = scene;
          notes.push(
            scene === "none"
              ? "Scene cleared."
              : `Scene set to “${scene}”. Look up — ambient effect on.`
          );
        } catch {
          notes.push("Couldn't set that scene right now.");
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
        } catch {
          notes.push("Couldn't update the theme right now.");
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
        } catch {
          notes.push("Couldn't update the layout right now.");
        }
        continue;
      }

      if (
        type === "set_companion_settings"
      ) {
        try {
          companionSettingsOut = await saveCompanionSettings(
            session.email,
            {
              ...(action.nickname != null ? { nickname: action.nickname } : {}),
              ...(action.mode != null ? { mode: action.mode } : {}),
              ...(action.personality != null
                ? { personality: action.personality }
                : {}),
              ...(action.detail != null ? { detail: action.detail } : {}),
              ...(action.category_permissions != null
                ? { category_permissions: action.category_permissions }
                : {}),
              ...(action.quiet_hours != null
                ? { quiet_hours: action.quiet_hours }
                : {}),
            }
          );
          toolData = { settings: companionSettingsOut };
          const modeLabel = {
            quiet: "Quiet",
            helpful: "Helpful",
            coach: "Coach",
          }[companionSettingsOut.mode];
          notes.push(`Companion settings updated. Proactive mode: ${modeLabel}.`);
        } catch {
          notes.push("Couldn't update companion settings right now.");
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
            patch.potassium != null ||
            patch.magnesium != null ||
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
          const mineralBit =
            `${g.potassium != null ? ` · K ${g.potassium}mg` : ""}` +
            `${g.magnesium != null ? ` · Mg ${g.magnesium}mg` : ""}`;
          notes.push(
            `Targets updated${out.eating_style ? ` (${out.eating_style})` : ""}: ${g.kcal} kcal · P ${g.protein}g · F ${g.fat}g · C ${g.carbs}g${netBit}${mineralBit}. Rings use these now.`
          );
          goalsOut = out.goals;
        } catch {
          notes.push("Couldn't update those goals right now.");
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
            const savedRow = rowFromSavedFood(saved, amount);
            if (action.__request_id) savedRow.id = action.__request_id;
            next = next.filter((row) => String(row.id) !== String(savedRow.id));
            next.push(savedRow);
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
          foodCorrections: foodCorrectionHints,
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
        if (action.__request_id) resolved.row.id = action.__request_id;
        next = next.filter((row) => String(row.id) !== String(resolved.row.id));
        next.push(resolved.row);
        notes.push(`Added: ${resolved.row.label}`);
      } else if (type === "update" || type === "update_amount" || type === "fix") {
        const idx = findRowIndex(next, action);
        if (idx === -2) {
          notes.push("More than one food entry matched. Tell me which one or give its amount.");
          continue;
        }
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
        if (action.food_text) {
          phrase = action.food_text;
        } else if (amount != null) {
          phrase = `${amount} ${unit} ${foodName}`.replace(/\s+/g, " ").trim();
        } else {
          notes.push("Update needs a new amount.");
          continue;
        }
        const resolved = await resolveFood(phrase, {
          email: session.email,
          findSavedFood,
          rowFromSavedFood,
          foodCorrections: foodCorrectionHints,
        });
        if (!resolved.row || !rowHasMacros(resolved.row)) {
          // Only scale an existing row from an exact mass conversion. Generic
          // servings/cups/scoops need a verified food-specific basis.
          if (amount != null && old.grams) {
            const newGrams = toConvertibleGrams(Number(amount), unit);
            if (newGrams != null) {
              const scale = newGrams / old.grams;
              next[idx] = scaleRow(old, scale, phrase);
              notes.push(`Updated to: ${next[idx].label}`);
              const correction = usualPortionCorrectionFromUpdate(old, next[idx]);
              if (correction) pendingFoodCorrections.push(correction);
            } else {
              notes.push(
                `Couldn't safely convert “${phrase}”. Give me grams/ounces/pounds, or a more specific food label.`
              );
            }
          } else {
            notes.push(resolved.note || `Couldn't update “${old.label}”.`);
          }
          continue;
        }
        // keep same id so UI stability
        resolved.row.id = old.id;
        next[idx] = resolved.row;
        notes.push(`Updated: ${old.label} → ${resolved.row.label}`);
        const correction = usualPortionCorrectionFromUpdate(old, resolved.row);
        if (correction) pendingFoodCorrections.push(correction);
      } else if (type === "remove" || type === "delete") {
        if (action.day && action.day !== requestedDay) {
          notes.push("Couldn't remove that entry because the confirmed ledger day changed.");
          continue;
        }
        const idx = findRowIndex(next, action);
        if (idx === -2) {
          notes.push("More than one food entry matched. Tell me which one or give its amount.");
          continue;
        }
        if (idx < 0) {
          notes.push(`Couldn't find row to remove (${action.match || action.food || "?"}).`);
          continue;
        }
        const gone = next[idx].label;
        next.splice(idx, 1);
        notes.push(`Removed: ${gone}`);
      } else if (type === "clear" || type === "clear_day") {
        if (action.day !== requestedDay) {
          notes.push("Couldn't clear food because the confirmed ledger day changed.");
          continue;
        }
        next = [];
        notes.push("Cleared the day.");
      } else if (type === "message" || type === "reply") {
        // Never treat model-authored prose as an executor receipt. The model's
        // top-level reply already carries conversational text.
        continue;
      } else if (type === "add_food_phrase") {
        // alias
        const resolved = await resolveFood(action.food_text || text, {
          email: session.email,
          findSavedFood,
          rowFromSavedFood,
          foodCorrections: foodCorrectionHints,
        });
        if (resolved.row && rowHasMacros(resolved.row)) {
          if (action.__request_id) resolved.row.id = action.__request_id;
          next = next.filter((row) => String(row.id) !== String(resolved.row.id));
          next.push(resolved.row);
          notes.push(`Added: ${resolved.row.label}`);
        } else {
          notes.push(
            resolved.note ||
              `Couldn't add “${action.food_text || text}” because no complete nutrition match was found.`
          );
        }
      } else {
        const actionName = type || "missing_type";
        notes.push(`Unsupported action “${actionName}”. Nothing changed.`);
      }
      } finally {
        if (action.__tool_call_id) {
          const actionNotes = notes.slice(noteStart);
          const stateChanged =
            beforeRows !== JSON.stringify(next) ||
            beforeSideEvents !== sideEvents.length ||
            actionChanged ||
            Boolean(
              action.__tool_name &&
                action.__tool_name !== "read_today" &&
                action.__tool_name !== "inspect_app" &&
                action.__tool_name !== "lookup_food" &&
                action.__tool_name !== "list_saved_foods" &&
                action.__tool_name !== "remember" &&
                action.__tool_name !== "forget_memory"
            );
          executionByCall.set(
            action.__tool_call_id,
            classifyNativeToolExecution({
              toolName: action.__tool_name,
              notes: actionNotes,
              changed: stateChanged,
              data: toolData,
            })
          );
        }
      }
    }

    const foodRowsChanged = JSON.stringify(next) !== JSON.stringify(rows);
    if (foodRowsChanged && supabaseConfig().ok) {
      try {
        const explicitlyConfirmedEmpty =
          next.length === 0 &&
          actions.some(
            (action) =>
              action.__tool_call_id &&
              ["remove_food", "clear_food_day"].includes(action.__tool_name)
          );
        const syncReceipt = await syncFoodDay(session.email, requestedDay, next, {
          rawText: text,
          allowClear: explicitlyConfirmedEmpty,
          expectedRevision: foodDayRevision,
        });
        foodDayRevision = Number(syncReceipt?.revision);
        ledgerCommitted = true;
        if (pendingFoodCorrections.length) {
          await Promise.allSettled(
            pendingFoodCorrections.map((correction) =>
              recordFoodCorrection(session.email, correction)
            )
          );
        }
      } catch (error) {
        if (error?.code === "stale_food_day_revision") {
          try {
            const latest = await loadFoodDaySnapshot(session.email, requestedDay);
            next = latest.rows;
            foodDayRevision = latest.revision;
            ledgerReloaded = true;
          } catch {
            next = rows.map((row) => ({ ...row }));
          }
          notes.push(
            "This food day changed in another tab or device, so I reloaded it and did not overwrite anything. Please try that change again."
          );
        } else {
          next = rows.map((row) => ({ ...row }));
          notes.push("The food change could not be safely saved, so nothing was changed.");
        }
        for (const action of actions) {
          if (
            action.__tool_call_id &&
            ["add_food", "update_food", "remove_food", "clear_food_day", "log_saved_food"].includes(
              action.__tool_name
            )
          ) {
            const execution = executionByCall.get(action.__tool_call_id) || {};
            executionByCall.set(
              action.__tool_call_id,
              classifyNativeToolExecution({
                toolName: action.__tool_name,
                notes: [
                  ...(execution.notes || []),
                  "The ledger save failed; no food change was committed.",
                ],
                commitFailed: true,
              })
            );
          }
        }
      }
    }

    // If an attempted action produced no usable food result, only fall back to
    // food lookup when the user's own message actually looks like food.
    if (
      !nativeEvaluations.length &&
      looksLikeFood(text) &&
      (!notes.length || notes.every((n) => /couldn't|no /i.test(n)))
    ) {
      return await doAdd(
        text,
        rows,
        res,
        session.email,
        notes.join(" "),
        conversationId,
        requestedDay,
        requestId,
        authoritativeRowsLoaded,
        foodDayRevision
      );
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

    const toolResultMessages = [];
    const verifiedToolResults = [];
    let pendingConfirmation = null;
    const appInspectionData = nativeEvaluations
      .filter((evaluation) => evaluation?.ok && evaluation.tool_name === "inspect_app")
      .map((evaluation) => executionByCall.get(evaluation.tool_call_id)?.data)
      .find(Boolean) || null;
    const exactInspectionReply = appInspectionReply(appInspectionData);
    const forcedTodayRead = nativeEvaluations.find(
      (evaluation) =>
        evaluation?.ok &&
        evaluation.tool_name === "read_today" &&
        evaluation.tool_call_id === "server_required_read_today"
    );
    const exactTodayReadReply = forcedTodayRead
      ? recordedDayReply(executionByCall.get(forcedTodayRead.tool_call_id)?.data)
      : "";
    const exactReadReply = exactInspectionReply || exactTodayReadReply;
    for (const evaluation of nativeEvaluations) {
      if (!evaluation?.ok) {
        verifiedToolResults.push(
          invalidNativeToolExecution({ toolName: evaluation?.tool_name })
        );
        continue;
      }
      if (evaluation.status === "needs_confirmation") {
        let confirmation = {
          ...evaluation.confirmation,
          prompt: trackerRemovalConfirmationPrompt(
            appInspectionData,
            evaluation,
            evaluation.confirmation?.prompt
          ),
        };
        try {
          const token = createToolConfirmationToken({
            email: session.email,
            validatedCall: evaluation,
            secret: getAuthSecret(),
          });
          pendingConfirmation = {
            token,
            tool_call_id: evaluation.tool_call_id,
            tool_name: evaluation.tool_name,
            prompt: confirmation.prompt,
          };
        } catch {
          confirmation = {
            ...confirmation,
            state: "unavailable",
            prompt: "I couldn't create a safe confirmation. Ask me to try that again.",
          };
        }
        verifiedToolResults.push({
          status: "needs_confirmation",
          changed: false,
          confirmation,
        });
        toolResultMessages.push(
          buildNativeToolResultMessage(
            buildToolResultEnvelope({
              toolCallId: evaluation.tool_call_id,
              toolName: evaluation.tool_name,
              status: "needs_confirmation",
              confirmation,
            })
          )
        );
        continue;
      }

      const execution =
        executionByCall.get(evaluation.tool_call_id) ||
        classifyNativeToolExecution({
          toolName: evaluation.tool_name,
          notes: ["The requested action could not be completed."],
          result: { ok: false },
        });
      verifiedToolResults.push(execution);
      const success = execution?.status === "success";
      const resultData = success
        ? {
            ...(execution.data && typeof execution.data === "object"
              ? execution.data
              : {}),
            notes: execution.notes || [],
            ...(["add_food", "update_food", "remove_food", "clear_food_day", "log_saved_food"].includes(
              evaluation.tool_name
            )
              ? { current_log: boundedLedgerToolRead(buildCurrentLogContext(next)) }
              : {}),
            ...(goalsOut ? { goals: goalsOut } : {}),
            ...(themeOut ? { theme: themeOut } : {}),
            ...(layoutOut ? { layout: layoutOut } : {}),
            ...(boxesOut ? { trackers: boxesOut } : {}),
            ...(sceneOut != null ? { scene: sceneOut } : {}),
          }
        : null;
      toolResultMessages.push(
        buildNativeToolResultMessage(
          buildToolResultEnvelope({
            toolCallId: evaluation.tool_call_id,
            toolName: evaluation.tool_name,
            status: success ? "success" : "error",
            changed: Boolean(execution?.changed),
            data: resultData,
            error: success ? null : execution.error,
          })
        )
      );
    }

    let executorDerivedReply = composeActionReply({
      modelReply: intent.reply,
      executionNotes: notes,
    });
    if (
      exactReadReply &&
      nativeEvaluations.length === 1 &&
      ["inspect_app", "read_today"].includes(nativeEvaluations[0]?.tool_name)
    ) {
      executorDerivedReply = exactReadReply;
    }
    let candidateReply = executorDerivedReply;
    if (
      intent?.nativeTurn?.baseMessages &&
      intent?.nativeTurn?.assistantMessage &&
      toolResultMessages.length
    ) {
      const continuationPlan = pendingConfirmation
        ? {
            kind: null,
            allowedToolNames: [],
            allowedSavedFoodIds: [],
            allowedTrackerIds: [],
            sourceData: null,
            blockedReason: null,
          }
        : authorizeBuddyContinuationPlan({
            writeAuthorized: intent?.nativeTurn?.writeAuthorized === true,
            plan: continuationPlanForNativeReads({
              initialEvaluations: nativeEvaluations,
              initialResults: verifiedToolResults,
            }),
          });
      if (
        continuationPlan.kind &&
        continuationPlan.allowedToolNames.length === 0
      ) {
        candidateReply = unresolvedContinuationReply(continuationPlan);
      } else {
        try {
          const continuationTools = BIGBRICEY_TOOLS.filter((tool) =>
            continuationPlan.allowedToolNames.includes(tool?.function?.name)
          );
          await reserveAdditionalLlmTokens(session.email);
          const planningTurn = await callBuddyAfterTools({
            baseMessages: intent.nativeTurn.baseMessages,
            assistantMessage: intent.nativeTurn.assistantMessage,
            toolResultMessages,
            tools: continuationTools,
            fallbackReply: executorDerivedReply,
            allowToolCalls: continuationPlan.allowedToolNames.length > 0,
          });
          if (session.email && planningTurn.output) {
            logLlmUsage(
              session.email,
              usageForMetering(planningTurn.output.usage),
              {
                model: planningTurn.output.model,
                provider: planningTurn.output.provider,
                conversation_id: conversationId || null,
                purpose: continuationPlan.allowedToolNames.length
                  ? "chat_continuation_plan"
                  : "chat_after_tools",
              }
            ).catch(() => {});
          }

        if (
          continuationPlan.allowedToolNames.length > 0 &&
          planningTurn.toolCalls.length
        ) {
          const followupEvaluations = planningTurn.toolCalls.map((call) =>
            validateNativeToolCall(call)
          );
          const selectedContinuation = selectNativeContinuation({
            plan: continuationPlan,
            followupEvaluations,
            continuationDepth: 1,
          });
          const followupEvaluation = selectedContinuation.evaluation;

          if (selectedContinuation.kind === "tracker_removal") {
            let confirmation = {
              ...followupEvaluation.confirmation,
              prompt: trackerRemovalConfirmationPrompt(
                appInspectionData,
                followupEvaluation,
                followupEvaluation.confirmation?.prompt
              ),
            };
            try {
              const token = createToolConfirmationToken({
                email: session.email,
                validatedCall: followupEvaluation,
                secret: getAuthSecret(),
              });
              pendingConfirmation = {
                token,
                tool_call_id: followupEvaluation.tool_call_id,
                tool_name: followupEvaluation.tool_name,
                prompt: confirmation.prompt,
              };
            } catch {
              confirmation = {
                ...confirmation,
                state: "unavailable",
                prompt: "I couldn't create a safe confirmation. Ask me to try that again.",
              };
            }
            verifiedToolResults.push({
              status: "needs_confirmation",
              changed: false,
              confirmation,
            });
            candidateReply = confirmation.prompt;
          } else if (selectedContinuation.kind === "saved_food_log") {
            const stableRowId =
              `chat:${requestId}:saved_food_continuation`.slice(0, 200);
            let continuationReceipt;
            try {
              continuationReceipt = await executeSavedFoodContinuation({
                email: session.email,
                day: requestedDay,
                rawText: text,
                requestId,
                stableRowId,
                savedFoodId: followupEvaluation.arguments.saved_food_id,
                servings: followupEvaluation.arguments.servings,
                allowedSavedFoodIds: continuationPlan.allowedSavedFoodIds,
                rows: next,
                expectedRevision: foodDayRevision,
                authoritativeRowsLoaded,
                findSavedFoodById,
                rowFromSavedFood,
                syncFoodDay,
                loadFoodDaySnapshot,
              });
            } catch {
              continuationReceipt = {
                status: "error",
                changed: false,
                committed: false,
                reloaded: false,
                rows: next,
                revision: foodDayRevision,
                notes: [
                  "The saved food could not be safely added, so nothing was changed.",
                ],
                data: null,
                error: {
                  code: "TOOL_EXECUTION_FAILED",
                  message:
                    "The saved food could not be safely added, so nothing was changed.",
                  retryable: false,
                },
              };
            }

            next = Array.isArray(continuationReceipt.rows)
              ? continuationReceipt.rows
              : next;
            if (Number.isSafeInteger(Number(continuationReceipt.revision))) {
              foodDayRevision = Number(continuationReceipt.revision);
            }
            ledgerCommitted =
              ledgerCommitted || Boolean(continuationReceipt.committed);
            ledgerReloaded =
              ledgerReloaded || Boolean(continuationReceipt.reloaded);
            if (Array.isArray(continuationReceipt.notes)) {
              notes.push(...continuationReceipt.notes);
            }

            const continuationExecution = classifyNativeToolExecution({
              toolName: followupEvaluation.tool_name,
              notes: continuationReceipt.notes || [],
              changed: Boolean(continuationReceipt.changed),
              data: continuationReceipt.data || null,
              result: {
                status: continuationReceipt.status,
                ok: continuationReceipt.status === "success",
                error: continuationReceipt.error || null,
              },
            });
            verifiedToolResults.push(continuationExecution);
            const continuationSucceeded =
              continuationExecution.status === "success";
            const followupResultMessage = buildNativeToolResultMessage(
              buildToolResultEnvelope({
                toolCallId: followupEvaluation.tool_call_id,
                toolName: followupEvaluation.tool_name,
                status: continuationSucceeded ? "success" : "error",
                changed: continuationExecution.changed,
                data: continuationSucceeded
                  ? {
                      ...(continuationExecution.data || {}),
                      notes: continuationExecution.notes || [],
                      current_log: boundedLedgerToolRead(
                        buildCurrentLogContext(next)
                      ),
                    }
                  : null,
                error: continuationSucceeded
                  ? null
                  : continuationExecution.error,
              })
            );

            executorDerivedReply = composeActionReply({
              modelReply: intent.reply,
              executionNotes: notes,
            });
            candidateReply = executorDerivedReply;
            try {
              await reserveAdditionalLlmTokens(session.email);
              const voiceTurn = await callBuddyAfterTools({
                baseMessages: [
                  ...intent.nativeTurn.baseMessages,
                  intent.nativeTurn.assistantMessage,
                  ...toolResultMessages,
                ],
                assistantMessage: assistantMessageForValidatedCalls([
                  followupEvaluation,
                ]),
                toolResultMessages: [followupResultMessage],
                tools: [],
                fallbackReply: executorDerivedReply,
                allowToolCalls: false,
              });
              candidateReply = voiceTurn.reply || executorDerivedReply;
              if (session.email && voiceTurn.output) {
                logLlmUsage(
                  session.email,
                  usageForMetering(voiceTurn.output.usage),
                  {
                    model: voiceTurn.output.model,
                    provider: voiceTurn.output.provider,
                    conversation_id: conversationId || null,
                    purpose: "chat_continuation_voice",
                  }
                ).catch(() => {});
              }
            } catch {
              // Keep the executor-derived receipt if the final voice pass fails.
            }
          } else {
            verifiedToolResults.push(invalidNativeToolExecution());
            candidateReply = executorDerivedReply;
          }
        } else {
          candidateReply = continuationPlan.kind
            ? unresolvedContinuationReply(continuationPlan)
            : planningTurn.reply || executorDerivedReply;
        }
        } catch {
          candidateReply = continuationPlan.kind
            ? unresolvedContinuationReply(continuationPlan)
            : executorDerivedReply;
        }
      }
    }
    const finalCandidateReply =
      exactReadReply &&
      nativeEvaluations.length === 1 &&
      ["inspect_app", "read_today"].includes(nativeEvaluations[0]?.tool_name)
        ? exactReadReply
        : candidateReply;
    let reply = selectVerifiedNativeToolReply({
      candidateReply: finalCandidateReply,
      fallbackReply: executorDerivedReply,
      toolResults: verifiedToolResults,
      pendingConfirmation,
      allowNaturalErrorRecovery: true,
    });
    const needsClarification = verifiedToolResults.some((result) =>
      ["TOOL_REQUIRED_DETAILS", "TOOL_NOT_FOUND", "TOOL_UNAVAILABLE"].includes(
        String(result?.error?.code || "")
      )
    );
    const candidateClaimedUnverifiedSuccess =
      verifiedToolResults.some(
        (result) => result?.status === "error" || result?.ok === false
      ) &&
      /\b(?:done|all set|successfully|i(?:['’]ve|\s+have)?\s+(?:logged|added|saved|removed|deleted|updated|changed|set|put))\b/i.test(
        String(candidateReply || "")
      );
    if (sceneOut != null && !String(reply).trim()) {
      reply = sceneReplyFor(sceneOut);
    }
    let assistantMessageId = null;
    if (conversationId && reply) {
      try {
        const assistantMessage = await appendMessage(
          session.email,
          conversationId,
          "assistant",
          reply
        );
        assistantMessageId = assistantMessage?.id || null;
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
      companion_settings: companionSettingsOut,
      scene: sceneOut,
      conversation_id: conversationId,
      interaction_id: assistantMessageId,
      needs_clarification: needsClarification,
      false_success_prevented: candidateClaimedUnverifiedSuccess,
      memory_notes: memoryOut,
      pending_confirmation: pendingConfirmation,
      ledger_committed: ledgerCommitted,
      ledger_reloaded: ledgerReloaded,
      day_revision: foodDayRevision,
    });
  } catch {
    return sendJson(res, 500, {
      error: "chat_request_failed",
      message: "The chat request failed. Please try again.",
    });
  }
}

async function doAdd(
  text,
  rows,
  res,
  email,
  prefix,
  conversationId,
  requestedDay,
  requestId,
  authoritativeRowsLoaded,
  expectedRevision
) {
  const commitRow = async (row, successReply) => {
    if (!supabaseConfig().ok || !authoritativeRowsLoaded) {
      return sendJson(res, 200, {
        reply: "The food log is temporarily unavailable, so I didn't change anything.",
        rows,
        changed: false,
        conversation_id: conversationId,
      });
    }

    row.id = `chat:${requestId}:direct_food`.slice(0, 200);
    const next = [
      ...rows.filter((item) => String(item.id) !== String(row.id)),
      row,
    ];
    try {
      const syncReceipt = await syncFoodDay(email, requestedDay, next, {
        rawText: text,
        allowClear: false,
        expectedRevision,
      });
      expectedRevision = Number(syncReceipt?.revision);
    } catch (error) {
      if (error?.code === "stale_food_day_revision") {
        try {
          const latest = await loadFoodDaySnapshot(email, requestedDay);
          return sendJson(res, 200, {
            reply:
              "This food day changed in another tab or device, so I reloaded it and did not overwrite anything. Please try that change again.",
            rows: latest.rows,
            changed: false,
            ledger_reloaded: true,
            day_revision: latest.revision,
            conversation_id: conversationId,
          });
        } catch {
          /* use the safe generic response below */
        }
      }
      return sendJson(res, 200, {
        reply: "That food could not be safely saved, so nothing was changed.",
        rows,
        changed: false,
        conversation_id: conversationId,
      });
    }

    if (conversationId) {
      try {
        await appendMessage(email, conversationId, "assistant", successReply);
      } catch {
        /* */
      }
    }
    return sendJson(res, 200, {
      reply: successReply,
      rows: next,
      changed: true,
      ledger_committed: true,
      day_revision: expectedRevision,
      conversation_id: conversationId,
    });
  };

  // Direct hit on personal library by whole phrase (e.g. "log my shake")
  if (email && supabaseConfig().ok) {
    try {
      const saved = await findSavedFood(email, text);
      if (saved) {
        const reply = (prefix ? prefix + " " : "") + `Added saved: ${saved.name}`;
        return commitRow(rowFromSavedFood(saved, 1), reply);
      }
    } catch {
      /* continue */
    }
  }
  let foodCorrections = [];
  try {
    foodCorrections = await listFoodCorrections(email, { limit: 12 });
  } catch {
    /* correction hints are optional; authoritative lookup still proceeds */
  }
  const resolved = await resolveFood(text, {
    email,
    findSavedFood,
    rowFromSavedFood,
    foodCorrections,
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
  const reply = (prefix ? prefix + " " : "") + `Added: ${resolved.row.label}`;
  return commitRow(resolved.row, reply);
}

const ABILITIES_REPLY = abilitiesReplyText();

function sceneReplyFor(scene) {
  if (scene === "none") return "Scene cleared.";
  const labels = {
    snow: "Let it snow — flakes are falling. ❄️",
    rain: "Rain’s on. 🌧️",
    desert: "Desert / sand dust rolling in.",
    ocean: "Ocean vibes up. 🌊",
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
    (scene === "ocean" && /\b(ocean|sea|underwater|bubbles)\b/i.test(reply)) ||
    /scene|look up|ambient|effect|vibe|falling|rolling/i.test(reply)
  );
}

/** Map casual words → scene id (first hit left-to-right). */
const SCENE_KEYWORDS = [
  { id: "snow", re: /\b(snow|snowing|snowfall|blizzard)\b/i },
  { id: "rain", re: /\b(rain|raining|rainy|downpour)\b/i },
  { id: "desert", re: /\b(desert|sand|sandy|mud|muddy|dust|dusty)\b/i },
  { id: "ocean", re: /\b(ocean|underwater|bubbles|sea)\b/i },
  { id: "matrix", re: /\bmatrix\b/i },
  { id: "stars", re: /\b(stars|starry|starfield)\b/i },
  { id: "confetti", re: /\bconfetti\b/i },
  { id: "fireflies", re: /\bfireflies\b/i },
  { id: "aurora", re: /\b(aurora|northern lights)\b/i },
  { id: "mist", re: /\b(mist|foggy|\bfog\b)\b/i },
  { id: "neon_city", re: /\b(neon(?:\s+city)?|cyberpunk)\b/i },
];

const SCENE_ALIASES = {
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

function normalizeSceneId(raw) {
  let s = String(raw || "none")
    .toLowerCase()
    .replace(/\s+/g, "_");
  if (SCENE_ALIASES[s]) s = SCENE_ALIASES[s];
  return SCENE_IDS.includes(s) ? s : null;
}

function findSceneMentions(t) {
  const hits = [];
  for (const { id, re } of SCENE_KEYWORDS) {
    const m = t.match(re);
    if (m && m.index != null && SCENE_IDS.includes(id)) {
      hits.push({ id, at: m.index, word: m[0] });
    }
  }
  hits.sort((a, b) => a.at - b.at);
  // de-dupe by id keep first
  const seen = new Set();
  return hits.filter((h) => {
    if (seen.has(h.id)) return false;
    seen.add(h.id);
    return true;
  });
}

const SCENE_WORD_ALT =
  "snow|snowing|snowfall|blizzard|rain|raining|rainy|downpour|desert|sand|sandy|mud|muddy|dust|dusty|ocean|underwater|bubbles|sea|matrix|stars|starry|starfield|confetti|fireflies|aurora|northern\\s+lights|mist|foggy|fog|neon(?:\\s+city)?|cyberpunk";

function wordToSceneId(word) {
  const w = String(word || "")
    .toLowerCase()
    .replace(/\s+/g, "_");
  const map = {
    snow: "snow",
    snowing: "snow",
    snowfall: "snow",
    blizzard: "snow",
    rain: "rain",
    raining: "rain",
    rainy: "rain",
    downpour: "rain",
    desert: "desert",
    sand: "desert",
    sandy: "desert",
    mud: "desert",
    muddy: "desert",
    dust: "desert",
    dusty: "desert",
    ocean: "ocean",
    underwater: "ocean",
    bubbles: "ocean",
    sea: "ocean",
    matrix: "matrix",
    stars: "stars",
    starry: "stars",
    starfield: "stars",
    confetti: "confetti",
    fireflies: "fireflies",
    aurora: "aurora",
    northern_lights: "aurora",
    mist: "mist",
    foggy: "mist",
    fog: "mist",
    neon: "neon_city",
    neon_city: "neon_city",
    cyberpunk: "neon_city",
  };
  return map[w] || normalizeSceneId(w);
}

/**
 * Only scenes that are the *object* of an apply verb.
 * "try matrix" ✓  |  "I'm going to try each one" + mention of snow ✗
 * "we've already tried the snow" ✗  |  "let me see ocean" ✓
 */
function findApplySceneTargets(t) {
  const hits = [];
  const patterns = [
    // make it (like) rain / let it snow
    new RegExp(
      `\\b(?:make(?:\\s+it)?|let(?:\\s+it)?)\\s+(?:like\\s+)?(?:the\\s+)?(${SCENE_WORD_ALT})\\b`,
      "gi"
    ),
    // let me see ocean / show me rain / see ocean / display stars
    new RegExp(
      `\\b(?:let\\s+me\\s+see|show(?:\\s+me)?|see|display|pull\\s+up|bring\\s+up)\\s+(?:the\\s+)?(${SCENE_WORD_ALT})\\b`,
      "gi"
    ),
    // try matrix / do sand / use rain / switch to ocean / apply snow / i want desert
    new RegExp(
      `\\b(?:try|do|use|set|apply|switch\\s+to|turn\\s+on|start|enable|i\\s+want|give\\s+me|go\\s+with|change(?:\\s+it)?(?:\\s+to)?|run)\\s+(?:like\\s+)?(?:the\\s+)?(?:a\\s+)?(${SCENE_WORD_ALT})\\b`,
      "gi"
    ),
  ];
  for (const re of patterns) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(t)) !== null) {
      const id = wordToSceneId(m[1]);
      if (id && id !== "none") hits.push({ id, at: m.index, word: m[1] });
    }
  }
  hits.sort((a, b) => a.at - b.at);
  const seen = new Set();
  return hits.filter((h) => {
    if (seen.has(h.id)) return false;
    seen.add(h.id);
    return true;
  });
}

function wantsSceneClear(t) {
  return (
    /\b(stop|clear|turn\s+off|disable|no\s+more|get\s+rid\s+of|remove)\b.{0,32}\b(the\s+)?(scene|effect|effects|rain|snow|weather|sand|desert|ocean|matrix|particles|ambiance|ambience)\b/i.test(
      t
    ) ||
    /\b(stop|clear)\s+(the\s+)?(snow|rain|effects?|scene)\b/i.test(t) ||
    /\b(don'?t\s+want|do\s+not\s+want)\b.{0,20}\b(snow|rain|effects?|scene|sand|desert)\b/i.test(
      t
    )
  );
}

/**
 * Listing / explaining — never apply a scene just because snow was *mentioned*.
 * "what's the other ones… we tried snow, ocean"
 * "tell me the other ones, going to try each one"
 */
function isSceneHelpOnly(t, applyTargets) {
  // Strong apply of a *specific* scene beats a list question in the same message
  // e.g. "what can you do? make it rain" → apply rain (handled by caller)
  const listAsk =
    sceneListMode(t).mode != null &&
    (/\b(list|number|every|all|top|favorite|favourite|best|background|scene|haven'?t|remaining|already\s+seen|don'?t\s+put)\b/i.test(
      t
    ) ||
      parseSeenClaimsFromText(t).length > 0) ||
    /\b(what\s+else|what\s+(scenes|effects)|which\s+scenes|how\s+(did|do|you)|explain|tell\s+me\s+about)\b/i.test(
      t
    );

  const softCanYou =
    /\b(can\s+you|could\s+you)\b/i.test(t) &&
    !/\b(make(\s+it)?|let(\s+it)?|show|see|turn\s+on|i\s+want|let\s+me)\b/i.test(t);

  if (listAsk && !applyTargets.length) return true;
  if (listAsk && applyTargets.length === 0) return true;
  // "what's the other ones… tried snow" — listAsk true, may have zero applyTargets
  if (
    listAsk &&
    applyTargets.length &&
    !/\b(make(\s+it)?|let(\s+it)?|show(\s+me)?|let\s+me\s+see|turn\s+on)\b/i.test(t)
  ) {
    // "try each one" is not try+scene; if only weak targets from false positives, still help
    // If they said "make it rain and what else" keep apply — make it is strong
    return true;
  }
  if (softCanYou && (/\?/.test(t) || /\b(mud|sand|rain|snow|ocean)\b/i.test(t))) {
    return true;
  }
  return false;
}

/**
 * Deterministic scene resolver. Returns:
 *   { scene: "rain"|"none"|... } to apply
 *   { helpOnly: true } to list scenes
 *   {} if not a scene utterance
 */
function resolveSceneIntent(text) {
  const t = String(text || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return {};

  const applyTargets = findApplySceneTargets(t);
  const mentions = findSceneMentions(t);
  const clear = wantsSceneClear(t);

  // Bare name: "ocean" / "ocean." / "rain please"
  const bare = t
    .replace(/[.!?,]+$/g, "")
    .replace(/\b(please|now|thanks|tho|though)\b/g, "")
    .trim();
  const bareId = normalizeSceneId(bare.replace(/\s+/g, "_")) || normalizeSceneId(bare);

  // List / explain questions first — do NOT apply snow just because it was named
  if (isSceneHelpOnly(t, applyTargets)) {
    // Exception: clear strong apply in same message with make/let/show
    if (
      applyTargets.length &&
      /\b(make(\s+it)?|let(\s+it)?|show(\s+me)?|let\s+me\s+see|turn\s+on)\b/i.test(t)
    ) {
      // fall through to apply
    } else {
      return { helpOnly: true };
    }
  }

  // Prefer verb→scene targets only (never "any mention + try somewhere")
  let picks = applyTargets.slice();
  if (/\b(don'?t\s+want|do\s+not\s+want|stop|no\s+more|no)\b.{0,20}\bsnow\b/i.test(t)) {
    picks = picks.filter((m) => m.id !== "snow");
  }

  // Clear + no replacement → none
  if (clear && !picks.length) {
    return { scene: "none" };
  }
  if (picks.length) {
    return { scene: picks[0].id };
  }
  if (clear) {
    return { scene: "none" };
  }

  // Short bare scene command only (whole message is basically the name)
  if (bareId && bareId !== "none" && bare.length <= 24) {
    return { scene: bareId };
  }

  // "ocean scene", "rain effect" as whole-ish request
  const sceneNoun = t.match(
    new RegExp(
      `\\b(${SCENE_WORD_ALT})\\s+(scene|effect|mode|vibe)\\b`,
      "i"
    )
  );
  if (sceneNoun && t.length < 48) {
    const id = wordToSceneId(sceneNoun[1]);
    if (id) return { scene: id };
  }

  // "I've already seen rain, snow…" / "don't put those" → re-list remaining
  if (parseSeenClaimsFromText(t).length) {
    return { helpOnly: true };
  }

  // Scene-ish chat with no apply → help if they mentioned scenes at all
  if (mentions.length && /\b(scene|effect|ones|pick|options|what)\b/i.test(t)) {
    return { helpOnly: true };
  }

  return {};
}

/** @deprecated use resolveSceneIntent — kept for call sites expecting id|null */
function detectSceneFromText(text) {
  const r = resolveSceneIntent(text);
  return r.scene || null;
}

async function persistUserScene(email, scene) {
  if (!email || !supabaseConfig().ok) return;
  const id = normalizeSceneId(scene);
  if (!id && scene !== "none") return;
  const sceneId = id || "none";
  await mergeProfilePrefs(email, {
    scene: sceneId,
    ...(sceneId !== "none" ? { scenes_seen: [sceneId] } : {}),
  });
}

/** Merge scene ids into prefs.scenes_seen (user said they already tried them). */
async function persistScenesSeen(email, ids) {
  if (!email || !supabaseConfig().ok) return;
  const add = (ids || [])
    .map((s) => normalizeSceneId(s))
    .filter((s) => s && s !== "none");
  if (!add.length) return;
  await mergeProfilePrefs(email, { scenes_seen: add });
}

/**
 * ONLY when user clearly marks scenes done WITH names:
 * “I've already seen rain, snow, desert and ocean”
 * NOT: “what do you mean skipping what I've already seen”
 * NOT: “I didn't see any”
 */
function parseSeenClaimsFromText(text) {
  const t = String(text || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return [];

  // Negations / meta complaints — never treat as claims
  if (
    /\b(didn'?t\s+see|did\s+not\s+see|never\s+seen|i\s+didn'?t|what do you mean|why (are you|did you)|skipping what)\b/i.test(
      t
    )
  ) {
    return [];
  }

  // Must look like an affirmative claim + at least one scene name nearby
  const claimRe =
    /\b(?:i(?:'ve| have)?\s+)?(?:already\s+)?(?:seen|tried|looked at|did)\s+([^.!?\n]{2,120})/i;
  const dontPutRe =
    /\bdon'?t\s+put\s+([^.!?\n]{2,120})/i;
  const chunks = [];
  let m;
  if ((m = t.match(claimRe))) chunks.push(m[1]);
  if ((m = t.match(dontPutRe))) chunks.push(m[1]);
  // “rain, snow, desert, and ocean” after already seen
  if (!chunks.length) return [];

  const hits = [];
  for (const chunk of chunks) {
    for (const h of findSceneMentions(chunk)) hits.push(h.id);
  }
  return [...new Set(hits)];
}

/** Scene-related talk — never food-log. */
function isSceneChat(text) {
  const t = String(text || "").toLowerCase();
  if (!t.trim()) return false;
  if (resolveSceneIntent(t).scene || resolveSceneIntent(t).helpOnly) return true;
  if (
    /\b(number(ed)?\s+list|list\s+(all|every|the)|top\s+\d|favorite|haven'?t\s+(seen|looked|tried)|backgrounds?|scenes?)\b/.test(
      t
    )
  ) {
    // "list" alone is too broad; require scene-ish context or top-N
    if (/\b(top\s+\d|favorite|background|scene|rain|snow|ocean|matrix)\b/.test(t)) return true;
    if (/\b(list|number).{0,40}(scene|background|effect)/.test(t)) return true;
    if (/\b(scene|background|effect).{0,40}(list|number)/.test(t)) return true;
  }
  return /\b(scene|scenes|effect|effects|snow|rain|desert|sand|mud|ocean|matrix|stars|confetti|fireflies|aurora|mist|neon|weather|ambiance|ambient|particles|underwater|bubbles)\b/.test(
    t
  );
}

const SCENE_LIST_META = [
  { id: "rain", label: "Rain", say: "make it rain" },
  { id: "snow", label: "Snow", say: "make it snow" },
  { id: "desert", label: "Desert / sand dust", say: "desert dust" },
  { id: "ocean", label: "Ocean", say: "let me see ocean" },
  { id: "matrix", label: "Matrix", say: "try matrix" },
  { id: "stars", label: "Stars", say: "show me stars" },
  { id: "confetti", label: "Confetti", say: "try confetti" },
  { id: "fireflies", label: "Fireflies", say: "let’s do fireflies" },
  { id: "aurora", label: "Aurora", say: "try aurora" },
  { id: "mist", label: "Mist", say: "try mist" },
  { id: "neon_city", label: "Neon city", say: "neon city" },
];

// Fixed “top favorites” when user asks for top N (not tracked state)
const SCENE_FAVORITES = ["ocean", "aurora", "matrix", "stars", "fireflies", "rain"];

/**
 * Modes:
 *  - all: full catalog (default for “list every / all backgrounds”)
 *  - remaining: only when user asks what they haven’t seen, or explicitly marks seen + names
 *  - top: “top 3 favorites”
 */
function sceneListMode(userText) {
  const t = String(userText || "").toLowerCase();

  const topM = t.match(/\b(?:top|favorite|best|favourite)\s*(\d{1,2})\b/) ||
    t.match(/\b(\d{1,2})\s*(?:top|favorite|best|favourites?|faves?)\b/) ||
    (/\b(top|favorite|best)\b/.test(t) && /\b(three|3)\b/.test(t) ? ["", "3"] : null);
  if (topM) {
    const n = Math.min(11, Math.max(1, parseInt(topM[1] || "3", 10) || 3));
    return { mode: "top", n };
  }
  if (/\b(only\s+list|just\s+list).{0,20}\b(top|favorite|best|three|3)\b/.test(t)) {
    return { mode: "top", n: 3 };
  }

  // Explicit full list wins over remaining
  if (
    /\b(every|all|full\s+list|entire|complete)\b/.test(t) &&
    /\b(scene|background|effect|one|list)\b/.test(t)
  ) {
    return { mode: "all" };
  }
  if (/\b(list|number).{0,30}\b(every|all)\b/.test(t)) return { mode: "all" };
  if (/\b(every|all).{0,30}\b(background|scene|effect)\b/.test(t)) return { mode: "all" };

  // Remaining only if clearly asked
  if (
    /\b(haven'?t\s+(seen|looked|tried)|not\s+(seen|tried)|still\s+need|remaining|left\s+to\s+(try|see)|ones?\s+i\s+haven'?t)\b/.test(
      t
    )
  ) {
    return { mode: "remaining" };
  }
  // Explicit claim with names → show remaining after save
  if (parseSeenClaimsFromText(t).length) return { mode: "remaining" };

  // Default list requests → full catalog
  if (/\b(list|number|which|what).{0,40}\b(scene|background|effect)\b/.test(t)) {
    return { mode: "all" };
  }
  if (/\b(scene|background|effect).{0,40}\b(list|can you|options)\b/.test(t)) {
    return { mode: "all" };
  }

  return { mode: "all" };
}

function buildScenesHelpReply(userText, { seen = [] } = {}) {
  const t = String(userText || "").toLowerCase();
  const claimedNow = parseSeenClaimsFromText(t);
  const { mode, n } = sceneListMode(t);

  if (mode === "top") {
    const picks = SCENE_FAVORITES.slice(0, n || 3)
      .map((id) => SCENE_LIST_META.find((m) => m.id === id))
      .filter(Boolean);
    const lines = picks.map((x, i) => `${i + 1}. ${x.label} — say “${x.say}”`);
    return `My top ${picks.length} right now:\n${lines.join("\n")}\nSay one of those (or “list all scenes” for the full set).`;
  }

  const seenSet = new Set(
    [...(mode === "remaining" ? seen || [] : []), ...claimedNow]
      .map((s) => normalizeSceneId(s) || s)
      .filter((s) => s && s !== "none")
  );

  let items = SCENE_LIST_META.slice();
  if (mode === "remaining" && seenSet.size) {
    items = items.filter((x) => !seenSet.has(x.id));
  }

  if (mode === "remaining" && seenSet.size && items.length === 0) {
    return "You’ve hit every scene I have. Say “list all scenes” to see them again, or “clear effects” to turn them off.";
  }

  const header =
    mode === "remaining" && seenSet.size
      ? `Left to try (${items.length}):`
      : `All backgrounds I can do (${items.length}):`;

  const lines = items.map((x, i) => `${i + 1}. ${x.label} — say “${x.say}”`);

  const footer =
    mode === "remaining" && seenSet.size
      ? `\nSkipping: ${[...seenSet]
          .map((id) => SCENE_LIST_META.find((m) => m.id === id)?.label || id)
          .join(", ")}.\nSay “list all scenes” if you want the full set anyway.`
      : `\nSay the name to switch (e.g. “make it rain”). “Clear effects” turns them off.`;

  return `${header}\n${lines.join("\n")}${footer}`;
}

// Backward-compatible string for older call sites
const SCENES_HELP = buildScenesHelpReply("list all scenes", { seen: [] });

async function collectSeenScenes(email, historyMessages = []) {
  const seen = new Set();
  if (email && supabaseConfig().ok) {
    try {
      const profile = await getProfile(email);
      const fromPrefs = profile?.prefs?.scenes_seen;
      if (Array.isArray(fromPrefs)) {
        for (const s of fromPrefs) {
          const id = normalizeSceneId(s);
          if (id && id !== "none") seen.add(id);
        }
      }
      const current = normalizeSceneId(profile?.prefs?.scene);
      if (current && current !== "none") seen.add(current);
    } catch {
      /* */
    }
  }
  // Infer from this chat: user apply commands + known scene reply lines
  const msgs = Array.isArray(historyMessages) ? historyMessages : [];
  for (const m of msgs) {
    const content = String(m?.content || m?.text || "");
    if (!content) continue;
    const intent = resolveSceneIntent(content);
    if (intent.scene && intent.scene !== "none") seen.add(intent.scene);
    // Assistant confirmations (exact apply replies only — not the help list text)
    if (/ocean vibes up/i.test(content)) seen.add("ocean");
    if (/let it snow|flakes are falling/i.test(content)) seen.add("snow");
    if (/rain'?s on|rain’s on/i.test(content)) seen.add("rain");
    if (/sand dust rolling in/i.test(content)) seen.add("desert");
    if (/welcome to the matrix/i.test(content)) seen.add("matrix");
    if (/starfield online/i.test(content)) seen.add("stars");
    if (/confetti time/i.test(content)) seen.add("confetti");
    if (/fireflies out/i.test(content)) seen.add("fireflies");
    if (/aurora lights up/i.test(content)) seen.add("aurora");
    if (/mist rolling in/i.test(content)) seen.add("mist");
    if (/neon city online/i.test(content)) seen.add("neon_city");
  }
  return [...seen];
}

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

function isPresenceOrSmallTalk(text) {
  const t = String(text || "")
    .toLowerCase()
    .replace(/[.!?,]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return false;
  // "hey", "hi dude", "yo"
  if (/^(hey|hi|hello|yo|sup|howdy)(\s+(dude|man|bro|there))?$/.test(t)) return true;
  // "are you there?", "hey dude are you there", "you there", "still there?"
  if (
    /\b(are you (there|here|awake|listening|online)|you there|still there|can you hear me|you awake)\b/.test(
      t
    )
  ) {
    return true;
  }
  // thanks / ok
  if (/^(thanks|thank you|thx|ok|okay|cool|nice|got it|sounds good)$/.test(t)) return true;
  return false;
}

function presenceReply() {
  return "Yeah, I'm here. What do you need — food log, scene, goals, layout, or something else?";
}

/** Short chat fallback — NOT the full abilities dump. */
function chatFallbackReply(text) {
  const t = String(text || "").toLowerCase();
  if (isPresenceOrSmallTalk(t)) return presenceReply();
  if (/\b(how are you|what'?s up|whats up)\b/.test(t)) {
    return "I'm good — ready when you are. Log food, change a scene, tweak goals, whatever you need.";
  }
  return "I'm with you. Tell me what you want (log food, switch scene, change colors/goals/layout) — or just ask a question.";
}

function isNonFoodUtterance(text) {
  const t = String(text || "").toLowerCase().trim();
  if (!t) return true;
  if (isPresenceOrSmallTalk(t)) return true;
  if (/^(hi|hello|hey|thanks|thank you|ok|okay)\b/.test(t)) return true;
  if (isSceneChat(t)) return true;
  if (
    /\?/.test(t) &&
    !/(ate|eaten|had|food|log|bacon|egg|oz|lb|kcal|calorie)/.test(t)
  ) {
    return true;
  }
  if (
    /(theme|color|colour|layout|font|corner|square|round|pastel|neon|customize|custom|background|ring|scene|snow|rain|ocean|desert)/.test(
      t
    )
  ) {
    return true;
  }
  return false;
}

const PRIVATE_READ_NUTRIENT_KEYS = [
  "kcal",
  "protein",
  "fat",
  "carbs",
  "net_carbs",
  "fiber",
  "sugars",
  "potassium",
  "magnesium",
  "sodium",
  "calcium",
  "iron",
];

function boundedRecord(value, limit = 40) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return Object.fromEntries(Object.entries(value).slice(0, limit));
}

function boundedLedgerToolRead(log = {}) {
  const sourceItems = Array.isArray(log.items) ? log.items : [];
  const items = sourceItems.slice(-50).map((raw) => {
    const item = {
      id: String(raw?.id || "").slice(0, 120),
      label: String(raw?.label || "Food").slice(0, 240),
    };
    if (raw?.source) item.source = String(raw.source).slice(0, 80);
    if (Number.isFinite(Number(raw?.grams))) item.grams = Number(raw.grams);
    for (const key of PRIVATE_READ_NUTRIENT_KEYS) {
      if (raw?.[key] == null || !Number.isFinite(Number(raw[key]))) continue;
      item[key] = Number(raw[key]);
    }
    const nutrients = boundedRecord(raw?.nutrients, 30);
    if (nutrients && Object.keys(nutrients).length) item.nutrients = nutrients;
    return item;
  });
  return {
    items,
    omitted_count: Math.max(0, sourceItems.length - items.length),
    totals: boundedRecord(log.totals, 40) || {},
    known_subtotals: boundedRecord(log.known_subtotals, 40) || {},
    coverage: boundedRecord(log.coverage, 40) || {},
    data_quality: log.data_quality || null,
    ...(log.extra_nutrient_totals
      ? {
          extra_nutrient_totals: boundedRecord(log.extra_nutrient_totals, 40),
          extra_nutrient_known_subtotals: boundedRecord(
            log.extra_nutrient_known_subtotals,
            40
          ),
          extra_nutrient_coverage: boundedRecord(log.extra_nutrient_coverage, 40),
        }
      : {}),
  };
}

async function loadMeasureSeriesForAppInspection(
  email,
  measureId,
  from,
  to
) {
  const account = String(email || "").toLowerCase();
  const metric = String(measureId || "")
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "");
  if (
    !account ||
    !metric ||
    !normalizeRequestedDay(from) ||
    !normalizeRequestedDay(to) ||
    from > to
  ) {
    throw new Error("invalid_app_inspection_range");
  }
  if (measureUsesLatestDailyValue(metric)) {
    return latestDailyMeasureSeries(account, metric, from, to);
  }
  const rows =
    (await sb("day_totals", {
      query: {
        select: "day_key,measure_id,total,unit",
        user_email: `eq.${account}`,
        measure_id: `eq.${metric}`,
        day_key: `gte.${from}`,
        order: "day_key.asc",
        limit: "1096",
      },
    })) || [];
  return rows.filter(
    (row) => row?.day_key && row.day_key >= from && row.day_key <= to
  );
}

function projectPrivateReadEvent(event = {}) {
  const payload =
    event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
      ? event.payload
      : {};
  const details = {};
  for (const key of [
    "duration_min",
    "sets",
    "reps",
    "load_lb",
    "steps",
    "measure_id",
    "value",
    "unit",
    "label",
    "notes",
  ]) {
    const value = payload[key];
    if (typeof value === "number" && Number.isFinite(value)) details[key] = value;
    else if (typeof value === "string" && value.trim()) details[key] = value.slice(0, 240);
  }
  return {
    category_id: String(event.category_id || "custom").slice(0, 80),
    title: String(event.title || "").slice(0, 240),
    occurred_at: event.occurred_at || null,
    source: String(event.source || "").slice(0, 40),
    ...(Object.keys(details).length ? { details } : {}),
  };
}

function normalizeRequestedDay(value) {
  const raw = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const [year, month, day] = raw.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return raw;
}

function normalizeClientRequestId(value) {
  const raw = String(value || "").trim();
  if (!raw || raw.length > 160 || !/^[a-zA-Z0-9._:-]+$/.test(raw)) return null;
  return raw;
}

async function interpretIntent(text, rows, ctx = {}) {
  const personBlock = formatPersonBlock(ctx);
  const priorCapped = prepareModelHistory(ctx.history, {
    maxMessages: 24,
    currentText: text,
  });

  const system = buildBuddySystemPrompt({
    personBlock,
    currentDate: ctx.currentDate,
    scene: ctx.scene,
    scenesSeen: ctx.scenesSeen,
    theme: ctx.theme,
    memoryNotes: ctx.memoryNotes,
    chatSummary: ctx.chatSummary,
    currentLog: buildCurrentLogContext(rows),
    layout: ctx.layout,
    trackers: ctx.trackers,
    companionSettings: ctx.companionSettings,
    foodCorrections: ctx.foodCorrections,
    inferredStyle: inferCommunicationStyle(priorCapped),
  });
  const baseMessages = [
    { role: "system", content: system },
    ...priorCapped,
    { role: "user", content: text },
  ];

  if (ctx.confirmedNativeCall?.ok && ctx.confirmedNativeCall.status === "ready") {
    const evaluations = [ctx.confirmedNativeCall];
    return {
      reply: "",
      actions: evaluations.map(actionFromValidatedToolCall).filter(Boolean),
      nativeTurn: {
        evaluations,
        baseMessages,
        assistantMessage: assistantMessageForValidatedCalls(evaluations),
        writeAuthorized: true,
      },
    };
  }

  if (!llmConfig().ok) {
    return { error: "model_failed", detail: "llm_not_configured" };
  }

  try {
    const route = await classifyBuddyTurn({
      userText: text,
      history: priorCapped,
    });
    if (ctx.email && route.output) {
      logLlmUsage(ctx.email, usageForMetering(route.output.usage), {
        model: route.output.model,
        provider: route.output.provider,
        conversation_id: ctx.conversationId || null,
        purpose: "chat_route",
      }).catch(() => {});
    }
    await reserveAdditionalLlmTokens(ctx.email, { reservedTokens: 1_000 });
    const routedTools = toolsForBuddyTurn({
      route,
      tools: BIGBRICEY_TOOLS,
    });
    const allowedToolNames = new Set(
      routedTools.map((tool) => tool?.function?.name).filter(Boolean)
    );
    let turn = await callBuddyFirstPass({
      systemPrompt: system,
      history: priorCapped,
      userText: text,
      tools: routedTools,
    });
    const out = turn.output;
    // Meter tokens per user (fire-and-forget)
    if (ctx.email && out) {
      logLlmUsage(ctx.email, usageForMetering(out.usage), {
        model: out.model,
        provider: out.provider,
        conversation_id: ctx.conversationId || null,
        purpose: "chat",
      }).catch(() => {});
    }
    let hasRouteViolation = false;
    let evaluations = turn.toolCalls.map((call) => {
      const proposedName = String(call?.function?.name || "").slice(0, 100);
      if (!allowedToolNames.has(proposedName)) {
        hasRouteViolation = true;
        return {
          ok: false,
          status: "error",
          tool_call_id: String(call?.id || "").slice(0, 200),
          tool_name: proposedName,
          error: {
            code: "TOOL_NOT_AUTHORIZED",
            message: "That app tool was not authorized for this turn.",
            path: "function.name",
          },
        };
      }
      const checked = validateNativeToolCall(call);
      if (checked.ok) {
        if (
          checked.tool_name === "remove_food" &&
          !checked.arguments.day &&
          ctx.currentDate
        ) {
          checked.arguments.day = ctx.currentDate;
        }
        return checked;
      }
      return {
        ...checked,
        tool_call_id: String(call?.id || "").slice(0, 200),
        tool_name: String(call?.function?.name || "").slice(0, 100),
      };
    });
    if (!hasRouteViolation && shouldRepairInvalidReadCalls(evaluations)) {
      try {
        await reserveAdditionalLlmTokens(ctx.email);
        const repair = await repairInvalidReadTurn({
          evaluations,
          runTurn: ({ tools }) =>
            callBuddyFirstPass({
              systemPrompt: system,
              history: priorCapped,
              userText: text,
              tools,
            }),
        });
        if (ctx.email && repair.turn?.output) {
          logLlmUsage(
            ctx.email,
            usageForMetering(repair.turn.output.usage),
            {
              model: repair.turn.output.model,
              provider: repair.turn.output.provider,
              conversation_id: ctx.conversationId || null,
              purpose: "chat_read_repair",
            }
          ).catch(() => {});
        }
        if (repair.repaired) {
          turn = repair.turn;
          evaluations = repair.evaluations;
        }
      } catch {
        // Keep the original failed-closed evaluations and truthful read error.
      }
    }
    const requiredInspection = requiredAppInspection({
      userText: text,
      evaluations,
    });
    if (requiredInspection) {
      evaluations = [
        validateNativeToolCall({
          id: "server_required_inspect_app",
          type: "function",
          function: {
            name: "inspect_app",
            arguments: JSON.stringify(requiredInspection),
          },
        }),
      ];
    }
    const requiredTodayRead = requiredTodayLedgerRead({
      userText: text,
      currentDate: ctx.currentDate,
      evaluations,
    });
    if (requiredTodayRead) {
      evaluations = [
        validateNativeToolCall({
          id: "server_required_read_today",
          type: "function",
          function: {
            name: "read_today",
            arguments: JSON.stringify(requiredTodayRead),
          },
        }),
      ];
    }
    const valid = evaluations.filter((evaluation) => evaluation.ok);
    const allCallsValid = evaluations.every((evaluation) => evaluation.ok);
    const executableCalls = allCallsValid ? valid : [];
    const actions = executableCalls
      .map(actionFromValidatedToolCall)
      .filter(Boolean);
    const invalidCallsAreReadOnly =
      evaluations.length > 0 &&
      evaluations.every((evaluation) =>
        isKnownReadOnlyToolName(evaluation?.tool_name)
      );
    const routedReply = allCallsValid
      ? turn.reply || ""
      : invalidCallsAreReadOnly
        ? "I couldn't safely read that part of the app. Nothing changed."
        : "I couldn't safely use that app action. Nothing changed.";
    const reply = minimalFoodQuantityReply({
      userText: text,
      routeMode: route.mode,
      toolCallCount: evaluations.length,
      reply: routedReply,
    });
    return {
      reply,
      actions,
      nativeTurn: evaluations.length
        ? {
            evaluations,
            baseMessages: turn.baseMessages,
            assistantMessage: assistantMessageForValidatedCalls(executableCalls),
            writeAuthorized: route.mode === "write_explicit",
          }
        : null,
    };
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
  const matches = [];
  for (let i = 0; i < rows.length; i += 1) {
    if (String(rows[i].label || "").toLowerCase().includes(m)) matches.push(i);
  }
  // Native label selectors are permitted specifically for rows omitted from
  // the compact prompt, but never guess when two ledger entries match.
  if (action.__tool_call_id && matches.length > 1) return -2;
  return matches.length ? matches[matches.length - 1] : -1;
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
  const macros = [row?.kcal, row?.protein, row?.fat, row?.carbs];
  return (
    macros.some((value) => Number(value) > 0) ||
    macros.every((value) => value != null && Number.isFinite(Number(value)))
  );
}

function looksLikeFood(text) {
  return /lb|oz|egg|scoop|cup|bacon|beef|chicken|berry|fruit|shake|salt|oil|avocado|pound|gram|\d/i.test(
    text
  );
}
