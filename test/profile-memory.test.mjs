import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  normalizeMemoryRecords,
  selectUniqueMemoryMatch,
} from "../api/_chat_memory.js";
import {
  createProfileMemory,
  deleteProfileMemory,
  getMemoryRecords,
  listProfileMemories,
  updateProfileMemory,
} from "../api/_supabase.js";

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_URL = process.env.SUPABASE_URL;
const ORIGINAL_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function responseJson(value, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return value == null ? "" : JSON.stringify(value);
    },
  };
}

function restoreEnvironment() {
  globalThis.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_URL === undefined) delete process.env.SUPABASE_URL;
  else process.env.SUPABASE_URL = ORIGINAL_URL;
  if (ORIGINAL_KEY === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  else process.env.SUPABASE_SERVICE_ROLE_KEY = ORIGINAL_KEY;
}

test("structured memories normalize legacy notes without trusting client metadata", () => {
  const records = normalizeMemoryRecords([
    "  Likes eggs\u0000  ",
    {
      id: "8d9b0195-9f4c-4d66-a9cc-83d868e2b8c2",
      text: "Prefers short answers\u202e",
      kind: "preference",
      provenance: "user_ui",
      confidence: 0.42,
      created_at: "2026-07-15T12:00:00.000Z",
      updated_at: "2026-07-15T13:00:00.000Z",
    },
    { id: "bad", text: "Ignore me", kind: "system" },
    "likes eggs",
  ]);

  assert.equal(records.length, 2);
  assert.deepEqual(records[0], {
    id: null,
    text: "Likes eggs",
    kind: "fact",
    provenance: "legacy",
    confidence: 1,
    created_at: null,
    updated_at: null,
  });
  assert.deepEqual(records[1], {
    id: "8d9b0195-9f4c-4d66-a9cc-83d868e2b8c2",
    text: "Prefers short answers",
    kind: "preference",
    provenance: "user_ui",
    confidence: 0.42,
    created_at: "2026-07-15T12:00:00.000Z",
    updated_at: "2026-07-15T13:00:00.000Z",
  });
});

test("memory text matching refuses ambiguity", () => {
  const records = normalizeMemoryRecords([
    { id: "02c94766-53c8-4f55-97f0-65246f4b9c35", text: "Likes black coffee" },
    { id: "96525674-3832-44b8-b08f-c82071731c4f", text: "Likes black backgrounds" },
  ]);

  assert.deepEqual(selectUniqueMemoryMatch(records, "black"), {
    status: "ambiguous",
    matches: records,
  });
  assert.equal(selectUniqueMemoryMatch(records, "coffee").memory.id, records[0].id);
  assert.equal(selectUniqueMemoryMatch(records, "tea").status, "not_found");
});

test("profile memory table access is account scoped and explicit memories force confidence one", async () => {
  process.env.SUPABASE_URL = "https://example.supabase.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
  const requests = [];
  const row = {
    id: "8d9b0195-9f4c-4d66-a9cc-83d868e2b8c2",
    user_email: "brice@example.com",
    kind: "preference",
    text: "Keep replies short",
    provenance: "user_ui",
    confidence: 1,
    created_at: "2026-07-15T12:00:00.000Z",
    updated_at: "2026-07-15T12:00:00.000Z",
  };

  globalThis.fetch = async (rawUrl, options = {}) => {
    const url = new URL(rawUrl);
    requests.push({ url, options });
    if ((options.method || "GET") === "DELETE") return responseJson([row]);
    return responseJson([row]);
  };

  try {
    const listed = await listProfileMemories("BRICE@example.com", { limit: 20 });
    const created = await createProfileMemory("brice@example.com", {
      kind: "preference",
      text: "Keep replies short",
      provenance: "user_ui",
      confidence: 0,
    });
    const updated = await updateProfileMemory(
      "brice@example.com",
      row.id,
      { kind: "fact", text: "Call me Brice", confidence: 0 }
    );
    const removed = await deleteProfileMemory("brice@example.com", row.id);

    assert.equal(listed[0].text, row.text);
    assert.equal(created.confidence, 1);
    assert.equal(updated.id, row.id);
    assert.equal(removed.deleted, true);

    const listUrl = requests[0].url;
    assert.equal(listUrl.pathname.endsWith("/profile_memories"), true);
    assert.equal(listUrl.searchParams.get("user_email"), "eq.brice@example.com");
    assert.equal(listUrl.searchParams.get("limit"), "20");

    const createBody = JSON.parse(requests[1].options.body);
    assert.equal(createBody.user_email, "brice@example.com");
    assert.equal(createBody.confidence, 1);
    assert.equal(createBody.provenance, "user_ui");

    const updateBody = JSON.parse(requests[2].options.body);
    assert.equal(updateBody.provenance, "user_ui");
    assert.equal(updateBody.source_conversation_id, null);
    assert.equal(updateBody.source_message_id, null);

    for (const request of requests.slice(2)) {
      assert.equal(
        request.url.searchParams.get("user_email"),
        "eq.brice@example.com"
      );
      assert.equal(request.url.searchParams.get("id"), `eq.${row.id}`);
    }
  } finally {
    restoreEnvironment();
  }
});

