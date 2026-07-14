import crypto from "crypto";

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function requireSecret(secret) {
  const value = String(secret || "").trim();
  if (!value) fail("confirmation_secret_missing", "Confirmation signing is unavailable.");
  return value;
}

function accountSubject(email, secret) {
  const normalized = String(email || "").trim().toLowerCase();
  if (!normalized) fail("confirmation_account_missing", "Account is required.");
  return crypto
    .createHmac("sha256", secret)
    .update(`bigbricey-confirmation-account\0${normalized}`)
    .digest("base64url");
}

function signature(body, secret) {
  return crypto
    .createHmac("sha256", secret)
    .update(`bigbricey-tool-confirmation-v1\0${body}`)
    .digest("base64url");
}

function equalText(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function createToolConfirmationToken({
  email,
  validatedCall,
  secret,
  now = Date.now(),
  ttlMs = 10 * 60 * 1000,
} = {}) {
  const key = requireSecret(secret);
  if (!validatedCall?.ok || validatedCall.status !== "needs_confirmation") {
    fail("confirmation_not_required", "This tool call is not awaiting confirmation.");
  }
  const ttl = Math.min(10 * 60 * 1000, Math.max(1_000, Number(ttlMs) || 0));
  const issuedAt = Math.floor(Number(now));
  const payload = {
    v: 1,
    sub: accountSubject(email, key),
    iat: issuedAt,
    exp: issuedAt + ttl,
    call: {
      id: String(validatedCall.tool_call_id || "").slice(0, 200),
      name: String(validatedCall.tool_name || "").slice(0, 100),
      args: validatedCall.arguments,
    },
  };
  if (!payload.call.id || !payload.call.name || !payload.call.args || typeof payload.call.args !== "object") {
    fail("invalid_confirmation_call", "The pending tool call is invalid.");
  }
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${signature(body, key)}`;
}

export function verifyToolConfirmationToken(
  token,
  { email, secret, now = Date.now() } = {}
) {
  const key = requireSecret(secret);
  const raw = String(token || "");
  if (!raw || raw.length > 20_000) fail("invalid_confirmation", "Invalid confirmation.");
  const parts = raw.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    fail("invalid_confirmation", "Invalid confirmation.");
  }
  const [body, supplied] = parts;
  if (!equalText(supplied, signature(body, key))) {
    fail("invalid_confirmation", "Invalid confirmation.");
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    fail("invalid_confirmation", "Invalid confirmation.");
  }
  if (
    payload?.v !== 1 ||
    !Number.isFinite(payload?.iat) ||
    !Number.isFinite(payload?.exp) ||
    payload.exp <= payload.iat ||
    payload.exp - payload.iat > 10 * 60 * 1000 ||
    !payload?.call ||
    typeof payload.call.args !== "object" ||
    Array.isArray(payload.call.args)
  ) {
    fail("invalid_confirmation", "Invalid confirmation.");
  }
  if (Number(now) > payload.exp) {
    fail("confirmation_expired", "That confirmation expired. Ask again.");
  }
  if (!equalText(payload.sub, accountSubject(email, key))) {
    fail("confirmation_account_mismatch", "That confirmation belongs to another account.");
  }

  return {
    id: String(payload.call.id || ""),
    type: "function",
    function: {
      name: String(payload.call.name || ""),
      arguments: JSON.stringify(payload.call.args),
    },
  };
}
