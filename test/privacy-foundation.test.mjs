import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { sanitizeProductEventMetadata } from "../api/events.js";

test("first-party product metrics reject message, food, and health content", () => {
  assert.deepEqual(
    sanitizeProductEventMetadata({
      outcome: "success",
      source: "chat",
      message: "I ate brisket",
      food: "brisket",
      weight: 215,
      email: "person@example.test",
    }),
    { outcome: "success", source: "chat" }
  );
});

test("stable record services are authenticated, read-only, aggregated, and account scoped", async () => {
  const records = await readFile(new URL("../api/_records_endpoint.js", import.meta.url), "utf8");
  assert.match(records, /if \(req\.method !== "GET"\)/);
  assert.match(records, /error: "read_only_service"/);
  assert.match(records, /accountIdForEmail\(user\.email\)/);
  assert.match(records, /getHealthSnapshot\(accountId, id\)/);
  assert.match(records, /getProfileByAccountId\(accountId\)/);
  assert.match(records, /p_account_id: accountId/);
  assert.match(records, /aggregated: true/);
  assert.doesNotMatch(records, /method:\s*"(?:POST|PATCH|DELETE)"/);
});

test("profile preference writes bind to random account id instead of a client owner id", async () => {
  const helper = await readFile(new URL("../api/_supabase.js", import.meta.url), "utf8");
  const sql = await readFile(
    new URL("../supabase/migration_013_account_foundation.sql", import.meta.url),
    "utf8"
  );
  const mergeBlock = helper.slice(
    helper.indexOf("export async function mergeProfilePrefs"),
    helper.indexOf("export async function getCompanionSettings")
  );
  assert.match(mergeBlock, /accountIdForEmail\(e\)/);
  assert.match(mergeBlock, /merge_profile_prefs_by_account/);
  assert.match(sql, /WHERE account_id = p_account_id/);
  assert.match(
    sql,
    /REVOKE ALL ON FUNCTION public\.merge_profile_prefs_by_account\(UUID, JSONB\)[\s\S]*?FROM PUBLIC, anon, authenticated/
  );
});

test("snapshots, corrections, feedback, and request cancellation cannot broaden account scope", async () => {
  const snapshot = await readFile(
    new URL("../api/_health_snapshot.js", import.meta.url),
    "utf8"
  );
  const feedback = await readFile(new URL("../api/_feedback_endpoint.js", import.meta.url), "utf8");
  const rights = await readFile(new URL("../api/_data_rights_endpoint.js", import.meta.url), "utf8");
  assert.match(snapshot, /id: `eq\.\$\{snapshot\}`,[\s\S]*?account_id: `eq\.\$\{id\}`/);
  assert.match(snapshot, /account_id: `eq\.\$\{normalizeAccountId\(accountId\)\}`/);
  assert.match(feedback, /conversation_id: `eq\.\$\{selected\.conversation_id\}`,[\s\S]*?account_id: `eq\.\$\{accountId\}`/);
  assert.match(rights, /id: `eq\.\$\{requestId\}`,[\s\S]*?account_id: `eq\.\$\{accountId\}`/);
  assert.match(rights, /refreshAccountRequestStatus\(accountId\)/);
});

test("mutation audit, rate limits, and browser-role denial are migration-enforced", async () => {
  const sql = await readFile(
    new URL("../supabase/migration_013_account_foundation.sql", import.meta.url),
    "utf8"
  );
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.audit_account_mutation/);
  assert.match(sql, /AFTER INSERT OR UPDATE OR DELETE/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.consume_account_rate_limit/);
  assert.match(sql, /pg_advisory_xact_lock/);
  assert.match(sql, /ALTER TABLE public\.%I ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /REVOKE ALL ON TABLE public\.%I FROM PUBLIC, anon, authenticated/);
});

test("export and deletion are explicit requests; deletion never runs automatically", async () => {
  const route = await readFile(new URL("../api/_data_rights_endpoint.js", import.meta.url), "utf8");
  const ui = await readFile(new URL("../public/app.html", import.meta.url), "utf8");
  assert.match(route, /REQUEST DELETE MY ACCOUNT/);
  assert.match(route, /automatic_deletion: false/);
  assert.doesNotMatch(route, /method:\s*"DELETE"/);
  assert.match(ui, /It does not instantly erase your data/);
});

test("Google sign-in requests only the minimum identity and ignores profile decoration", async () => {
  const google = await readFile(new URL("../api/auth/google.js", import.meta.url), "utf8");
  const callback = await readFile(
    new URL("../api/auth/callback.js", import.meta.url),
    "utf8"
  );
  const profiles = await readFile(new URL("../api/_supabase.js", import.meta.url), "utf8");
  const ensureProfileBlock = profiles.slice(
    profiles.indexOf("export async function ensureProfile"),
    profiles.indexOf("export async function getProfile")
  );

  assert.match(google, /scope: "openid email"/);
  assert.doesNotMatch(google, /openid email profile/);
  assert.doesNotMatch(callback, /profile\.(?:name|picture)/);
  assert.match(callback, /signSession\(\{\s*email,\s*sub: profile\.sub \|\| null/);
  assert.match(ensureProfileBlock, /body: \{ email: e \}/);
  assert.doesNotMatch(ensureProfileBlock, /\b(?:name|picture)\s*:/);
});

test("public pages load no advertising analytics, trackers, or external fonts", async () => {
  const pageNames = [
    "app.html",
    "index.html",
    "join.html",
    "onboarding.html",
    "privacy.html",
    "terms.html",
  ];
  const pages = await Promise.all(
    pageNames.map((name) => readFile(new URL(`../public/${name}`, import.meta.url), "utf8"))
  );
  const config = await readFile(new URL("../vercel.json", import.meta.url), "utf8");
  const combined = pages.join("\n");

  assert.doesNotMatch(combined, /fonts\.(?:googleapis|gstatic)\.com/i);
  assert.doesNotMatch(
    combined,
    /(?:googletagmanager|google-analytics|segment\.com|mixpanel|posthog|amplitude|facebook\.net)/i
  );
  assert.match(config, /default-src 'self'/);
  assert.match(config, /connect-src 'self'/);
  assert.match(config, /frame-ancestors 'none'/);
});
