import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("paid chat work is reserved atomically before model calls", async () => {
  const migration = await readFile(
    new URL("../supabase/migration_010_atomic_food_sync.sql", import.meta.url),
    "utf8"
  );
  const supabase = await readFile(new URL("../api/_supabase.js", import.meta.url), "utf8");
  const chat = await readFile(new URL("../api/chat.js", import.meta.url), "utf8");

  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.llm_quota_state/i);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.reserve_llm_turn/i);
  assert.match(migration, /llm_minute_limit_reached/i);
  assert.match(migration, /llm_daily_limit_reached/i);
  assert.match(supabase, /export async function reserveLlmTurn/);
  assert.match(chat, /await reserveLlmTurn\(session\.email\)/);
  assert.ok(
    chat.indexOf("await reserveLlmTurn(session.email)") <
      chat.indexOf("let intent = await interpretIntent"),
    "quota reservation must happen before the first provider call"
  );
});
