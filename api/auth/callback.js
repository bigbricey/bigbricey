import {
  getAuthSecret,
  sessionCookie,
  signSession,
  siteUrl,
} from "../_auth.js";
import { isMember } from "../_members.js";
import { ensureProfile, supabaseConfig } from "../_supabase.js";

export default async function handler(req, res) {
  try {
    const url = new URL(req.url, `https://${req.headers.host}`);
    const code = url.searchParams.get("code");
    const err = url.searchParams.get("error");
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
    if (!clientId || !clientSecret) {
      res.statusCode = 500;
      res.end("Google OAuth not configured");
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
      res.statusCode = 502;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "token_exchange_failed", detail: tokenData }));
      return;
    }

    const profileRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const profile = await profileRes.json();
    const email = String(profile.email || "").toLowerCase();
    if (!email) {
      res.statusCode = 502;
      res.end("No email from Google");
      return;
    }

    if (!process.env.AUTH_SECRET && !getAuthSecret()) {
      /* noop */
    }

    const token = signSession({
      email,
      name: profile.name || email,
      picture: profile.picture || null,
      sub: profile.sub || null,
    });

    res.setHeader("Set-Cookie", sessionCookie(token));

    // Member → app. Not invited yet → join page (session kept so they can redeem).
    const member = await isMember(email);
    if (member) {
      if (supabaseConfig().ok) {
        try {
          await ensureProfile(email, {
            name: profile.name || email,
            picture: profile.picture || null,
          });
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
    res.statusCode = 500;
    res.end(String(e.message || e));
  }
}
