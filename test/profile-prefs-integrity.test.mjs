import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("profile preferences stay locked while permanent memory uses account-scoped records", async () => {
  const prefsMigration = await readFile(
    new URL("../supabase/migration_010_atomic_food_sync.sql", import.meta.url),
    "utf8"
  );
  const memoryMigration = await readFile(
    new URL("../supabase/migration_011_profile_memories.sql", import.meta.url),
    "utf8"
  );
  const accountMigration = await readFile(
    new URL("../supabase/migration_013_account_foundation.sql", import.meta.url),
    "utf8"
  );
  const supabase = await readFile(new URL("../api/_supabase.js", import.meta.url), "utf8");
  const chat = await readFile(new URL("../api/chat.js", import.meta.url), "utf8");

  assert.match(prefsMigration, /CREATE OR REPLACE FUNCTION public\.merge_profile_prefs/i);
  assert.match(prefsMigration, /FOR UPDATE/i);
  assert.match(memoryMigration, /CREATE TABLE IF NOT EXISTS public\.profile_memories/i);
  assert.match(memoryMigration, /ENABLE ROW LEVEL SECURITY/i);
  assert.match(memoryMigration, /GRANT SELECT, INSERT, UPDATE, DELETE[^;]+service_role/is);
  assert.match(supabase, /sbRpc\("merge_profile_prefs_by_account"/);
  assert.match(accountMigration, /CREATE OR REPLACE FUNCTION public\.merge_profile_prefs_by_account/i);
  assert.match(accountMigration, /RETURN public\.merge_profile_prefs\(v_email, p_patch\)/i);
  assert.match(accountMigration, /WHERE account_id = p_account_id/i);
  assert.match(supabase, /sb\("profile_memories"/);
  assert.match(supabase, /query:\s*\{\s*id:\s*`eq\.\$\{id\}`,\s*user_email:\s*`eq\.\$\{e\}`/);
  assert.doesNotMatch(supabase, /sbRpc\("mutate_memory_note"/);
  assert.doesNotMatch(supabase, /body:\s*\{\s*prefs[,}]/);
  assert.doesNotMatch(chat, /body:\s*\{\s*prefs[,}]/);
});

test("forget memory refuses an ambiguous text match instead of deleting several records", async () => {
  const supabase = await readFile(new URL("../api/_supabase.js", import.meta.url), "utf8");
  assert.match(supabase, /selectUniqueMemoryMatch/);
  assert.match(supabase, /ambiguous:\s*selection\.status === "ambiguous"/);
  assert.match(supabase, /removed_count:\s*0/);
});
