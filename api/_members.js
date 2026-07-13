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

const FEEDBACK_CATS = new Set([
  "layout",
  "charts",
  "themes",
  "boxes",
  "food",
  "goals",
  "chat",
  "bugs",
  "mobile",
  "export",
  "other",
]);

/** Normalize a theme key for clustering similar ideas. */
export function normalizeThemeKey(raw, message = "") {
  let s = String(raw || message || "")
    .toLowerCase()
    .replace(/['']/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
  if (!s || s.length < 3) {
    s = String(message || "idea")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 48);
  }
  return s || "other";
}

export function normalizeCategory(raw) {
  const c = String(raw || "other")
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .slice(0, 24);
  return FEEDBACK_CATS.has(c) ? c : "other";
}

export async function submitFeedback(
  email,
  message,
  { name, source = "chat", category, theme_key, theme_label } = {}
) {
  const e = String(email || "").toLowerCase();
  const msg = String(message || "").trim();
  if (!e || !msg) throw new Error("message required");
  if (!supabaseConfig().ok) throw new Error("database not configured");

  const cat = normalizeCategory(category);
  const key = normalizeThemeKey(theme_key, msg);
  const label = String(theme_label || message)
    .trim()
    .slice(0, 120);

  const body = {
    user_email: e,
    user_name: name || null,
    message: msg.slice(0, 4000),
    source,
    status: "new",
    category: cat,
    theme_key: key,
    theme_label: label,
  };

  try {
    const created = await sb("product_feedback", {
      method: "POST",
      body,
    });
    return created?.[0] || { ok: true, theme_key: key, category: cat };
  } catch (err) {
    // Columns may not exist until migration_006 — fall back to basic row
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
    return created?.[0] || { ok: true, theme_key: key, category: cat, degraded: true };
  }
}

export async function listFeedback({ limit = 100 } = {}) {
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

/**
 * Cluster feedback for admin review (NOT auto-build).
 * Ranked by unique users, then total votes.
 */
export async function summarizeFeedback({ limit = 200 } = {}) {
  const items = await listFeedback({ limit });
  const byTheme = new Map();

  for (const f of items) {
    const key =
      f.theme_key ||
      normalizeThemeKey(null, f.message || "");
    const cat = f.category || "other";
    const label =
      f.theme_label ||
      String(f.message || "")
        .trim()
        .slice(0, 80);
    if (!byTheme.has(key)) {
      byTheme.set(key, {
        theme_key: key,
        theme_label: label,
        category: cat,
        count: 0,
        unique_users: 0,
        users: new Set(),
        statuses: { new: 0, read: 0, done: 0 },
        examples: [],
        latest_at: f.created_at || null,
      });
    }
    const t = byTheme.get(key);
    t.count += 1;
    if (f.user_email) t.users.add(String(f.user_email).toLowerCase());
    const st = f.status || "new";
    if (t.statuses[st] != null) t.statuses[st] += 1;
    else t.statuses[st] = 1;
    if (t.examples.length < 3) {
      t.examples.push({
        message: f.message,
        user: f.user_name || f.user_email,
        at: f.created_at,
        status: f.status,
      });
    }
    if (f.created_at && (!t.latest_at || f.created_at > t.latest_at)) {
      t.latest_at = f.created_at;
      // Prefer a readable label from latest
      if (f.theme_label) t.theme_label = f.theme_label;
      if (f.category) t.category = f.category;
    }
  }

  const themes = Array.from(byTheme.values()).map((t) => {
    const unique = t.users.size;
    // Simple priority score for sorting (human still decides)
    const score = unique * 10 + t.count + (t.statuses.new || 0) * 2;
    let importance = "low";
    if (unique >= 5 || t.count >= 8) importance = "high";
    else if (unique >= 2 || t.count >= 3) importance = "medium";
    return {
      theme_key: t.theme_key,
      theme_label: t.theme_label,
      category: t.category,
      count: t.count,
      unique_users: unique,
      new_count: t.statuses.new || 0,
      read_count: t.statuses.read || 0,
      done_count: t.statuses.done || 0,
      importance,
      score,
      latest_at: t.latest_at,
      examples: t.examples,
    };
  });

  themes.sort((a, b) => b.score - a.score || b.unique_users - a.unique_users);

  const byCategory = {};
  for (const t of themes) {
    const c = t.category || "other";
    if (!byCategory[c]) byCategory[c] = { category: c, themes: 0, votes: 0, users: 0 };
    byCategory[c].themes += 1;
    byCategory[c].votes += t.count;
    byCategory[c].users += t.unique_users;
  }

  return {
    total_items: items.length,
    total_themes: themes.length,
    themes,
    by_category: Object.values(byCategory).sort((a, b) => b.votes - a.votes),
    note:
      "Human review only — nothing auto-builds. Discuss with Brice before shipping.",
  };
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

/** Mark all rows for a theme_key */
export async function markFeedbackTheme(themeKey, status = "read") {
  if (!supabaseConfig().ok) return;
  const key = String(themeKey || "").trim();
  if (!key) return;
  await sb("product_feedback", {
    method: "PATCH",
    query: { theme_key: `eq.${key}` },
    body: { status },
    headers: { Prefer: "return=minimal" },
  });
}
