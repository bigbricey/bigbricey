import { getAllowlist } from "./_auth.js";
import { sb, supabaseConfig, ensureProfile } from "./_supabase.js";

const OWNER = "bigbricey@gmail.com";

export function isBootstrapAdmin(email) {
  const e = String(email || "").toLowerCase();
  if (!e) return false;
  if (e === OWNER) return true;
  const allow = getAllowlist();
  return allow.includes(e);
}

/** Sync bootstrap only — use isMember for full check */
export function isBootstrapAllowed(email) {
  return isBootstrapAdmin(email);
}

export async function isMember(email) {
  const e = String(email || "").toLowerCase();
  if (!e) return false;
  if (isBootstrapAdmin(e)) return true;
  if (!supabaseConfig().ok) {
    // no DB: fall back to env allowlist only
    const allow = getAllowlist();
    return allow.length === 0 || allow.includes(e);
  }
  try {
    const rows = await sb("allowed_users", {
      query: { select: "email,role", email: `eq.${e}`, limit: "1" },
    });
    return Boolean(rows?.[0]);
  } catch {
    return isBootstrapAdmin(e);
  }
}

export async function isAdmin(email) {
  const e = String(email || "").toLowerCase();
  if (!e) return false;
  if (isBootstrapAdmin(e)) return true;
  if (!supabaseConfig().ok) return false;
  try {
    const rows = await sb("allowed_users", {
      query: { select: "role", email: `eq.${e}`, limit: "1" },
    });
    return rows?.[0]?.role === "admin";
  } catch {
    return false;
  }
}

export async function getMembership(email) {
  const e = String(email || "").toLowerCase();
  if (!e) return { member: false, admin: false };
  if (isBootstrapAdmin(e)) return { member: true, admin: true, role: "admin" };
  if (!supabaseConfig().ok) {
    const allow = getAllowlist();
    const ok = allow.length === 0 || allow.includes(e);
    return { member: ok, admin: ok && allow.includes(e), role: ok ? "member" : null };
  }
  try {
    const rows = await sb("allowed_users", {
      query: { select: "email,name,role,invite_code,joined_at", email: `eq.${e}`, limit: "1" },
    });
    const row = rows?.[0];
    if (!row) return { member: false, admin: false };
    return {
      member: true,
      admin: row.role === "admin",
      role: row.role,
      invite_code: row.invite_code,
      joined_at: row.joined_at,
    };
  } catch {
    return { member: isBootstrapAdmin(e), admin: isBootstrapAdmin(e) };
  }
}

export async function redeemInvite(email, code, { name } = {}) {
  const e = String(email || "").toLowerCase();
  const c = String(code || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
  if (!e) throw new Error("email required");
  if (!c) throw new Error("invite code required");
  if (!supabaseConfig().ok) throw new Error("database not configured");

  // already member?
  if (await isMember(e)) {
    return { ok: true, already: true, email: e };
  }

  const invites = await sb("invite_codes", {
    query: { select: "*", code: `eq.${c}`, limit: "1" },
  });
  const inv = invites?.[0];
  if (!inv || !inv.active) {
    const err = new Error("Invalid or inactive invite code");
    err.code = "bad_invite";
    throw err;
  }
  if (inv.max_uses != null && Number(inv.use_count) >= Number(inv.max_uses)) {
    const err = new Error("This invite code is used up");
    err.code = "invite_exhausted";
    throw err;
  }

  await ensureProfile(e, { name: name || null });

  await sb("allowed_users", {
    method: "POST",
    body: {
      email: e,
      name: name || null,
      role: "member",
      invite_code: c,
      joined_at: new Date().toISOString(),
    },
    headers: { Prefer: "return=minimal,resolution=merge-duplicates" },
  });

  // bump use count
  await sb("invite_codes", {
    method: "PATCH",
    query: { code: `eq.${c}` },
    body: { use_count: Number(inv.use_count || 0) + 1 },
    headers: { Prefer: "return=minimal" },
  });

  return { ok: true, email: e, code: c };
}

export async function touchLastSeen(email) {
  const e = String(email || "").toLowerCase();
  if (!e || !supabaseConfig().ok) return;
  try {
    await sb("allowed_users", {
      method: "PATCH",
      query: { email: `eq.${e}` },
      body: { last_seen_at: new Date().toISOString() },
      headers: { Prefer: "return=minimal" },
    });
  } catch {
    /* ok */
  }
}

export async function submitFeedback(email, message, { name, source = "chat" } = {}) {
  const e = String(email || "").toLowerCase();
  const msg = String(message || "").trim();
  if (!e || !msg) throw new Error("message required");
  if (!supabaseConfig().ok) throw new Error("database not configured");
  const created = await sb("product_feedback", {
    method: "POST",
    body: {
      user_email: e,
      user_name: name || null,
      message: msg.slice(0, 4000),
      source,
      status: "new",
    },
  });
  return created?.[0] || { ok: true };
}

export async function listFeedback({ limit = 50 } = {}) {
  if (!supabaseConfig().ok) return [];
  return (
    (await sb("product_feedback", {
      query: {
        select: "*",
        order: "created_at.desc",
        limit: String(limit),
      },
    })) || []
  );
}

export async function markFeedback(id, status = "read") {
  if (!supabaseConfig().ok) return;
  await sb("product_feedback", {
    method: "PATCH",
    query: { id: `eq.${id}` },
    body: { status },
    headers: { Prefer: "return=minimal" },
  });
}
