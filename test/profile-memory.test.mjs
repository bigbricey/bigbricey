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

test("profile memory migration backfills legacy notes and locks browser roles out", async () => {
  const migration = await readFile(
    new URL("../supabase/migration_011_profile_memories.sql", import.meta.url),
    "utf8"
  );

  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.profile_memories/i);
  assert.match(migration, /provenance[^;]+user_chat[^;]+user_ui[^;]+legacy[^;]+inferred/is);
  assert.match(migration, /jsonb_array_elements_text[^;]+memory_notes/is);
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/i);
  assert.match(migration, /REVOKE ALL ON TABLE public\.profile_memories FROM PUBLIC, anon, authenticated/i);
  assert.match(migration, /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public\.profile_memories TO service_role/i);
});
