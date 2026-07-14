import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("food-day replacement is one locked transactional RPC", async () => {
  const migration = await readFile(
    new URL("../supabase/migration_010_atomic_food_sync.sql", import.meta.url),
    "utf8"
  );
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.sync_food_day_atomic/i);
  assert.match(migration, /SECURITY DEFINER/i);
  assert.match(migration, /pg_advisory_xact_lock/i);
  assert.match(migration, /jsonb_array_length\(p_rows\)/i);
  assert.match(migration, /p_allow_clear/i);
  assert.match(migration, /p_expected_revision/i);
  assert.match(migration, /stale_food_day_revision/i);
  assert.match(migration, /food_day_revisions/i);
  assert.match(migration, /SELECT\s+em\.user_email,\s*em\.day_key,\s*em\.measure_id/i);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.sync_food_day_atomic/i);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.sync_food_day_atomic[^;]+service_role/i);
});

test("server sync delegates the whole replacement to the atomic RPC", async () => {
  const source = await readFile(new URL("../api/_supabase.js", import.meta.url), "utf8");
  const start = source.indexOf("export async function syncFoodDay");
  const end = source.indexOf("export async function loadFoodDay", start);
  const implementation = source.slice(start, end);

  assert.match(implementation, /sbRpc\("sync_food_day_atomic"/);
  assert.match(implementation, /p_expected_revision:\s*Number\(expectedRevision\)/);
  assert.doesNotMatch(implementation, /method:\s*"DELETE"/);
  assert.doesNotMatch(implementation, /deleted_at:\s*new Date/);
});

test("food-day reads expose a revision and API writes require that precondition", async () => {
  const supabase = await readFile(new URL("../api/_supabase.js", import.meta.url), "utf8");
  const logApi = await readFile(new URL("../api/log.js", import.meta.url), "utf8");
  const migration = await readFile(
    new URL("../supabase/migration_010_atomic_food_sync.sql", import.meta.url),
    "utf8"
  );

  assert.match(supabase, /export async function loadFoodDaySnapshot/);
  const snapshotStart = supabase.indexOf("export async function loadFoodDaySnapshot");
  const snapshotEnd = supabase.indexOf("/**", snapshotStart);
  const snapshotBlock = supabase.slice(snapshotStart, snapshotEnd);
  assert.match(snapshotBlock, /sbRpc\("load_food_day_snapshot"/);
  assert.doesNotMatch(snapshotBlock, /Promise\.all|food_day_revisions/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.load_food_day_snapshot/i);
  assert.match(migration, /pg_advisory_xact_lock/i);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.load_food_day_snapshot[^;]+service_role/is);
  assert.match(logApi, /expected_revision/);
  assert.match(logApi, /revision/);
  assert.match(supabase, /stale_food_day_revision/);
});

test("migration backfills totals for existing ledger days", async () => {
  const migration = await readFile(
    new URL("../supabase/migration_010_atomic_food_sync.sql", import.meta.url),
    "utf8"
  );
  assert.match(
    migration,
    /SELECT DISTINCT[\s\S]{0,300}user_email[\s\S]{0,300}day_key[\s\S]{0,500}recompute_day_totals/i
  );
});

test("ordinary chat does not resync an unchanged food day from the browser", async () => {
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const rowsCheck = source.indexOf("Array.isArray(data.rows)");
  const start = source.lastIndexOf("if (", rowsCheck);
  const end = source.indexOf("// Chat can change daily targets", start);
  const responseBlock = source.slice(start, end);

  assert.ok(start >= 0 && end > start, "chat response block should exist");
  assert.match(responseBlock, /data\.ledger_committed === true/);
  assert.match(responseBlock, /saveLocalRows\(requestDay, committedRows, requestAccount\)/);
  assert.doesNotMatch(responseBlock, /\bsave\s*\(/);
  assert.doesNotMatch(responseBlock, /scheduleSync\s*\(/);
  assert.doesNotMatch(responseBlock, /syncCloud\s*\(/);
});