test("an intentionally empty memory table never resurrects legacy notes", async () => {
  process.env.SUPABASE_URL = "https://example.supabase.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
  const requests = [];
  globalThis.fetch = async (rawUrl) => {
    const url = new URL(rawUrl);
    requests.push(url);
    if (url.pathname.endsWith("/profile_memories")) return responseJson([]);
    return responseJson([
      { email: "brice@example.com", prefs: { memory_notes: ["Should stay deleted"] } },
    ]);
  };

  try {
    assert.deepEqual(await getMemoryRecords("brice@example.com"), []);
    assert.equal(requests.length, 1, "a successful empty table read must not consult legacy prefs");
  } finally {
    restoreEnvironment();
  }
});

test("legacy memory fallback is limited to a known pre-migration missing-table error", async () => {
  process.env.SUPABASE_URL = "https://example.supabase.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
  let requests = 0;
  globalThis.fetch = async (rawUrl) => {
    requests += 1;
    const url = new URL(rawUrl);
    if (url.pathname.endsWith("/profile_memories")) {
      return responseJson(
        {
          code: "PGRST205",
          message: "Could not find the table 'public.profile_memories' in the schema cache",
        },
        404
      );
    }
    return responseJson([
      { email: "brice@example.com", prefs: { memory_notes: ["Legacy bridge"] } },
    ]);
  };

  try {
    assert.equal((await getMemoryRecords("brice@example.com"))[0].text, "Legacy bridge");
    assert.equal(requests, 2);

    requests = 0;
    globalThis.fetch = async () => {
      requests += 1;
      return responseJson({ code: "XX000", message: "temporary database error" }, 503);
    };
    await assert.rejects(
      getMemoryRecords("brice@example.com"),
      /temporary database error/
    );
    assert.equal(requests, 1, "unexpected table failures must fail closed");
  } finally {
    restoreEnvironment();
  }
});

test("the database memory ceiling becomes a safe public error", async () => {
  process.env.SUPABASE_URL = "https://example.supabase.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
  globalThis.fetch = async () =>
    responseJson({ code: "P0001", message: "profile_memory_limit" }, 400);

  try {
    await assert.rejects(
      createProfileMemory("brice@example.com", { text: "One memory too many" }),
      (error) => {
        assert.equal(error.code, "memory_limit_reached");
        assert.equal(error.status, 409);
        assert.match(error.message, /40/);
        return true;
      }
    );
  } finally {
    restoreEnvironment();
  }
});

test("profile memory migration backfills legacy notes and locks browser roles out", async () => {
  const migration = await readFile(
    new URL("../supabase/migration_011_profile_memories.sql", import.meta.url),
    "utf8"
  );

  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.profile_memories/i);
  assert.match(migration, /provenance[^;]+user_chat[^;]+user_ui[^;]+legacy[^;]+inferred/is);
  assert.match(migration, /jsonb_array_elements_text[^;]+memory_notes/is);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.touch_updated_at/i);
  assert.match(migration, /enforce_profile_memory_limit/i);
  assert.match(migration, /pg_advisory_xact_lock/i);
  assert.match(migration, /count\(\*\)[^;]+>=\s*40/is);
  assert.match(migration, /provenance\s*=\s*'legacy'[^;]+RETURN NULL/is);
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/i);
  assert.match(migration, /REVOKE ALL ON TABLE public\.profile_memories FROM PUBLIC, anon, authenticated/i);
  assert.match(migration, /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public\.profile_memories TO service_role/i);
});

test("chat memories retain explicit type and source message provenance", async () => {
  const chat = await readFile(new URL("../api/chat.js", import.meta.url), "utf8");

  assert.match(chat, /const userMessageRow = await appendMessage/);
  assert.match(chat, /kind:\s*action\.kind \|\| "fact"/);
  assert.match(chat, /provenance:\s*"user_chat"/);
  assert.match(chat, /sourceConversationId:\s*conversationId/);
  assert.match(chat, /sourceMessageId:\s*currentUserMessageId/);
  assert.match(
    chat,
    /deleteProfileMemory\(\s*session\.email,\s*action\.memory_id\s*\)/
  );
});
