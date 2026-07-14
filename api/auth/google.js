import {
  createOAuthState,
  oauthStateCookie,
  siteUrl,
} from "../_auth.js";

export default function handler(req, res) {
  if (req.method && req.method !== "GET") {
    res.statusCode = 405;
    res.setHeader("Allow", "GET");
    return res.end("GET only");
  }
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "text/plain");
    res.end("GOOGLE_CLIENT_ID not configured");
    return;
  }

  const redirectUri = `${siteUrl(req)}/api/auth/callback`;
  const state = createOAuthState();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email profile",
    access_type: "online",
    prompt: "select_account",
    state,
  });

  res.statusCode = 302;
  res.setHeader("Set-Cookie", oauthStateCookie(state));
  res.setHeader("Location", `https://accounts.google.com/o/oauth2/v2/auth?${params}`);
  res.end();
}
