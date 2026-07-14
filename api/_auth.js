import crypto from "crypto";

const COOKIE = "bigbricey_session";
const OAUTH_STATE_COOKIE = "bigbricey_oauth_state";

export function getAuthSecret() {
  const secret = process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET || "";
  const value = String(secret).trim();
  return value.length >= 32 ? value : null;
}

function authSecretOrThrow() {
  const secret = getAuthSecret();
  if (secret) return secret;
  const error = new Error("AUTH_SECRET not configured");
  error.code = "auth_secret_missing";
  throw error;
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

export function getAdminAllowlist() {
  const raw = process.env.AUTH_ADMIN_EMAILS || "bigbricey@gmail.com";
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
  const secret = authSecretOrThrow();
  const body = Buffer.from(
    JSON.stringify({ ...payload, exp: Date.now() + 1000 * 60 * 60 * 24 * 30 })
  ).toString("base64url");
  const sig = crypto
    .createHmac("sha256", secret)
    .update(body)
    .digest("base64url");
  return `${body}.${sig}`;
}

export function verifySession(token) {
  if (!token || !token.includes(".")) return null;
  const secret = getAuthSecret();
  if (!secret) return null;
  const [body, sig] = token.split(".");
  const expect = crypto
    .createHmac("sha256", secret)
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

export function createOAuthState() {
  return crypto.randomBytes(32).toString("base64url");
}

function oauthCookie(value, maxAgeSec) {
  const secure = process.env.NODE_ENV === "production" || process.env.VERCEL;
  return [
    `${OAUTH_STATE_COOKIE}=${encodeURIComponent(value)}`,
    "Path=/api/auth",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSec}`,
    secure ? "Secure" : "",
  ]
    .filter(Boolean)
    .join("; ");
}

export function oauthStateCookie(state) {
  return oauthCookie(String(state || ""), 10 * 60);
}

export function clearOAuthStateCookie() {
  return oauthCookie("", 0);
}

export function verifyOAuthState(req, providedState) {
  const expected = parseCookies(req)[OAUTH_STATE_COOKIE];
  const provided = String(providedState || "");
  if (!expected || !provided) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function firstHeaderValue(value) {
  return String(value || "")
    .split(",", 1)[0]
    .trim();
}

function requestOrigin(req) {
  const headers = req?.headers || {};
  const host =
    firstHeaderValue(headers["x-forwarded-host"]) ||
    firstHeaderValue(headers.host);
  if (!host) return null;
  const proto =
    firstHeaderValue(headers["x-forwarded-proto"]) ||
    (req?.socket?.encrypted ? "https" : "http");
  try {
    return new URL(`${proto}://${host}`).origin;
  } catch {
    return null;
  }
}

/**
 * Browser mutations are private, same-origin JSON requests. CORS response
 * headers alone are not a CSRF defense because the browser can send a simple
 * cross-origin request even when it refuses to expose the response.
 */
export function requirePrivateJsonMutation(req, res) {
  const method = String(req?.method || "GET").toUpperCase();
  if (["GET", "HEAD", "OPTIONS"].includes(method)) return true;

  const contentType = firstHeaderValue(req?.headers?.["content-type"])
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (contentType !== "application/json") {
    sendJson(res, 415, {
      error: "json_required",
      message: "Private changes require an application/json request.",
    });
    return false;
  }

  const expected = requestOrigin(req);
  const supplied = firstHeaderValue(req?.headers?.origin);
  let actual = null;
  try {
    actual = supplied ? new URL(supplied).origin : null;
  } catch {
    actual = null;
  }
  if (!expected || !actual || actual !== expected) {
    sendJson(res, 403, {
      error: "cross_origin_request",
      message: "This change must come from the signed-in app.",
    });
    return false;
  }
  return true;
}

/**
 * Session required + membership (allowlist admin OR invited allowed_users).
 * Async — callers must await.
 */
export async function requireUser(req, res) {
  if (!requirePrivateJsonMutation(req, res)) return null;
  const session = getSession(req);
  if (!session?.email) {
    sendJson(res, 401, { error: "unauthorized", login: "/api/auth/google" });
    return null;
  }
  // Lazy import to avoid circular deps at load time
  const { isMember } = await import("./_members.js");
  const ok = await isMember(session.email);
  if (!ok) {
    sendJson(res, 403, {
      error: "not_invited",
      email: session.email,
      join: "/join.html",
      message: "Invite code required.",
    });
    return null;
  }
  return session;
}

export function sendJson(res, status, body, extraHeaders = {}) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  Object.entries(extraHeaders).forEach(([k, v]) => res.setHeader(k, v));
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Vary", "Cookie");
  res.end(JSON.stringify(body));
}
