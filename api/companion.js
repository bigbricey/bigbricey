import { requireUser, sendJson } from "./_auth.js";
import { validateCompanionSettingsPatch } from "./_companion_settings.js";
import { readBody } from "./_lib.js";
import {
  ensureProfile,
  getCompanionSettings,
  saveCompanionSettings,
} from "./_supabase.js";

function publicError(error) {
  const status = Number(error?.status);
  if (status >= 400 && status < 500) {
    return {
      status,
      body: {
        error: String(error.code || "invalid_companion_settings"),
        message: String(error.message || "Invalid companion settings."),
        ...(error.path ? { path: error.path } : {}),
      },
    };
  }
  return {
    status: 503,
    body: {
      error: "companion_settings_unavailable",
      message: "Companion settings are temporarily unavailable.",
    },
  };
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.setHeader("Allow", "GET, PATCH, OPTIONS");
    return res.status(204).end();
  }
  const user = await requireUser(req, res);
  if (!user) return;
  try {
    await ensureProfile(user.email);
    if (req.method === "GET") {
      return sendJson(res, 200, {
        settings: await getCompanionSettings(user.email),
      });
    }
    if (req.method !== "PATCH") {
      res.setHeader("Allow", "GET, PATCH, OPTIONS");
      return sendJson(res, 405, { error: "method_not_allowed" });
    }
    const body = await readBody(req, { maxBytes: 4_096 });
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).some((key) => key !== "settings")
    ) {
      const error = new Error("Send one settings object.");
      error.code = "invalid_companion_settings";
      error.status = 400;
      throw error;
    }
    const patch = validateCompanionSettingsPatch(body.settings);
    const settings = await saveCompanionSettings(user.email, patch);
    return sendJson(res, 200, { ok: true, settings });
  } catch (error) {
    const response = publicError(error);
    return sendJson(res, response.status, response.body);
  }
}
