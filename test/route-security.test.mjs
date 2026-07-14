import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  requirePrivateJsonMutation,
  requireUser,
  signSession,
} from "../api/_auth.js";
import { getMembership, isMember } from "../api/_members.js";
import authMeHandler from "../api/auth/me.js";

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
      this.ended = true;
      return this;
    },
  };
}

function mutationRequest(overrides = {}) {
  return {
    method: "POST",
    headers: {
      host: "bigbricey.com",
      "x-forwarded-proto": "https",
      origin: "https://bigbricey.com",
      "content-type": "application/json; charset=utf-8",
      ...(overrides.headers || {}),
    },
    ...overrides,
  };
}

function preserveEnv(names) {
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  return () => {
    for (const [name, value] of Object.entries(saved)) {
      if (value == null) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

test("private mutations require same-origin application/json", () => {
  const allowed = responseRecorder();
  assert.equal(requirePrivateJsonMutation(mutationRequest(), allowed), true);
  assert.equal(allowed.statusCode, 0);

  const crossOrigin = responseRecorder();
  assert.equal(
    requirePrivateJsonMutation(
      mutationRequest({
        headers: {
          host: "bigbricey.com",
          "x-forwarded-proto": "https",
          origin: "https://attacker.bigbricey.com",
          "content-type": "application/json",
        },
      }),
      crossOrigin
    ),
    false
  );
  assert.equal(crossOrigin.statusCode, 403);
  assert.equal(JSON.parse(crossOrigin.body).error, "cross_origin_request");

  const missingOrigin = responseRecorder();
  assert.equal(
    requirePrivateJsonMutation(
      mutationRequest({
        headers: {
          host: "bigbricey.com",
          "x-forwarded-proto": "https",
          "content-type": "application/json",
        },
      }),
      missingOrigin
    ),
    false
  );
  assert.equal(missingOrigin.statusCode, 403);

  const simpleRequest = responseRecorder();
  assert.equal(
    requirePrivateJsonMutation(
      mutationRequest({
        headers: {
          host: "bigbricey.com",
          "x-forwarded-proto": "https",
          origin: "https://bigbricey.com",
          "content-type": "text/plain",
        },
      }),
      simpleRequest
    ),
    false
  );
  assert.equal(simpleRequest.statusCode, 415);
  assert.equal(JSON.parse(simpleRequest.body).error, "json_required");
});

test("member-only route guard applies before a private POST is authorized", async () => {
  const restore = preserveEnv([
    "AUTH_SECRET",
    "NEXTAUTH_SECRET",
    "AUTH_ALLOWLIST",
    "AUTH_ADMIN_EMAILS",
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "SUPABASE_SERVICE_KEY",
  ]);
  try {
    process.env.AUTH_SECRET = "route-security-test-secret-value-123456789";
    delete process.env.NEXTAUTH_SECRET;
    process.env.AUTH_ALLOWLIST = "member@example.com";
    process.env.AUTH_ADMIN_EMAILS = "admin@example.com";
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.SUPABASE_SERVICE_KEY;
    const token = signSession({ email: "member@example.com" });

    const req = mutationRequest({
      headers: {
        host: "bigbricey.com",
        "x-forwarded-proto": "https",
        origin: "https://bigbricey.com",
        "content-type": "text/plain",
        cookie: `bigbricey_session=${encodeURIComponent(token)}`,
      },
    });
    const res = responseRecorder();
    const session = await requireUser(req, res);
    assert.equal(session, null);
    assert.equal(res.statusCode, 415);
  } finally {
    restore();
  }
});

test("membership fails closed when neither the database nor bootstrap list can verify it", async () => {
  const restore = preserveEnv([
    "AUTH_ALLOWLIST",
    "AUTH_ADMIN_EMAILS",
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "SUPABASE_SERVICE_KEY",
  ]);
  try {
    process.env.AUTH_ALLOWLIST = ",";
    process.env.AUTH_ADMIN_EMAILS = ",";
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.SUPABASE_SERVICE_KEY;
    assert.equal(await isMember("stranger@example.com"), false);
    assert.deepEqual(await getMembership("stranger@example.com"), {
      member: false,
      admin: false,
      role: null,
    });
  } finally {
    restore();
  }
});

test("auth preference POST rechecks current membership before any write", async () => {
  const restore = preserveEnv([
    "AUTH_SECRET",
    "NEXTAUTH_SECRET",
    "AUTH_ALLOWLIST",
    "AUTH_ADMIN_EMAILS",
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "SUPABASE_SERVICE_KEY",
  ]);
  try {
    process.env.AUTH_SECRET = "route-security-test-secret-value-123456789";
    delete process.env.NEXTAUTH_SECRET;
    process.env.AUTH_ALLOWLIST = ",";
    process.env.AUTH_ADMIN_EMAILS = ",";
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.SUPABASE_SERVICE_KEY;
    const token = signSession({ email: "removed-member@example.com" });
    const req = mutationRequest({
      body: { theme: { preset: "pink" } },
      headers: {
        host: "bigbricey.com",
        "x-forwarded-proto": "https",
        origin: "https://bigbricey.com",
        "content-type": "application/json",
        cookie: `bigbricey_session=${encodeURIComponent(token)}`,
      },
    });
    const res = responseRecorder();
    await authMeHandler(req, res);
    assert.equal(res.statusCode, 403);
    assert.equal(JSON.parse(res.body).error, "not_invited");
  } finally {
    restore();
  }
});

test("private response and preflight paths no longer advertise wildcard CORS", async () => {
  const [lib, log, redeem] = await Promise.all([
    readFile(new URL("../api/_lib.js", import.meta.url), "utf8"),
    readFile(new URL("../api/log.js", import.meta.url), "utf8"),
    readFile(new URL("../api/auth/redeem.js", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(lib, /Access-Control-Allow-Origin/);
  assert.doesNotMatch(log, /Access-Control-Allow-Origin/);
  assert.doesNotMatch(redeem, /Access-Control-Allow-Origin/);
});
