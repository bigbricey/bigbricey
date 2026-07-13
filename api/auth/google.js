import { siteUrl } from "../_auth.js";

export default function handler(req, res) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "text/plain");
    res.end("GOOGLE_CLIENT_ID not configured");
    return;
  }

  const redirectUri = `${siteUrl(req)}/api/auth/callback`;
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email profile",
    access_type: "online",
    prompt: "select_account",
  });

  res.statusCode = 302;
  res.setHeader("Location", `https://accounts.google.com/o/oauth2/v2/auth?${params}`);
  res.end();
}
