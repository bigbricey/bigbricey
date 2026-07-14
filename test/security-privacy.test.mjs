import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

import {
  createOAuthState,
  getAuthSecret,
  oauthStateCookie,
  requireUser,
  sendJson as sendAuthJson,
  signSession,
  verifyOAuthState,
  verifySession,
} from "../api/_auth.js";
import { sendJson as sendLibJson } from "../api/_lib.js";
import {
  computeGoalsFromOnboarding,
  updateUserGoals,
} from "../api/_supabase.js";
import {
  isBootstrapAdmin,
  isBootstrapAllowed,
  redeemInvite,
} from "../api/_members.js";
import { validateFoodDaySyncRequest } from "../api/_ledger_safety.js";

function withAuthSecret(value, fn) {
  const auth = process.env.AUTH_SECRET;
  const next = process.env.NEXTAUTH_SECRET;
  if (value == null) {
    delete process.env.AUTH_SECRET;
    delete process.env.NEXTAUTH_SECRET;
  } else {
    process.env.AUTH_SECRET = value;
    delete process.env.NEXTAUTH_SECRET;
  }
  try {
    return fn();
  } finally {
    if (auth == null) delete process.env.AUTH_SECRET;
    else process.env.AUTH_SECRET = auth;
    if (next == null) delete process.env.NEXTAUTH_SECRET;
    else process.env.NEXTAUTH_SECRET = next;
  }
}

function responseRecorder() {
  const headers = new Map();
  return {
    statusCode: 0,
    body: "",
    setHeader(name, value) {
      headers.set(String(name).toLowerCase(), value);
    },
    getHeader(name) {
      return headers.get(String(name).toLowerCase());
    },
    end(body = "") {
      this.body = String(body);
    },
  };
}

function assertPrivateNoStore(res) {
  assert.equal(res.getHeader("Cache-Control"), "private, no-store, max-age=0");
  assert.equal(res.getHeader("Pragma"), "no-cache");
  assert.equal(res.getHeader("Vary"), "Cookie");
}

test("shared JSON responses are private and never cached", () => {
  const general = responseRecorder();
  sendLibJson(general, 200, { email: "person@example.com" });
  assertPrivateNoStore(general);

  const auth = responseRecorder();
  sendAuthJson(auth, 429, { error: "rate_limited" }, { "Retry-After": "30" });
  assertPrivateNoStore(auth);
  assert.equal(auth.getHeader("Retry-After"), "30");
});

test("authentication rejections use the no-store JSON response path", async () => {
  const res = responseRecorder();
  const session = await requireUser({ headers: {} }, res);
  assert.equal(session, null);
  assert.equal(res.statusCode, 401);
  assertPrivateNoStore(res);
});

