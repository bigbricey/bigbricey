import { requireUser, sendJson } from "./_auth.js";
import { sanitizeMemoryNoteText } from "./_chat_memory.js";
import { readBody } from "./_lib.js";
import {
  createProfileMemory,
  deleteProfileMemory,
  ensureProfile,
  listProfileMemories,
  updateProfileMemory,
} from "./_supabase.js";

const MEMORY_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EXPLICIT_KINDS = new Set(["fact", "preference"]);

function invalidMemory(message) {
  const error = new Error(message || "Invalid memory request.");
  error.code = "invalid_memory";
  error.status = 400;
  return error;
}

export function validateMemoryMutation(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw invalidMemory();
  }
  const op = String(input.op || "").trim().toLowerCase();
  const allowed = {
    create: new Set(["op", "kind", "text"]),
    update: new Set(["op", "memory_id", "kind", "text"]),
    delete: new Set(["op", "memory_id"]),
  }[op];
  if (!allowed) throw invalidMemory("Unsupported memory operation.");
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw invalidMemory("Unknown memory field.");
  }

  if (op === "delete") {
    const memoryId = String(input.memory_id || "").trim().toLowerCase();
    if (!MEMORY_ID.test(memoryId)) throw invalidMemory("Invalid memory id.");
    return { op, memory_id: memoryId };
  }

  const kind = String(input.kind || "fact").trim().toLowerCase();
  const text = sanitizeMemoryNoteText(input.text);
  if (!EXPLICIT_KINDS.has(kind) || !text || text.length > 300) {
    throw invalidMemory("Invalid explicit memory.");
  }
  if (op === "create") return { op, kind, text };

  const memoryId = String(input.memory_id || "").trim().toLowerCase();
  if (!MEMORY_ID.test(memoryId)) throw invalidMemory("Invalid memory id.");
  return { op, memory_id: memoryId, kind, text };
}

export function publicMemoryError(error) {
  const databaseCode = String(error?.detail?.code || error?.code || "");
  if (error?.code === "memory_limit_reached") {
    return {
      status: 409,
      body: {
        error: "memory_limit_reached",
        message:
          "BigBricey can remember up to 40 permanent items. Edit or forget one first.",
      },
    };
  }
  if (databaseCode === "23505") {
    return {
      status: 409,
      body: {
        error: "memory_already_exists",
        message: "BigBricey already remembers that.",
      },
    };
  }
  if (Number(error?.status) >= 400 && Number(error?.status) < 500) {
    return {
      status: Number(error.status),
      body: {
        error: String(error.code || "invalid_memory"),
        message: String(error.message || "Invalid memory request."),
      },
    };
  }
  return {
    status: 503,
    body: {
      error: "memory_unavailable",
      message: "BigBricey memory is temporarily unavailable.",
    },
  };
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.setHeader("Allow", "GET, POST, OPTIONS");
    return res.status(204).end();
  }

  const user = await requireUser(req, res);
  if (!user) return;

  try {
    await ensureProfile(user.email);
    if (req.method === "GET") {
      const memories = await listProfileMemories(user.email, { limit: 40 });
      return sendJson(res, 200, { memories });
    }
    if (req.method !== "POST") {
      res.setHeader("Allow", "GET, POST, OPTIONS");
      return sendJson(res, 405, { error: "method_not_allowed" });
    }

    const mutation = validateMemoryMutation(
      await readBody(req, { maxBytes: 2_048 })
    );
    if (mutation.op === "create") {
      await createProfileMemory(user.email, {
        kind: mutation.kind,
        text: mutation.text,
        provenance: "user_ui",
      });
    } else if (mutation.op === "update") {
      await updateProfileMemory(user.email, mutation.memory_id, {
        kind: mutation.kind,
        text: mutation.text,
      });
    } else {
      const result = await deleteProfileMemory(user.email, mutation.memory_id);
      if (!result.deleted) {
        const error = new Error("Memory not found.");
        error.code = "memory_not_found";
        error.status = 404;
        throw error;
      }
    }

    const memories = await listProfileMemories(user.email, { limit: 40 });
    return sendJson(res, 200, { ok: true, memories });
  } catch (error) {
    const response = publicMemoryError(error);
    return sendJson(res, response.status, response.body);
  }
}
