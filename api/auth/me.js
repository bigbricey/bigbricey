import { getSession, sendJson } from "../_auth.js";
import { getMembership, touchLastSeen } from "../_members.js";
import {
  ensureProfile,
  getProfile,
  onboardingFromPrefs,
  supabaseConfig,
} from "../_supabase.js";

export default async function handler(req, res) {
  const session = getSession(req);
  if (!session?.email) {
    return sendJson(res, 200, { authenticated: false, member: false });
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
  });
}