test("OAuth callback JSON errors do not bypass the hardened response helper", async () => {
  const source = await readFile(
    new URL("../api/auth/callback.js", import.meta.url),
    "utf8"
  );
  assert.match(source, /\bsendJson\(res,\s*502,/);
  assert.match(source, /\bsendJson\(res,\s*500,/);
  assert.doesNotMatch(source, /res\.end\(JSON\.stringify\(/);
});

test("session signing fails closed when AUTH_SECRET is missing", () => {
  withAuthSecret(null, () => {
    assert.equal(getAuthSecret(), null);
    assert.throws(
      () => signSession({ email: "person@example.com" }),
      (error) => error?.code === "auth_secret_missing"
    );
    assert.equal(verifySession("anything.anything"), null);
  });
});

test("session signing rejects short low-entropy secrets", () => {
  withAuthSecret("too-short", () => {
    assert.equal(getAuthSecret(), null);
    assert.throws(() => signSession({ email: "person@example.com" }), /AUTH_SECRET/);
  });
});

test("OAuth state is random, cookie-bound, short-lived, and one-time clearable", () => {
  const first = createOAuthState();
  const second = createOAuthState();
  assert.notEqual(first, second);
  assert.match(first, /^[A-Za-z0-9_-]{40,}$/);

  const cookie = oauthStateCookie(first);
  assert.match(cookie, /^bigbricey_oauth_state=/);
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Lax/i);
  assert.match(cookie, /Max-Age=600/i);

  const req = {
    headers: { cookie: `other=x; bigbricey_oauth_state=${encodeURIComponent(first)}` },
  };
  assert.equal(verifyOAuthState(req, first), true);
  assert.equal(verifyOAuthState(req, second), false);
  assert.equal(verifyOAuthState({ headers: {} }, first), false);
});

test("food-day sync rejects missing rows and requires an explicit clear flag", () => {
  assert.throws(
    () => validateFoodDaySyncRequest({ date: "2026-07-14" }),
    (error) => error?.code === "rows_required" && error?.status === 400
  );
  assert.throws(
    () => validateFoodDaySyncRequest({ rows: [] }),
    (error) => error?.code === "explicit_clear_required" && error?.status === 409
  );
  assert.deepEqual(validateFoodDaySyncRequest({ rows: [], clear: true }), {
    rows: [],
    allowClear: true,
  });
  assert.deepEqual(validateFoodDaySyncRequest({ rows: [{ id: "meal-1" }] }), {
    rows: [{ id: "meal-1" }],
    allowClear: false,
  });
});

test("adult target formula rejects a minor instead of clamping them into an adult formula", () => {
  assert.throws(
    () =>
      computeGoalsFromOnboarding({
        birthday: "2012-01-01",
        sex: "female",
        height_in: 60,
        current_weight_lb: 110,
        primary_goal: "lose",
        activity_level: "moderate",
      }),
    (error) => error?.code === "adult_only" && error?.status === 422
  );
});

test("chat goal updates cannot use the old 800 kcal floor", async () => {
  const source = await readFile(new URL("../api/_supabase.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /goals\.kcal\s*=\s*Math\.max\(800,/);
  assert.match(source, /calorieFloor\(onboarding\.sex\)/);
  assert.equal(typeof updateUserGoals, "function");
});

test("saved-food and invite migrations deny browser roles and make redemption atomic", async () => {
  const saved = await readFile(
    new URL("../supabase/migration_009_security_privacy.sql", import.meta.url),
    "utf8"
  );
  assert.match(saved, /ALTER TABLE public\.saved_foods ENABLE ROW LEVEL SECURITY/i);
  assert.match(saved, /REVOKE ALL ON TABLE public\.saved_foods FROM anon, authenticated/i);
  assert.match(saved, /CREATE OR REPLACE FUNCTION public\.redeem_invite_atomic/i);
  assert.match(saved, /FOR UPDATE/i);
  assert.match(saved, /invite_redemption_attempts/i);
  assert.match(saved, /REVOKE ALL ON FUNCTION public\.redeem_invite_atomic/i);
  assert.match(saved, /GRANT EXECUTE ON FUNCTION public\.redeem_invite_atomic[^;]+TO service_role/i);
});

test("blank invite input is a client error before any database call", async () => {
  await assert.rejects(
    redeemInvite("person@example.com", ""),
    (error) => error?.code === "invite_required"
  );
});

test("browser food storage is account-scoped and quarantines unattributed legacy rows", async () => {
  const source = await readFile(
    new URL("../public/food-storage.js", import.meta.url),
    "utf8"
  );
  const sandbox = { window: {} };
  vm.runInNewContext(source, sandbox, { filename: "food-storage.js" });
  const storageApi = sandbox.window.BBFoodStorage;
  assert.ok(storageApi);

  const values = new Map([
    ["bigbricey-day-2026-07-14", JSON.stringify([{ id: "legacy-meal" }])],
  ]);
  const storage = {
    get length() {
      return values.size;
    },
    key(index) {
      return [...values.keys()][index] ?? null;
    },
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(String(key), String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
  };

  storageApi.quarantineLegacyDays(storage);
  assert.equal(storage.getItem("bigbricey-day-2026-07-14"), null);
  assert.ok(storage.getItem("bigbricey-unassigned-day-2026-07-14"));

  storageApi.save(storage, "alice@example.com", "2026-07-14", [{ id: "alice" }]);
  storageApi.save(storage, "bob@example.com", "2026-07-14", [{ id: "bob" }]);
  assert.deepEqual(
    JSON.parse(JSON.stringify(storageApi.load(storage, "alice@example.com", "2026-07-14"))),
    [{ id: "alice" }]
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(storageApi.load(storage, "bob@example.com", "2026-07-14"))),
    [{ id: "bob" }]
  );

  const liveRows = [{ id: "meal-before-day-switch" }];
  const pending = storageApi.createDaySyncSnapshot("2026-07-14", liveRows, true);
  liveRows[0].id = "mutated-after-scheduling";
  assert.deepEqual(JSON.parse(JSON.stringify(pending)), {
    day: "2026-07-14",
    rows: [{ id: "meal-before-day-switch" }],
    allowClear: true,
  });
});

test("membership allowlist does not silently grant administrator powers", () => {
  const oldAllowlist = process.env.AUTH_ALLOWLIST;
  const oldAdmins = process.env.AUTH_ADMIN_EMAILS;
  try {
    process.env.AUTH_ALLOWLIST = "member@example.com";
    process.env.AUTH_ADMIN_EMAILS = "admin@example.com";
    assert.equal(isBootstrapAllowed("member@example.com"), true);
    assert.equal(isBootstrapAdmin("member@example.com"), false);
    assert.equal(isBootstrapAllowed("admin@example.com"), true);
    assert.equal(isBootstrapAdmin("admin@example.com"), true);
  } finally {
    if (oldAllowlist == null) delete process.env.AUTH_ALLOWLIST;
    else process.env.AUTH_ALLOWLIST = oldAllowlist;
    if (oldAdmins == null) delete process.env.AUTH_ADMIN_EMAILS;
    else process.env.AUTH_ADMIN_EMAILS = oldAdmins;
  }
});

test("chat bounds user-controlled message and fallback ledger sizes", async () => {
  const source = await readFile(new URL("../api/chat.js", import.meta.url), "utf8");
  assert.match(source, /body\.rows\.length > 500/);
  assert.match(source, /text\.length > 8_000/);
  assert.match(source, /status|413/);
});
