import crypto from "crypto";

const COOKIE = "bigbricey_session";

export function getAuthSecret() {
  return process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET || "dev-insecure-change-me";
}

export function getAllowlist() {
  const raw =
    process.env.AUTH_ALLOWLIST ||
    process.env.ALLOWED_EMAILS ||
    "bigbricey@gmail.com";
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function siteUrl(req) {
  // Prefer the host the user is actually on (bigbricey.com or fitnessfixzone.com).
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  if (host) return `${String(proto)}://${String(host)}`.replace(/\/$/, "");
  if (process.env.SITE_URL) return process.env.SITE_URL.replace(/\/$/, "");
  return "https://www.bigbricey.com";
}

export function signSession(payload) {
  const body = Buffer.from(
    JSON.stringify({ ...payload, exp: Date.now() + 1000 * 60 * 60 * 24 * 30 })
  ).toString("base64url");
  const sig = crypto
    .createHmac("sha256", getAuthSecret())
    .update(body)
    .digest("base64url");
  return `${body}.${sig}`;
}

export function verifySession(token) {
  if (!token || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  const expect = crypto
    .createHmac("sha256", getAuthSecret())
    .update(body)
    .digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (data.exp && Date.now() > data.exp) return null;
    return data;
  } catch {
    return null;
  }
}

export function parseCookies(req) {
  const header = req.headers.cookie || "";
  const out = {};
  header.split(";").forEach((part) => {
    const [k, ...rest] = part.trim().split("=");
    if (k) out[k] = decodeURIComponent(rest.join("=") || "");
  });
  return out;
}

export function getSession(req) {
  const cookies = parseCookies(req);
  return verifySession(cookies[COOKIE]);
}

export function sessionCookie(token, maxAgeSec = 60 * 60 * 24 * 30) {
  const secure = process.env.NODE_ENV === "production" || process.env.VERCEL;
  return [
    `${COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSec}`,
    secure ? "Secure" : "",
  ]
    .filter(Boolean)
    .join("; ");
}

export function clearSessionCookie() {
  const secure = process.env.NODE_ENV === "production" || process.env.VERCEL;
  return [
    `${COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
    secure ? "Secure" : "",
  ]
    .filter(Boolean)
    .join("; ");
}

/**
 * Session required + membership (allowlist admin OR invited allowed_users).
 * Async — callers must await.
 */
export async function requireUser(req, res) {
  const session = getSession(req);
  if (!session?.email) {
    res.statusCode = 401;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "unauthorized", login: "/api/auth/google" }));
    return null;
  }
  // Lazy import to avoid circular deps at load time
  const { isMember } = await import("./_members.js");
  const ok = await isMember(session.email);
  if (!ok) {
    res.statusCode = 403;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        error: "not_invited",
        email: session.email,
        join: "/join.html",
        message: "Invite code required.",
      })
    );
    return null;
  }
  return session;
}

export function sendJson(res, status, body, extraHeaders = {}) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  Object.entries(extraHeaders).forEach(([k, v]) => res.setHeader(k, v));
  res.end(JSON.stringify(body));
}
