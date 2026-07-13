import { getSession, sendJson } from "../_auth.js";
import { readBody } from "../_lib.js";
import { getMembership, touchLastSeen } from "../_members.js";
import {
  ensureProfile,
  getProfile,
  onboardingFromPrefs,
  saveUserLayout,
  saveUserTheme,
  saveUserBoxes,
  supabaseConfig,
} from "../_supabase.js";

export default async function handler(req, res) {
  const session = getSession(req);
  if (!session?.email) {
    return sendJson(res, 200, { authenticated: false, member: false });
  }

  // Save layout / theme prefs
  if (req.method === "POST") {
    try {
      const body = await readBody(req);
      if (body?.layout && typeof body.layout === "object") {
        const layout = await saveUserLayout(session.email, body.layout);
        return sendJson(res, 200, { ok: true, layout });
      }
      if (body?.theme && typeof body.theme === "object") {
        const theme = await saveUserTheme(session.email, body.theme);
        return sendJson(res, 200, { ok: true, theme });
      }
      if (Array.isArray(body?.boxes)) {
        const boxes = await saveUserBoxes(session.email, body.boxes);
        return sendJson(res, 200, { ok: true, boxes });
      }
      return sendJson(res, 400, { error: "layout, theme, or boxes required" });
    } catch (e) {
      return sendJson(res, 500, { error: String(e.message || e) });
    }
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    return sendJson(res, 405, { error: "GET or POST" });
  }

  const mem = await getMembership(session.email);
  if (mem.member) {
    touchLastSeen(session.email).catch(() => {});
  }

  let onboarding = { complete: false };
  let prefs = {};
  if (mem.member && supabaseConfig().ok) {
    try {
      await ensureProfile(session.email, {
        name: session.name,
        picture: session.picture,
      });
      const profile = await getProfile(session.email);
      prefs = profile?.prefs && typeof profile.prefs === "object" ? profile.prefs : {};
      onboarding = onboardingFromPrefs(prefs);
    } catch {
      // If cloud is flaky, don't block login — treat incomplete so they retry later
      onboarding = { complete: false };
    }
  }

  const layout =
    prefs.layout && typeof prefs.layout === "object" ? prefs.layout : null;
  const theme =
    prefs.theme && typeof prefs.theme === "object" ? prefs.theme : null;
  const boxes = Array.isArray(prefs.boxes) ? prefs.boxes : [];

  return sendJson(res, 200, {
    authenticated: true,
    member: mem.member,
    admin: Boolean(mem.admin),
    role: mem.role || null,
    email: session.email,
    name: onboarding.first_name || session.name || null,
    picture: session.picture || null,
    join: mem.member ? null : "/join.html",
    onboarding_complete: Boolean(onboarding.complete),
    onboarding,
    goals: onboarding.goals || null,
    layout,
    theme,
    boxes,
  });
}
