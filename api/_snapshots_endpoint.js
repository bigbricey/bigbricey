import { requireUser, sendJson } from "./_auth.js";
import { readBody } from "./_lib.js";
import {
  buildHealthSnapshot,
  getHealthSnapshot,
  listHealthSnapshots,
  saveHealthSnapshot,
  updateHealthSnapshot,
  validateSnapshotEdit,
} from "./_health_snapshot.js";
import {
  accountIdForEmail,
  consumeAccountRateLimit,
  ensureProfile,
  recordAccountAudit,
  recordProductEvent,
} from "./_supabase.js";

function publicError(error) {
  const status = Number(error?.status);
  if (status >= 400 && status < 500) {
    return {
      status,
      body: {
        error: String(error.code || "invalid_snapshot_request"),
        message: String(error.message || "Invalid Health Snapshot request."),
      },
    };
  }
  return {
    status: 503,
    body: {
      error: "health_snapshot_unavailable",
      message: "Health Snapshot is temporarily unavailable. Nothing was saved.",
    },
  };
}

function snapshotId(value) {
  const id = String(value || "").trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)
    ? id
    : null;
}

export default async function snapshotsEndpoint(req, res) {
  if (req.method === "OPTIONS") {
    res.setHeader("Allow", "GET, POST, PATCH, OPTIONS");
    return res.status(204).end();
  }
  const user = await requireUser(req, res);
  if (!user) return;

  let accountId = null;
  try {
    await ensureProfile(user.email);
    accountId = await accountIdForEmail(user.email);
    const url = new URL(req.url, `https://${req.headers.host}`);

    if (req.method === "GET") {
      const readPermitted = await consumeAccountRateLimit(
        accountId,
        "snapshot_read",
        { maxEvents: 60, windowSeconds: 60 }
      );
      if (!readPermitted) return sendJson(res, 429, { error: "rate_limited" });
      const id = snapshotId(url.searchParams.get("id"));
      if (id) {
        const snapshot = await getHealthSnapshot(accountId, id);
        if (!snapshot) return sendJson(res, 404, { error: "snapshot_not_found" });
        recordAccountAudit(accountId, {
          action: "read",
          resourceType: "health_snapshot",
          resourceId: id,
        }).catch(() => {});
        return sendJson(res, 200, { snapshot });
      }
      if (url.searchParams.get("list") === "1") {
        const snapshots = await listHealthSnapshots(accountId);
        recordAccountAudit(accountId, {
          action: "list",
          resourceType: "health_snapshot",
        }).catch(() => {});
        return sendJson(res, 200, { snapshots });
      }
      const permitted = await consumeAccountRateLimit(accountId, "snapshot_preview", {
        maxEvents: 12,
        windowSeconds: 60,
      });
      if (!permitted) {
        return sendJson(res, 429, {
          error: "rate_limited",
          message: "Please wait a moment before generating another snapshot.",
        });
      }
      const started = Date.now();
      const result = await buildHealthSnapshot(user.email, {
        period: url.searchParams.get("period") || "10w",
        to: url.searchParams.get("to") || undefined,
      });
      recordAccountAudit(accountId, {
        action: "preview",
        resourceType: "health_snapshot",
        metadata: { period: result.document.period.key },
      }).catch(() => {});
      recordProductEvent(accountId, "health_snapshot_previewed", {
        durationMs: Date.now() - started,
        metadata: { period: result.document.period.key },
      }).catch(() => {});
      return sendJson(res, 200, {
        document: result.document,
        report_text: result.report_text,
        saved: false,
        sharing: "not_sent",
      });
    }

    if (req.method === "POST") {
      const body = await readBody(req, { maxBytes: 70_000 });
      if (body?.op !== "save") {
        return sendJson(res, 400, { error: "snapshot_save_required" });
      }
      const permitted = await consumeAccountRateLimit(accountId, "snapshot_save", {
        maxEvents: 10,
        windowSeconds: 3600,
      });
      if (!permitted) {
        return sendJson(res, 429, {
          error: "rate_limited",
          message: "Snapshot save limit reached. Try again later.",
        });
      }
      const result = await buildHealthSnapshot(user.email, {
        period: body.period || "10w",
        to: body.to || undefined,
      });
      const reportText = validateSnapshotEdit(body.report_text || result.report_text);
      const snapshot = await saveHealthSnapshot(accountId, {
        periodKey: result.document.period.key,
        title: body.title || "Health Snapshot",
        document: result.document,
        reportText,
      });
      await recordAccountAudit(accountId, {
        action: "create",
        resourceType: "health_snapshot",
        resourceId: snapshot?.id,
        metadata: { period: result.document.period.key },
      });
      recordProductEvent(accountId, "health_snapshot_saved", {
        metadata: { period: result.document.period.key },
      }).catch(() => {});
      return sendJson(res, 201, { ok: true, snapshot });
    }

    if (req.method === "PATCH") {
      const permitted = await consumeAccountRateLimit(accountId, "snapshot_update", {
        maxEvents: 20,
        windowSeconds: 3600,
      });
      if (!permitted) return sendJson(res, 429, { error: "rate_limited" });
      const body = await readBody(req, { maxBytes: 70_000 });
      const id = snapshotId(body?.id);
      if (!id) return sendJson(res, 400, { error: "snapshot_id_required" });
      const snapshot = await updateHealthSnapshot(accountId, id, {
        title: body.title,
        reportText: body.report_text,
      });
      if (!snapshot) return sendJson(res, 404, { error: "snapshot_not_found" });
      await recordAccountAudit(accountId, {
        action: "update",
        resourceType: "health_snapshot",
        resourceId: id,
      });
      return sendJson(res, 200, { ok: true, snapshot });
    }

    res.setHeader("Allow", "GET, POST, PATCH, OPTIONS");
    return sendJson(res, 405, { error: "method_not_allowed" });
  } catch (error) {
    if (accountId) {
      recordAccountAudit(accountId, {
        action: "request",
        resourceType: "health_snapshot",
        outcome: "failed",
        metadata: { error_code: String(error?.code || "unavailable").slice(0, 80) },
      }).catch(() => {});
    }
    const response = publicError(error);
    return sendJson(res, response.status, response.body);
  }
}
