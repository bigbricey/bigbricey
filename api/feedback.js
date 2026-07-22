import { requireUser, sendJson } from "./_auth.js";
import { normalizeCompanionSettings } from "./_companion_settings.js";
import { readBody } from "./_lib.js";
import { submitFeedback } from "./_members.js";
import {
  accountIdForEmail,
  consumeAccountRateLimit,
  ensureProfile,
  getProfile,
  recordAccountAudit,
  recordProductEvent,
  sb,
} from "./_supabase.js";

function uuid(value) {
  const id = String(value || "").trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)
    ? id
    : null;
}

function cleanText(value, max) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function sanitizeCorrection(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const allowed = ["field", "original", "corrected", "food_entry_id", "note"];
  const correction = Object.fromEntries(
    allowed
      .filter((key) => value[key] != null)
      .map((key) => [key, cleanText(value[key], key === "note" ? 1000 : 300)])
      .filter(([, item]) => item)
  );
  return Object.keys(correction).length ? correction : null;
}

async function interactionContext(accountId, interactionId) {
  const id = uuid(interactionId);
  if (!id) return null;
  const rows = await sb("chat_messages", {
    query: {
      select: "id,conversation_id,role,content,created_at",
      id: `eq.${id}`,
      account_id: `eq.${accountId}`,
      limit: "1",
    },
  });
  const selected = rows?.[0];
  if (!selected || selected.role !== "assistant") return null;
  const prior = await sb("chat_messages", {
    query: {
      select: "id,role,content,created_at",
      conversation_id: `eq.${selected.conversation_id}`,
      account_id: `eq.${accountId}`,
      role: "eq.user",
      created_at: `lte.${selected.created_at}`,
      order: "created_at.desc,id.desc",
      limit: "1",
    },
  });
  return {
    user_message: prior?.[0]
      ? {
          id: prior[0].id,
          text: cleanText(prior[0].content, 2_000),
        }
      : null,
    assistant_message: {
      id: selected.id,
      text: cleanText(selected.content, 2_000),
    },
  };
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.setHeader("Allow", "POST, OPTIONS");
    return res.status(204).end();
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return sendJson(res, 405, { error: "method_not_allowed" });
  }
  const user = await requireUser(req, res);
  if (!user) return;

  let accountId = null;
  try {
    const body = await readBody(req, { maxBytes: 16_000 });
    if (body?.consent !== true) {
      return sendJson(res, 400, {
        error: "feedback_consent_required",
        message: "Confirm before sending feedback.",
      });
    }
    await ensureProfile(user.email);
    accountId = await accountIdForEmail(user.email);
    const permitted = await consumeAccountRateLimit(accountId, "feedback_submit", {
      maxEvents: 12,
      windowSeconds: 3600,
    });
    if (!permitted) {
      return sendJson(res, 429, {
        error: "rate_limited",
        message: "Feedback limit reached. Try again later.",
      });
    }

    const kind = ["wrong", "correction", "idea", "trust"].includes(body.kind)
      ? body.kind
      : "idea";
    const interactionId = uuid(body.interaction_id);
    const includeContext = body.include_context === true;
    if (["wrong", "correction"].includes(kind) && !interactionId) {
      return sendJson(res, 400, {
        error: "interaction_required",
        message: "Choose the response this feedback belongs to.",
      });
    }
    const context = includeContext
      ? await interactionContext(accountId, interactionId)
      : null;
    if (includeContext && !context) {
      return sendJson(res, 404, {
        error: "interaction_not_found",
        message: "That response is not available in this account.",
      });
    }
    const profile = await getProfile(user.email);
    const nickname = normalizeCompanionSettings(
      profile?.prefs?.assistant_settings
    ).nickname;
    const row = await submitFeedback(user.email, body.message, {
      name: nickname || null,
      source: interactionId ? "interaction" : "form",
      category: body.category,
      theme_key: body.theme_key,
      theme_label: body.theme_label,
      consent: true,
      feedbackKind: kind,
      interactionId,
      includeContext,
      contextExcerpt: context,
      correction: sanitizeCorrection(body.correction),
      trustRating: body.trust_rating,
    });
    await recordAccountAudit(accountId, {
      action: "create",
      resourceType: "product_feedback",
      resourceId: row?.id,
      metadata: { kind, included_context: includeContext },
    });
    recordProductEvent(accountId, "feedback_submitted", {
      metadata: { kind, included_context: includeContext },
    }).catch(() => {});
    return sendJson(res, 201, {
      ok: true,
      id: row?.id || null,
      context_included: includeContext,
    });
  } catch (error) {
    if (accountId) {
      recordAccountAudit(accountId, {
        action: "create",
        resourceType: "product_feedback",
        outcome: "failed",
        metadata: { error_code: String(error?.code || "unavailable").slice(0, 80) },
      }).catch(() => {});
    }
    const status = Number(error?.status);
    return sendJson(res, status >= 400 && status < 500 ? status : 503, {
      error: String(error?.code || "feedback_unavailable"),
      message:
        status >= 400 && status < 500
          ? String(error.message || "Invalid feedback.")
          : "Feedback could not be sent. Nothing was submitted.",
    });
  }
}
