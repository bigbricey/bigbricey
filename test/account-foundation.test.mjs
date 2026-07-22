import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

import { normalizeAccountId } from "../api/_supabase.js";

test("internal account ids are strict random UUID-shaped identifiers, never emails", () => {
  assert.equal(
    normalizeAccountId("0f8fad5b-d9cb-469f-a165-70867728950e"),
    "0f8fad5b-d9cb-469f-a165-70867728950e"
  );
  assert.equal(normalizeAccountId("person@example.com"), null);
  assert.equal(normalizeAccountId("legacy:person@example.com"), null);
});

test("account migration is additive, backfills owners, and locks privacy tables from browser roles", async () => {
  const sql = await readFile(
    new URL("../supabase/migration_013_account_foundation.sql", import.meta.url),
    "utf8"
  );
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.accounts/i);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS account_id UUID/i);
  assert.match(sql, /UPDATE public\.%I AS owned SET account_id = p\.account_id/i);
  assert.match(sql, /assign_account_id_from_profile/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.auth_identities/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.health_snapshots/i);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.read_health_range_summary/i);
  assert.match(sql, /REVOKE ALL ON TABLE public\.%I FROM PUBLIC, anon, authenticated/i);
  assert.doesNotMatch(sql, /DROP TABLE|TRUNCATE TABLE|DELETE FROM public\.(?:events|day_totals|profiles)/i);
});

test("app-scoped browser storage prefers the random account id", async () => {
  for (const file of ["app.js", "boxes.js", "layout.js", "theme.js", "scenes.js", "companion.js"]) {
    const source = await readFile(new URL(`../public/${file}`, import.meta.url), "utf8");
    assert.match(source, /account_id/);
  }
});

test("existing signed-in browser state migrates from email keys without overwriting account-id state", async () => {
  const source = await readFile(
    new URL("../public/account-storage.js", import.meta.url),
    "utf8"
  );
  const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const values = new Map([
    ["bigbricey-layout-v2-person%40example.test", "old-layout"],
    ["bigbricey-theme-v2-person%40example.test", "old-theme"],
    [
      "bigbricey-theme-v2-0f8fad5b-d9cb-469f-a165-70867728950e",
      "new-theme",
    ],
  ]);
  const fakeStorage = {
    get length() {
      return values.size;
    },
    key(index) {
      return Array.from(values.keys())[index] ?? null;
    },
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
  };
  const context = {};
  context.window = context;
  vm.runInNewContext(source, context);
  const moved = context.BBAccountStorage.migrateScopedKeys(
    fakeStorage,
    "person@example.test",
    "0f8fad5b-d9cb-469f-a165-70867728950e",
    ["bigbricey-layout-v2-", "bigbricey-theme-v2-"]
  );

  assert.equal(moved, 2);
  assert.equal(values.has("bigbricey-layout-v2-person%40example.test"), false);
  assert.equal(
    values.get("bigbricey-layout-v2-0f8fad5b-d9cb-469f-a165-70867728950e"),
    "old-layout"
  );
  assert.equal(
    values.get("bigbricey-theme-v2-0f8fad5b-d9cb-469f-a165-70867728950e"),
    "new-theme"
  );
  assert.match(app, /migrateSignedInBrowserState\(window\.__ntUser\)/);
  assert.match(app, /user\.email,\s*user\.account_id/);
});
