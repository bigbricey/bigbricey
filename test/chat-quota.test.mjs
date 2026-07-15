import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("paid chat work is reserved atomically before model calls", async () => {
  const migration = await readFile(
    new URL("../supabase/migration_010_atomic_food_sync.sql", import.meta.url),
    "utf8"
  );
  const incrementalMigration = await readFile(
    new URL("../supabase/migration_012_incremental_llm_quota.sql", import.meta.url),
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

  assert.match(
    incrementalMigration,
    /CREATE OR REPLACE FUNCTION public\.reserve_llm_tokens/i
  );
  const incrementalStart = incrementalMigration.indexOf(
    "CREATE OR REPLACE FUNCTION public.reserve_llm_tokens"
  );
  const incrementalEnd = incrementalMigration.indexOf(
    "REVOKE ALL ON FUNCTION public.reserve_llm_tokens",
    incrementalStart
  );
  const incrementalBlock = incrementalMigration.slice(
    incrementalStart,
    incrementalEnd
  );
  assert.match(incrementalBlock, /day_reserved_tokens\s*=\s*v_state\.day_reserved_tokens\s*\+\s*p_reserved_tokens/i);
  assert.doesNotMatch(
    incrementalBlock,
    /day_requests\s*=\s*v_state\.day_requests\s*\+\s*1/i
  );
  assert.doesNotMatch(
    incrementalBlock,
    /minute_requests\s*=\s*v_state\.minute_requests\s*\+\s*1/i
  );
  assert.match(supabase, /export async function reserveAdditionalLlmTokens/);

  const planningStart = chat.indexOf("const planningTurn = await callBuddyAfterTools");
  const planningReserve = chat.lastIndexOf(
    "await reserveAdditionalLlmTokens(session.email)",
    planningStart
  );
  assert.ok(
    planningReserve > chat.indexOf("const continuationPlan") &&
      planningReserve < planningStart,
    "the second provider pass must reserve tokens immediately before it runs"
  );

  const voiceStart = chat.indexOf("const voiceTurn = await callBuddyAfterTools");
  const voiceReserve = chat.lastIndexOf(
    "await reserveAdditionalLlmTokens(session.email)",
    voiceStart
  );
  assert.ok(
    voiceReserve > planningStart && voiceReserve < voiceStart,
    "the third provider pass must reserve its own tokens before it runs"
  );
});
