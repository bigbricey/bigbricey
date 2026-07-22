import { requireUser, sendJson } from "./_auth.js";
import { readBody } from "./_lib.js";
import {
  accountIdForEmail,
  consumeAccountRateLimit,
  ensureProfile,
  recordProductEvent,
} from "./_supabase.js";

const ALLOWED_EVENTS = new Set([
  "app_opened",
  "chat_response_completed",
  "log_completed",
  "clarification_received",
  "false_success_prevented",
  "chart_created",
  "photo_review_opened",
  "photo_log_confirmed",
]);

const ALLOWED_METADATA = new Set([
  "outcome",
  "ledger_committed",
  "changed",
  "pending_confirmation",
  "source",
  "range",
  "kind",
]);

export function sanitizeProductEventMetadata(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key, item]) =>
          ALLOWED_METADATA.has(key) &&
          (item == null || ["string", "number", "boolean"].includes(typeof item))
      )
      .map(([key, item]) => [
        key,
        typeof item === "string" ? item.slice(0, 80) : item,
      ])
  );
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
  try {
    const body = await readBody(req, { maxBytes: 4_096 });
    const eventName = String(body?.event_name || "").trim();
    if (!ALLOWED_EVENTS.has(eventName)) {
      return sendJson(res, 400, { error: "unsupported_product_event" });
    }
    await ensureProfile(user.email);
    const accountId = await accountIdForEmail(user.email);
    const permitted = await consumeAccountRateLimit(accountId, "product_event", {
      maxEvents: 120,
      windowSeconds: 60,
    });
    if (!permitted) return sendJson(res, 429, { error: "rate_limited" });
    const recorded = await recordProductEvent(accountId, eventName, {
      durationMs: body.duration_ms,
      numericValue: body.numeric_value,
      metadata: sanitizeProductEventMetadata(body.metadata),
    });
    if (!recorded) {
      return sendJson(res, 503, { error: "product_event_unavailable" });
    }
    return sendJson(res, 202, { ok: true });
  } catch {
    return sendJson(res, 503, { error: "product_event_unavailable" });
  }
}
