import {
  clearOAuthStateCookie,
  getAuthSecret,
  sendJson,
  sessionCookie,
  signSession,
  siteUrl,
  verifyOAuthState,
} from "../_auth.js";
import { isMember } from "../_members.js";
import {
  ensureProfile,
  linkGoogleIdentity,
  recordAccountAudit,
  supabaseConfig,
} from "../_supabase.js";

export function verifiedGoogleEmail(profile) {
  if (!profile || profile.email_verified !== true) return null;
  const email = String(profile.email || "").trim().toLowerCase();
  return email || null;
}

export default async function handler(req, res) {
  try {
    const url = new URL(req.url, `https://${req.headers.host}`);
    const code = url.searchParams.get("code");
    const err = url.searchParams.get("error");
    const state = url.searchParams.get("state");
    res.setHeader("Set-Cookie", clearOAuthStateCookie());
    if (!verifyOAuthState(req, state)) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Invalid or expired sign-in request. Please start sign-in again.");
      return;
    }
    if (err) {
      res.statusCode = 302;
      res.setHeader("Location", `/?error=${encodeURIComponent(err)}`);
      return res.end();
    }
    if (!code) {
      res.statusCode = 400;
      res.end("Missing code");
      return;
    }

    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    if (!clientId || !clientSecret || !getAuthSecret()) {
      res.statusCode = 500;
      res.end("Sign-in is not configured.");
      return;
    }

    const redirectUri = `${siteUrl(req)}/api/auth/callback`;
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok || !tokenData.access_token) {
      return sendJson(res, 502, { error: "token_exchange_failed" });
    }

    const profileRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const profile = await profileRes.json();
    const email = verifiedGoogleEmail(profile);
    if (!email) {
      return sendJson(res, 502, { error: "google_email_not_verified" });
    }

    const token = signSession({
      email,
      sub: profile.sub || null,
    });

    res.setHeader("Set-Cookie", [clearOAuthStateCookie(), sessionCookie(token)]);

    // Member → app. Not invited yet → join page (session kept so they can redeem).
    const member = await isMember(email);
    if (member) {
      if (supabaseConfig().ok) {
        try {
          await ensureProfile(email);
          if (profile.sub) {
            const accountId = await linkGoogleIdentity(email, profile.sub);
            recordAccountAudit(accountId, {
              action: "sign_in",
              resourceType: "authentication",
              metadata: { provider: "google" },
            }).catch(() => {});
          }
        } catch {
          /* ok */
        }
      }
      res.statusCode = 302;
      res.setHeader("Location", "/app.html");
      return res.end();
    }

    res.statusCode = 302;
    res.setHeader(
      "Location",
      `/join.html?email=${encodeURIComponent(email)}`
    );
    res.end();
  } catch (e) {
    return sendJson(res, 500, { error: "sign_in_failed" });
  }
}
