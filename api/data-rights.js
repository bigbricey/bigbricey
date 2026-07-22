import { requireUser, sendJson } from "./_auth.js";
import { readBody } from "./_lib.js";
import {
  accountIdForEmail,
  consumeAccountRateLimit,
  ensureProfile,
  recordAccountAudit,
  sb,
} from "./_supabase.js";

async function listRequests(accountId) {
  return (
    (await sb("account_data_requests", {
      query: {
        select: "id,request_type,status,requested_at,completed_at",
        account_id: `eq.${accountId}`,
        order: "requested_at.desc",
        limit: "20",
      },
    })) || []
  );
}

async function refreshAccountRequestStatus(accountId) {
  const requests = await listRequests(accountId);
  const active = requests.filter((request) =>
    ["requested", "verified", "processing"].includes(request.status)
  );
  const status = active.some((request) => request.request_type === "deletion")
    ? "deletion_requested"
    : active.some((request) => request.request_type === "export")
      ? "export_requested"
      : "active";
  await sb("accounts", {
    method: "PATCH",
    query: { id: `eq.${accountId}` },
    body: { status },
    headers: { Prefer: "return=minimal" },
  });
  return status;
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.setHeader("Allow", "GET, POST, OPTIONS");
    return res.status(204).end();
  }
  const user = await requireUser(req, res);
  if (!user) return;
  let accountId = null;
  try {
    await ensureProfile(user.email);
    accountId = await accountIdForEmail(user.email);
    if (req.method === "GET") {
      const permitted = await consumeAccountRateLimit(accountId, "data_rights_read", {
        maxEvents: 30,
        windowSeconds: 60,
      });
      if (!permitted) return sendJson(res, 429, { error: "rate_limited" });
      return sendJson(res, 200, {
        account_id: accountId,
        requests: await listRequests(accountId),
        deletion_is_automatic: false,
      });
    }
    if (req.method !== "POST") {
      res.setHeader("Allow", "GET, POST, OPTIONS");
      return sendJson(res, 405, { error: "method_not_allowed" });
    }
    const permitted = await consumeAccountRateLimit(accountId, "data_rights", {
      maxEvents: 6,
      windowSeconds: 3600,
    });
    if (!permitted) return sendJson(res, 429, { error: "rate_limited" });
    const body = await readBody(req, { maxBytes: 4_096 });
    const operation = String(body?.op || "").trim();
    if (!["request_export", "request_deletion", "cancel_request"].includes(operation)) {
      return sendJson(res, 400, { error: "unsupported_data_request" });
    }

    if (operation === "cancel_request") {
      const requestId = String(body.request_id || "").trim().toLowerCase();
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) {
        return sendJson(res, 400, { error: "request_id_required" });
      }
      const rows = await sb("account_data_requests", {
        method: "PATCH",
        query: {
          id: `eq.${requestId}`,
          account_id: `eq.${accountId}`,
          status: "in.(requested,verified)",
        },
        body: { status: "cancelled" },
      });
      const cancelled = rows?.[0] || null;
      if (!cancelled) return sendJson(res, 404, { error: "request_not_found" });
      await refreshAccountRequestStatus(accountId);
      await recordAccountAudit(accountId, {
        action: "cancel",
        resourceType: "account_data_request",
        resourceId: requestId,
      });
      return sendJson(res, 200, { ok: true, request: cancelled });
    }

    const type = operation === "request_export" ? "export" : "deletion";
    if (
      type === "deletion" &&
      String(body.confirmation || "").trim() !== "REQUEST DELETE MY ACCOUNT"
    ) {
      return sendJson(res, 400, {
        error: "deletion_confirmation_required",
        message: "Type REQUEST DELETE MY ACCOUNT to prepare this request.",
      });
    }
    const existing = (await listRequests(accountId)).find(
      (request) =>
        request.request_type === type &&
        ["requested", "verified", "processing"].includes(request.status)
    );
    if (existing) return sendJson(res, 200, { ok: true, request: existing, existing: true });
    const rows = await sb("account_data_requests", {
      method: "POST",
      body: {
        account_id: accountId,
        request_type: type,
        status: "requested",
      },
    });
    const request = rows?.[0] || null;
    await refreshAccountRequestStatus(accountId);
    await recordAccountAudit(accountId, {
      action: "request",
      resourceType: `account_${type}`,
      resourceId: request?.id,
    });
    return sendJson(res, 201, {
      ok: true,
      request,
      automatic_deletion: false,
      message:
        type === "export"
          ? "Your full account export request is recorded."
          : "Your deletion request is recorded for identity verification and safe review. No data was deleted yet.",
    });
  } catch (error) {
    if (accountId) {
      recordAccountAudit(accountId, {
        action: "request",
        resourceType: "account_data_right",
        outcome: "failed",
      }).catch(() => {});
    }
    return sendJson(res, 503, {
      error: "data_request_unavailable",
      message: "The request could not be recorded. Nothing changed.",
    });
  }
}
