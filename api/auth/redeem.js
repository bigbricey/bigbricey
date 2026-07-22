import {
  getSession,
  requirePrivateJsonMutation,
  sendJson,
} from "../_auth.js";
import { redeemInvite, getMembership } from "../_members.js";
import { readBody } from "../_lib.js";

/**
 * POST { code } — redeem invite after Google sign-in.
 * Requires session cookie (from Google), not yet a member.
 */
export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.setHeader("Allow", "POST, OPTIONS");
    return res.status(204).end();
  }
  if (req.method !== "POST") return sendJson(res, 405, { error: "POST only" });
  if (!requirePrivateJsonMutation(req, res)) return;

  const session = getSession(req);
  if (!session?.email) {
    return sendJson(res, 401, {
      error: "unauthorized",
      message: "Sign in with Google first.",
      login: "/api/auth/google",
    });
  }

  try {
    const body = await readBody(req);
    const code = body.code || body.invite || body.invite_code;
    const result = await redeemInvite(session.email, code);
    const mem = await getMembership(session.email);
    return sendJson(res, 200, {
      ok: true,
      already: Boolean(result.already),
      email: session.email,
      member: mem.member,
      admin: mem.admin,
    });
  } catch (e) {
    const status =
      e.code === "rate_limited"
        ? 429
        : e.code === "bad_invite" ||
            e.code === "invite_exhausted" ||
            e.code === "invite_required"
          ? 400
          : 500;
    const headers = e.retryAfter ? { "Retry-After": String(e.retryAfter) } : {};
    return sendJson(res, status, {
      error: e.code || "redeem_failed",
      message: status === 500 ? "Invite redemption failed." : String(e.message || e),
    }, headers);
  }
}
