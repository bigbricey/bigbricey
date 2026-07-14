import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("profile preferences use locked merge and atomic memory RPCs", async () => {
  const migration = await readFile(
    new URL("../supabase/migration_010_atomic_food_sync.sql", import.meta.url),
    "utf8"
  );
  const supabase = await readFile(new URL("../api/_supabase.js", import.meta.url), "utf8");
  const chat = await readFile(new URL("../api/chat.js", import.meta.url), "utf8");

  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.merge_profile_prefs/i);
  assert.match(migration, /FOR UPDATE/i);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.mutate_memory_note/i);
  assert.match(migration, /removed_count/i);
  assert.match(migration, /GRANT EXECUTE[^;]+service_role/is);
  assert.match(supabase, /sbRpc\("merge_profile_prefs"/);
  assert.match(supabase, /sbRpc\("mutate_memory_note"/);
  assert.doesNotMatch(supabase, /body:\s*\{\s*prefs[,}]/);
  assert.doesNotMatch(chat, /body:\s*\{\s*prefs[,}]/);
});

test("forget memory exposes exact no-op state instead of unconditional success", async () => {
  const supabase = await readFile(new URL("../api/_supabase.js", import.meta.url), "utf8");
  assert.match(supabase, /removed_count:\s*Math\.max/);
});
