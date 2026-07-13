import { getSession, sendJson } from "../_auth.js";
import { redeemInvite, getMembership } from "../_members.js";
import { readBody } from "../_lib.js";

/**
 * POST { code } — redeem invite after Google sign-in.
 * Requires session cookie (from Google), not yet a member.
 */
export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    return res.status(204).end();
  }
  if (req.method !== "POST") return sendJson(res, 405, { error: "POST only" });

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
    const result = await redeemInvite(session.email, code, {
      name: session.name,
    });
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
      e.code === "bad_invite" || e.code === "invite_exhausted" ? 400 : 500;
    return sendJson(res, status, {
      error: e.code || "redeem_failed",
      message: String(e.message || e),
    });
  }
}
